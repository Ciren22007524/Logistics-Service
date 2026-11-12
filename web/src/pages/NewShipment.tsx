import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs, type Shipment } from '../api';
import { ErrorBox, useAction, useAsync } from '../components/ui';

interface Tenant {
  id: string;
  name: string;
}
interface Account {
  id: string;
  tenant_id: string;
  carrier_code: string;
  name: string;
  is_default: boolean;
  is_sandbox: boolean;
}
interface Carrier {
  code: string;
  name: string;
  capabilities: { homeDelivery: boolean; cvsPickup: boolean; cod: boolean; temperatures: string[]; storeMap: boolean };
  limits: { cvsSubTypes?: string[]; itemsSummaryMaxLength: number };
}
interface Store {
  sub_type: string;
  store_id: string;
  store_name?: string;
  store_address?: string;
}

const STORE_MSG = 'logistics:store-selected';

/** 選店完成後物流商導回此頁（在彈出視窗內），把門市傳回開啟它的表單 */
export function StoreSelectedPage() {
  const [p] = useSearchParams();
  useEffect(() => {
    const store: Store = {
      sub_type: p.get('sub_type') ?? '',
      store_id: p.get('store_id') ?? '',
      store_name: p.get('store_name') ?? undefined,
      store_address: p.get('store_address') ?? undefined,
    };
    if (window.opener) {
      window.opener.postMessage({ type: STORE_MSG, store }, window.location.origin);
      setTimeout(() => window.close(), 300);
    }
  }, [p]);
  return (
    <div className="card">
      <h2>已選擇門市</h2>
      <p>
        {p.get('store_name')}（{p.get('store_id')}）
      </p>
      <p className="muted">{p.get('store_address')}</p>
      <p className="muted">視窗即將關閉；若沒有自動關閉，請回到建立表單。</p>
    </div>
  );
}

