import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CarrierAccount } from '../../src/carriers/carrier.interface.js';
import { checkMacValue, ecpayUrlEncode, verifyCheckMacValue } from '../../src/carriers/ecpay-cvs/check-mac.js';
import { EcpayCvsAdapter, merchantTradeNo, parseCreateResponse } from '../../src/carriers/ecpay-cvs/ecpay-cvs.adapter.js';
import { AuthError, RetryableError, ValidationError } from '../../src/carriers/errors.js';

const fx = (f: string) => readFileSync(join(import.meta.dirname, '../fixtures/carriers/ecpay-cvs', f), 'utf8');

const account: CarrierAccount = {
  id: 'acc',
  tenant_id: 't',
  carrier_code: 'ECPAY_CVS',
  name: 'test',
  credentials: { merchantId: '2000933', hashKey: 'XBERn1YOvpM9nfZc', hashIv: 'h1ONHk4P4yqbl5LK', mode: 'C2C' },
  is_sandbox: true,
  is_default: false,
  sender_info: { name: '王測試', phone: '0911222333' },
};

const signed = (data: Record<string, string>) => ({
  ...data,
  CheckMacValue: checkMacValue(data, account.credentials.hashKey!, account.credentials.hashIv!),
});

describe('ECPay CheckMacValue', () => {
  it('uses .NET UrlEncode rules', () => {
    expect(ecpayUrlEncode("a b~'(x)!*-_.")).toBe("a+b%7e%27(x)!*-_.");
    expect(ecpayUrlEncode('中')).toBe('%e4%b8%ad');
  });

  it('is case-insensitive sorted, MD5 upper hex, ignores existing CheckMacValue', () => {
    const p = { b: '2', A: '1', CheckMacValue: 'zzz' };
    const mac = checkMacValue(p, 'k', 'v');
    expect(mac).toMatch(/^[0-9A-F]{32}$/);
    expect(checkMacValue({ A: '1', b: '2' }, 'k', 'v')).toBe(mac);
  });

  it('verify round trip and tamper detection', () => {
    const data = signed({ MerchantID: '2000933', RtnCode: '300' });
    expect(verifyCheckMacValue(data, 'XBERn1YOvpM9nfZc', 'h1ONHk4P4yqbl5LK')).toBe(true);
    expect(verifyCheckMacValue({ ...data, RtnCode: '2067' }, 'XBERn1YOvpM9nfZc', 'h1ONHk4P4yqbl5LK')).toBe(false);
  });
});

