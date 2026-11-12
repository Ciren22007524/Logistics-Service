import type { CvsStore, ShipmentRow } from '../../domain/shipment/types.js';
import { formatTaipei, parseTaipeiTime } from '../../lib/time.js';
import type {
  CarrierAccount,
  CarrierAdapter,
  CarrierTrackingEvent,
  CreateShipmentInput,
  CreateShipmentResult,
  LabelFile,
  ParsedCallback,
  RawCallback,
  StoreMapParams,
  StoreMapRequest,
} from '../carrier.interface.js';
import { AuthError, RetryableError, UnknownError, ValidationError, errorForHttpStatus, toCarrierError } from '../errors.js';
import { checkMacValue, verifyCheckMacValue } from './check-mac.js';
import { mapEcpayStatus } from './status-map.js';

const STAGE = 'https://logistics-stage.ecpay.com.tw';
const PROD = 'https://logistics.ecpay.com.tw';

const B2C_TYPES = ['FAMI', 'UNIMART', 'UNIMARTFREEZE', 'HILIFE', 'OKMART'];
const C2C_TYPES = ['FAMIC2C', 'UNIMARTC2C', 'HILIFEC2C', 'OKMARTC2C'];

/** 列印端點依子類型不同（C2C）；B2C 共用 printTradeDocument */
const C2C_PRINT: Record<string, { path: string; needValidationNo: boolean }> = {
  UNIMARTC2C: { path: '/Express/PrintUniMartC2COrderInfo', needValidationNo: true },
  FAMIC2C: { path: '/Express/PrintFAMIC2COrderInfo', needValidationNo: false },
  HILIFEC2C: { path: '/Express/PrintHILIFEC2COrderInfo', needValidationNo: false },
  OKMARTC2C: { path: '/Express/PrintOKMARTC2COrderInfo', needValidationNo: false },
};