export function NewShipmentPage() {
  const nav = useNavigate();
  const action = useAction();
  const tenants = useAsync(() => api<{ data: Tenant[] }>('/admin/api/tenants'), []);
  const carriers = useAsync(() => api<{ data: Carrier[] }>('/admin/api/carriers'), []);
  const [tenantId, setTenantId] = useState('');
  const accounts = useAsync(
    () => (tenantId ? api<{ data: Account[] }>(`/admin/api/carrier-accounts${qs({ tenant_id: tenantId })}`) : Promise.resolve({ data: [] })),
    [tenantId],
  );
  const [accountId, setAccountId] = useState('');
  const [serviceType, setServiceType] = useState<'HOME_DELIVERY' | 'CVS_PICKUP'>('HOME_DELIVERY');
  const [form, setForm] = useState({
    external_ref: `TEST-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(Math.random() * 9000 + 1000)}`,
    name: '王小明',
    phone: '0912345678',
    zip: '330',
    address: '桃園市桃園區某某路1號',
    temperature: 'NORMAL',
    cod_amount: '',
    declared_value: '1500',
    items_summary: '服飾一批',
    preferred_time_slot: '',
    weight_g: '1200',
    metadata: '{"channel":"admin-test"}',
  });
  const [store, setStore] = useState<Store | null>(null);
  const [subType, setSubType] = useState('');

  useEffect(() => {
    if (!tenantId && tenants.data?.data[0]) setTenantId(tenants.data.data[0].id);
  }, [tenants.data, tenantId]);

  const account = accounts.data?.data.find((a) => a.id === accountId);
  const carrier = useMemo(() => carriers.data?.data.find((c) => c.code === account?.carrier_code), [carriers.data, account]);

  useEffect(() => {
    const list = accounts.data?.data ?? [];
    if (list.length && !list.some((a) => a.id === accountId)) setAccountId((list.find((a) => a.is_default) ?? list[0])!.id);
  }, [accounts.data, accountId]);

  useEffect(() => {
    setStore(null);
    setSubType(carrier?.limits.cvsSubTypes?.[0] ?? '');
    if (carrier && !carrier.capabilities.homeDelivery) setServiceType('CVS_PICKUP');
  }, [carrier]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.data?.type === STORE_MSG) setStore(e.data.store);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const f = (k: keyof typeof form) => ({
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value }),
  });

  const openStoreMap = async () => {
    const popup = window.open('about:blank', 'store-map', 'width=1000,height=720');
    await action.run(async () => {
      const r = await api<{ url: string }>('/admin/api/cvs/store-map', {
        method: 'POST',
        json: { tenant_id: tenantId, carrier_account_id: accountId, sub_type: subType, return_path: '/store-selected' },
      });
      if (popup) popup.location.href = r.url;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    let metadata: unknown = {};
    try {
      metadata = form.metadata.trim() ? JSON.parse(form.metadata) : {};
    } catch {
      action.setMessage({ tone: 'error', text: 'metadata 不是合法 JSON' });
      return;
    }
    const num = (v: string) => (v.trim() ? Number(v) : null);
    const body = {
      tenant_id: tenantId,
      external_ref: form.external_ref,
      carrier_account_id: accountId || null,
      service_type: serviceType,
      temperature: form.temperature,
      recipient:
        serviceType === 'HOME_DELIVERY'
          ? { name: form.name, phone: form.phone, zip: form.zip || undefined, address: form.address }
          : { name: form.name, phone: form.phone },
      cvs_store: serviceType === 'CVS_PICKUP' ? (store ? { ...store, carrier_code: account?.carrier_code } : null) : null,
      package: { weight_g: num(form.weight_g) },
      cod_amount: num(form.cod_amount),
      declared_value: num(form.declared_value),
      items_summary: form.items_summary,
      preferred_time_slot: form.preferred_time_slot || null,
      metadata,
    };
    let created: Shipment | null = null;
    const ok = await action.run(async () => {
      created = await api<Shipment>('/admin/api/shipments', { method: 'POST', json: body });
    });
    if (ok && created) nav(`/shipments/${(created as Shipment).id}`);
  };

  const noAccounts = tenantId && accounts.data && accounts.data.data.length === 0;

  return (
    <form className="stack" onSubmit={submit}>
      <div className="page-head">
        <div>
          <h1>建立測試託運單</h1>
          <div className="sub">與上游 POST /v1/shipments 走同一套驗證與流程</div>
        </div>
        <button className="primary" type="submit" disabled={action.busy || !accountId}>
          建立
        </button>
      </div>
      <ErrorBox error={tenants.error ?? carriers.error} />
      {action.view}
      {noAccounts && (
        <div className="alert warn">
          此租戶還沒有物流商帳號，請先到 <Link to="/carrier-accounts">物流商帳號</Link> 新增。
        </div>
      )}

      <fieldset>
        <legend>物流商</legend>
        <div className="form-grid">
          <label className="field">
            租戶
            <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              {tenants.data?.data.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            物流商帳號
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.data?.data.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}（{a.carrier_code}
                  {a.is_default ? '・預設' : ''}
                  {a.is_sandbox ? '・沙箱' : '・正式'}）
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            服務類型
            <select value={serviceType} onChange={(e) => setServiceType(e.target.value as typeof serviceType)}>
              <option value="HOME_DELIVERY" disabled={carrier && !carrier.capabilities.homeDelivery}>
                宅配
              </option>
              <option value="CVS_PICKUP" disabled={carrier && !carrier.capabilities.cvsPickup}>
                超商取貨
              </option>
            </select>
          </label>
          <label className="field">
            溫層
            <select {...f('temperature')}>
              {(carrier?.capabilities.temperatures ?? ['NORMAL']).map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="field">
            外部編號（external_ref）
            <input {...f('external_ref')} required />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>收件人</legend>
        <div className="form-grid">
          <label className="field">
            姓名
            <input {...f('name')} required />
          </label>
          <label className="field">
            電話
            <input {...f('phone')} required />
          </label>
          {serviceType === 'HOME_DELIVERY' && (
            <>
              <label className="field">
                郵遞區號
                <input {...f('zip')} />
              </label>
              <label className="field" style={{ gridColumn: 'span 2' }}>
                地址
                <input {...f('address')} required />
              </label>
              <label className="field">
                指定時段
                <select {...f('preferred_time_slot')}>
                  <option value="">不指定</option>
                  <option value="MORNING">上午</option>
                  <option value="AFTERNOON">下午</option>
                  <option value="EVENING">晚上</option>
                </select>
              </label>
            </>
          )}
        </div>
        {serviceType === 'CVS_PICKUP' && (
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="row">
              <select value={subType} onChange={(e) => setSubType(e.target.value)}>
                {carrier?.limits.cvsSubTypes?.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <button type="button" onClick={openStoreMap} disabled={!accountId || !subType || action.busy}>
                開啟門市地圖選店
              </button>
              {store ? (
                <span>
                  ✓ {store.store_name}（<span className="mono">{store.store_id}</span>）<span className="muted"> {store.store_address}</span>
                </span>
              ) : (
                <span className="muted">尚未選擇門市</span>
              )}
            </div>
            {account?.carrier_code === 'ECPAY_CVS' && (
              <div className="muted">
                綠界地圖會把結果 POST 回 PUBLIC_BASE_URL；本機要測真實地圖需讓綠界連得到（例如 ngrok）。也可手動填門市：
              </div>
            )}
            <div className="row">
              <input placeholder="門市代碼" value={store?.store_id ?? ''} onChange={(e) => setStore({ sub_type: subType, ...store, store_id: e.target.value })} />
              <input placeholder="門市名稱" value={store?.store_name ?? ''} onChange={(e) => setStore({ sub_type: subType, store_id: '', ...store, store_name: e.target.value })} />
            </div>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>包裹與金額</legend>
        <div className="form-grid">
          <label className="field">
            品名
            <input {...f('items_summary')} />
          </label>
          <label className="field">
            重量（g）
            <input {...f('weight_g')} inputMode="numeric" />
          </label>
          <label className="field">
            申報價值
            <input {...f('declared_value')} inputMode="numeric" />
          </label>
          <label className="field">
            代收金額（貨到付款）
            <input {...f('cod_amount')} inputMode="numeric" disabled={carrier && !carrier.capabilities.cod} />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            metadata（JSON，原樣回傳給上游）
            <textarea rows={2} {...f('metadata')} />
          </label>
        </div>
        {account?.carrier_code === 'MOCK' && (
          <p className="muted">
            模擬物流商小技巧：姓名含「驗證失敗」會被拒絕（FAILED）；地址含「#retry」第一次會逾時重試。
          </p>
        )}
      </fieldset>
    </form>
  );
}