describe('ECPay adapter', () => {
  const adapter = new EcpayCvsAdapter();

  it('MerchantTradeNo is deterministic and ≤20 chars', () => {
    const id = '0123e456-789a-bcde-f012-3456789abcde';
    expect(merchantTradeNo(id)).toHaveLength(20);
    expect(merchantTradeNo(id)).toBe(merchantTradeNo(id));
    expect(merchantTradeNo(id)).toMatch(/^[A-Z0-9]+$/);
  });

  it('parses create success', () => {
    const r = parseCreateResponse(fx('create-success.txt'), 'LS0123456789ABCDEF01');
    expect(r.carrierShipmentId).toBe('1718546');
    expect(r.trackingNumber).toBe('C98765431234');
    expect(r.raw.CheckMacValue).toBeUndefined();
    expect(r.raw.merchant_trade_no).toBe('LS0123456789ABCDEF01');
  });

  it('classifies create errors', () => {
    expect(() => parseCreateResponse(fx('create-error.txt'), 'x')).toThrow(ValidationError);
    expect(() => parseCreateResponse('0|CheckMacValue Error', 'x')).toThrow(AuthError);
    expect(() => parseCreateResponse('0|系統忙碌中，請稍後再試', 'x')).toThrow(RetryableError);
  });

  it('createShipment signs request, maps 5xx to RetryableError', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
      expect(verifyCheckMacValue(body, 'XBERn1YOvpM9nfZc', 'h1ONHk4P4yqbl5LK')).toBe(true);
      expect(body.LogisticsSubType).toBe('UNIMARTC2C');
      expect(body.ServerReplyURL).toBe('https://example.com/callbacks/ECPAY_CVS/acc');
      expect(body.GoodsName).toBe('服飾一批');
      return new Response(fx('create-success.txt'));
    });
    const a = new EcpayCvsAdapter(fetchImpl as unknown as typeof fetch);
    const input = {
      shipmentId: '0123e456-789a-bcde-f012-3456789abcde',
      serviceType: 'CVS_PICKUP' as const,
      recipient: { name: '王小明', phone: '0912345678' },
      cvsStore: { sub_type: 'UNIMARTC2C', store_id: '131386' },
      sender: account.sender_info,
      temperature: 'NORMAL' as const,
      codAmount: null,
      declaredValue: 1500,
      itemsSummary: '服飾一批!@',
      package: null,
      preferredTimeSlot: null,
      scheduledPickupAt: null,
      callbackUrl: 'https://example.com/callbacks/ECPAY_CVS/acc',
    };
    expect(a.validate(input)).toEqual({});
    const r = await a.createShipment(input, account);
    expect(r.labelAvailable).toBe(true);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('https://logistics-stage.ecpay.com.tw/Express/Create');

    const failing = new EcpayCvsAdapter((async () => new Response('busy', { status: 503 })) as unknown as typeof fetch);
    await expect(failing.createShipment(input, account)).rejects.toBeInstanceOf(RetryableError);
  });

  it('validates ECPay-specific constraints', () => {
    const e = adapter.validate({
      shipmentId: 'x',
      serviceType: 'CVS_PICKUP',
      recipient: { name: '王', phone: '0212345678' },
      cvsStore: { sub_type: 'UNIMARTC2C', store_id: '1' },
      sender: account.sender_info,
      temperature: 'CHILLED',
      codAmount: null,
      declaredValue: 50000,
      itemsSummary: 'x',
      package: null,
      preferredTimeSlot: null,
      scheduledPickupAt: null,
      callbackUrl: '',
    });
    expect(Object.keys(e).sort()).toEqual(['declared_value', 'recipient.name', 'recipient.phone', 'temperature']);
  });

  it('parses and verifies status callback', () => {
    const data = signed(JSON.parse(fx('callback-delivered.json')));
    const raw = { headers: {}, query: {}, contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams(data).toString() };
    expect(adapter.verifyCallback(raw, account)).toBe(true);
    const p = adapter.parseCallback(raw);
    expect(p.carrierShipmentId).toBe('1718546');
    expect(p.events[0]!.status).toBe('DELIVERED');
    expect(p.events[0]!.occurredAt.toISOString()).toBe('2026-11-14T07:30:12.000Z');
    expect(adapter.callbackAck('OK')).toMatchObject({ status: 200, body: '1|OK' });

    const forged = { ...raw, body: raw.body.replace('2067', '2074') };
    expect(adapter.verifyCallback(forged, account)).toBe(false);
    const otherMerchant = signed({ ...JSON.parse(fx('callback-delivered.json')), MerchantID: '9999' });
    expect(adapter.verifyCallback({ ...raw, body: new URLSearchParams(otherMerchant).toString() }, account)).toBe(false);
  });

  it('unknown status codes keep history without moving state', () => {
    expect(adapter.mapStatus('9999')).toBeNull();
    expect(adapter.mapStatus('3018')).toBe('ARRIVED_AT_STORE');
  });

  it('store map is a POST form; selection is parsed', async () => {
    const req = await adapter.getStoreMapRequest(
      { subType: 'UNIMARTC2C', replyUrl: 'https://x/cvs/store-selection/ECPAY_CVS', state: 'tok', isCollection: false, device: 'PC' },
      account,
    );
    expect(req.method).toBe('POST');
    if (req.method === 'POST') expect(req.fields.ExtraData).toBe('tok');
    const sel = adapter.parseStoreSelection({
      headers: {},
      query: {},
      contentType: '',
      body: new URLSearchParams({ CVSStoreID: '131386', CVSStoreName: '建盛門市', CVSAddress: '台北市', LogisticsSubType: 'UNIMARTC2C', ExtraData: 'tok' }).toString(),
    });
    expect(sel).toEqual({
      state: 'tok',
      store: { carrier_code: 'ECPAY_CVS', sub_type: 'UNIMARTC2C', store_id: '131386', store_name: '建盛門市', store_address: '台北市' },
    });
  });
});