/** 綠界 GoodsName 不允許的字元 */
const FORBIDDEN_GOODS_CHARS = /[\^'`!@#%&*+\\"<>|_[\]]/g;

interface EcpayCredentials {
  merchantId: string;
  hashKey: string;
  hashIv: string;
  /** 'C2C'（店到店）或 'B2C'（大宗寄倉） */
  mode: 'C2C' | 'B2C';
  platformId?: string;
}

function creds(account: CarrierAccount): EcpayCredentials {
  const c = account.credentials;
  if (!c.merchantId || !c.hashKey || !c.hashIv) throw new AuthError('ECPay 帳號缺少 merchantId / hashKey / hashIv');
  return {
    merchantId: c.merchantId,
    hashKey: c.hashKey,
    hashIv: c.hashIv,
    mode: c.mode === 'B2C' ? 'B2C' : 'C2C',
    platformId: c.platformId,
  };
}

const baseUrl = (account: CarrierAccount) => (account.is_sandbox ? STAGE : PROD);

/** shipment.id → 綠界 MerchantTradeNo（≤20 碼英數）。同一筆固定，讓綠界擋重複建單（規格 9.1） */
export function merchantTradeNo(shipmentId: string): string {
  return `LS${shipmentId.replace(/-/g, '').slice(0, 18).toUpperCase()}`;
}

const parseForm = (s: string): Record<string, string> => Object.fromEntries(new URLSearchParams(s));

export class EcpayCvsAdapter implements CarrierAdapter {
  readonly code = 'ECPAY_CVS' as const;
  readonly displayName = '綠界物流（超商取貨）';
  readonly capabilities = {
    homeDelivery: false,
    cvsPickup: true,
    cod: true,
    temperatures: ['NORMAL' as const, 'FROZEN' as const],
    cancel: true,
    trackingCallback: true,
    trackingPolling: true,
    storeMap: true,
  };
  readonly limits = {
    itemsSummaryMaxLength: 50,
    codMaxAmount: 20000,
    declaredValueMax: 20000,
    recipientNameMaxLength: 10,
    cvsSubTypes: [...C2C_TYPES, ...B2C_TYPES],
  };

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async post(account: CarrierAccount, path: string, params: Record<string, string>): Promise<string> {
    const { hashKey, hashIv } = creds(account);
    const body = new URLSearchParams({ ...params, CheckMacValue: checkMacValue(params, hashKey, hashIv) });
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl(account)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw toCarrierError(err);
    }
    const text = await res.text();
    if (!res.ok) throw errorForHttpStatus(res.status, text);
    return text;
  }

  validate(input: CreateShipmentInput): Record<string, string> {
    const errors: Record<string, string> = {};
    const name = input.recipient.name ?? '';
    // 綠界：中文 2~5 字、英文 4~10 字（以 UTF-8 字數簡化檢查）
    const isCjk = /[\u4e00-\u9fff]/.test(name);
    if (isCjk ? name.length < 2 || name.length > 5 : name.length < 4 || name.length > 10)
      errors['recipient.name'] = '綠界收件人姓名需為中文 2~5 字或英文 4~10 字';
    if (/[0-9!@#$%^&*()_+=[\]{};:'"\\|,.<>/?]/.test(name)) errors['recipient.name'] = '收件人姓名不可含數字或特殊符號';
    if (!/^09\d{8}$/.test(input.recipient.phone)) errors['recipient.phone'] = '超商取貨需提供 09 開頭 10 碼手機';
    if (!input.cvsStore) errors.cvs_store = '超商取貨必須指定門市';
    else if (!this.limits.cvsSubTypes.includes(input.cvsStore.sub_type))
      errors['cvs_store.sub_type'] = `不支援的超商類型 ${input.cvsStore.sub_type}`;
    if (input.temperature === 'FROZEN' && input.cvsStore?.sub_type !== 'UNIMARTFREEZE')
      errors.temperature = '冷凍僅支援 7-11 冷凍店取（UNIMARTFREEZE）';
    if (input.temperature === 'CHILLED') errors.temperature = '綠界超商不支援冷藏';
    const amount = input.declaredValue ?? input.codAmount ?? 0;
    if (amount < 1 || amount > 20000) errors.declared_value = '綠界商品金額需介於 1~20000';
    return errors;
  }

  async createShipment(input: CreateShipmentInput, account: CarrierAccount): Promise<CreateShipmentResult> {
    const c = creds(account);
    const store = input.cvsStore;
    if (!store) throw new ValidationError('超商取貨必須指定門市', { cvs_store: 'required' });
    const subType = store.sub_type;
    if (c.mode === 'C2C' ? !C2C_TYPES.includes(subType) : !B2C_TYPES.includes(subType))
      throw new ValidationError(`帳號模式 ${c.mode} 不支援 ${subType}`, { 'cvs_store.sub_type': 'mismatch' });

    const tradeNo = merchantTradeNo(input.shipmentId);
    const goodsAmount = String(input.declaredValue ?? input.codAmount ?? 1);
    const params: Record<string, string> = {
      MerchantID: c.merchantId,
      MerchantTradeNo: tradeNo,
      MerchantTradeDate: formatTaipei(new Date()),
      LogisticsType: 'CVS',
      LogisticsSubType: subType,
      GoodsAmount: goodsAmount,
      IsCollection: input.codAmount ? 'Y' : 'N',
      GoodsName: input.itemsSummary.replace(FORBIDDEN_GOODS_CHARS, '').slice(0, 50),
      SenderName: input.sender.name,
      SenderCellPhone: input.sender.phone,
      ReceiverName: input.recipient.name,
      ReceiverCellPhone: input.recipient.phone,
      ReceiverStoreID: store.store_id,
      ServerReplyURL: input.callbackUrl,
    };
    if (input.codAmount) params.CollectionAmount = String(input.codAmount);
    if (input.recipient.email) params.ReceiverEmail = input.recipient.email;
    if (c.mode === 'C2C') params.LogisticsC2CReplyURL = input.callbackUrl;
    if (c.platformId) params.PlatformID = c.platformId;

    const text = await this.post(account, '/Express/Create', params);
    return parseCreateResponse(text, tradeNo);
  }

  async getLabel(shipment: ShipmentRow, account: CarrierAccount): Promise<LabelFile> {
    const c = creds(account);
    if (!shipment.carrier_shipment_id) throw new ValidationError('尚未取得綠界物流交易編號');
    const sub = shipment.cvs_store?.sub_type ?? '';
    const params: Record<string, string> = {
      MerchantID: c.merchantId,
      AllPayLogisticsID: shipment.carrier_shipment_id,
    };
    let path = '/helper/printTradeDocument';
    const print = C2C_PRINT[sub];
    if (print) {
      path = print.path;
      const payload = (shipment.carrier_payload ?? {}) as Record<string, string>;
      if (!payload.CVSPaymentNo) throw new ValidationError('缺少寄貨編號 CVSPaymentNo');
      params.CVSPaymentNo = payload.CVSPaymentNo;
      if (print.needValidationNo) params.CVSValidationNo = payload.CVSValidationNo ?? '';
    }
    if (c.platformId) params.PlatformID = c.platformId;
    const html = await this.post(account, path, params);
    if (/^0\|/.test(html.trim())) throw new ValidationError(`綠界列印失敗：${html.trim().slice(2)}`);
    // 綠界標籤是 HTML 頁面（需瀏覽器列印），不是 PDF
    return { content: new TextEncoder().encode(html), contentType: 'text/html; charset=utf-8', extension: 'html' };
  }

  async cancelShipment(shipment: ShipmentRow, account: CarrierAccount): Promise<void> {
    const c = creds(account);
    if (shipment.cvs_store?.sub_type !== 'UNIMARTC2C')
      throw new ValidationError('綠界僅支援 7-11 店到店（UNIMARTC2C）透過 API 取消，其他請至綠界後台處理');
    const payload = (shipment.carrier_payload ?? {}) as Record<string, string>;
    const text = await this.post(account, '/Express/CancelC2COrder', {
      MerchantID: c.merchantId,
      AllPayLogisticsID: shipment.carrier_shipment_id ?? '',
      CVSPaymentNo: payload.CVSPaymentNo ?? '',
      CVSValidationNo: payload.CVSValidationNo ?? '',
      ...(c.platformId ? { PlatformID: c.platformId } : {}),
    });
    if (text.trim() !== '1|OK') throw new ValidationError(`綠界取消失敗：${text.trim()}`);
  }

  async queryTracking(shipment: ShipmentRow, account: CarrierAccount): Promise<CarrierTrackingEvent[]> {
    const c = creds(account);
    if (!shipment.carrier_shipment_id) return [];
    const text = await this.post(account, '/Helper/QueryLogisticsTradeInfo/V4', {
      MerchantID: c.merchantId,
      AllPayLogisticsID: shipment.carrier_shipment_id,
      TimeStamp: String(Math.floor(Date.now() / 1000)),
      ...(c.platformId ? { PlatformID: c.platformId } : {}),
    });
    const data = parseForm(text);
    if (!verifyCheckMacValue(data, c.hashKey, c.hashIv)) throw new UnknownError('綠界查詢回應驗簽失敗', text);
    if (!data.LogisticsStatus) return [];
    return [
      {
        rawStatus: data.LogisticsStatus,
        status: mapEcpayStatus(data.LogisticsStatus),
        description: data.LogisticsStatusName ?? data.RtnMsg,
        occurredAt: data.UpdateStatusDate ? parseTaipeiTime(data.UpdateStatusDate) : new Date(),
        raw: data,
      },
    ];
  }

  parseCallback(req: RawCallback): ParsedCallback {
    const data = parseForm(req.body);
    if (!data.RtnCode) throw new ValidationError('綠界回調缺少 RtnCode');
    return {
      carrierShipmentId: data.AllPayLogisticsID,
      shipmentRef: data.MerchantTradeNo,
      trackingNumber: data.CVSPaymentNo || undefined,
      events: [
        {
          rawStatus: data.RtnCode,
          status: mapEcpayStatus(data.RtnCode),
          description: data.RtnMsg,
          occurredAt: data.UpdateStatusDate ? parseTaipeiTime(data.UpdateStatusDate) : new Date(),
          raw: data,
        },
      ],
    };
  }

  verifyCallback(req: RawCallback, account: CarrierAccount): boolean {
    const c = creds(account);
    const data = parseForm(req.body);
    return data.MerchantID === c.merchantId && verifyCheckMacValue(data, c.hashKey, c.hashIv);
  }

  callbackAck(result: 'OK' | 'ERROR') {
    // 綠界要求回應 1|OK，否則會重送
    return result === 'OK'
      ? { status: 200, body: '1|OK', contentType: 'text/plain' }
      : { status: 400, body: '0|ERROR', contentType: 'text/plain' };
  }

  mapStatus(rawStatus: string) {
    return mapEcpayStatus(rawStatus);
  }

  async getStoreMapRequest(params: StoreMapParams, account: CarrierAccount): Promise<StoreMapRequest> {
    const c = creds(account);
    return {
      method: 'POST',
      url: `${baseUrl(account)}/Express/map`,
      fields: {
        MerchantID: c.merchantId,
        LogisticsType: 'CVS',
        LogisticsSubType: params.subType,
        IsCollection: params.isCollection ? 'Y' : 'N',
        ServerReplyURL: params.replyUrl,
        ExtraData: params.state,
        Device: params.device === 'MOBILE' ? '1' : '0',
      },
    };
  }

  parseStoreSelection(req: RawCallback): { state: string; store: CvsStore } {
    const data = parseForm(req.body);
    if (!data.CVSStoreID || !data.LogisticsSubType) throw new ValidationError('選店回傳缺少門市代碼');
    return {
      state: data.ExtraData ?? '',
      store: {
        carrier_code: this.code,
        sub_type: data.LogisticsSubType,
        store_id: data.CVSStoreID,
        store_name: data.CVSStoreName,
        store_address: data.CVSAddress,
      },
    };
  }
}

/** `1|AllPayLogisticsID=…&…` 成功；`0|錯誤訊息` 失敗 */
export function parseCreateResponse(text: string, tradeNo: string): CreateShipmentResult {
  const trimmed = text.trim();
  const sep = trimmed.indexOf('|');
  const flag = sep >= 0 ? trimmed.slice(0, sep) : '';
  const rest = sep >= 0 ? trimmed.slice(sep + 1) : trimmed;
  if (flag !== '1') {
    if (/CheckMacValue|MerchantID|HashKey|驗證碼|檢查碼/i.test(rest)) throw new AuthError(`綠界認證失敗：${rest}`, text);
    if (/系統|稍後|timeout|busy/i.test(rest)) throw new RetryableError(`綠界暫時錯誤：${rest}`, text);
    throw new ValidationError(`綠界建單失敗：${rest}`, {}, text);
  }
  const data = parseForm(rest);
  const { CheckMacValue: _mac, ...safe } = data;
  return {
    carrierShipmentId: data.AllPayLogisticsID ?? null,
    trackingNumber: data.CVSPaymentNo
      ? `${data.CVSPaymentNo}${data.CVSValidationNo ?? ''}`
      : (data.ShipmentNo ?? null),
    labelAvailable: Boolean(data.AllPayLogisticsID),
    raw: { ...safe, merchant_trade_no: tradeNo },
  };
}
