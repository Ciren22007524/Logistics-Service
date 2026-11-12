import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, ErrorBox, Loading, Time, useAction, useAsync } from '../components/ui';

interface Account {
  id: string;
  tenant_id: string;
  carrier_code: string;
  name: string;
  is_sandbox: boolean;
  is_default: boolean;
  sender_info: { name: string; phone: string; address?: string };
  credential_keys: string[];
  created_at: string;
}
interface Carrier {
  code: string;
  name: string;
  capabilities: Record<string, unknown>;
}

const CREDENTIAL_TEMPLATES: Record<string, Record<string, string>> = {
  MOCK: {},
  ECPAY_CVS: { merchantId: '2000933', hashKey: 'XBERn1YOvpM9nfZc', hashIv: 'h1ONHk4P4yqbl5LK', mode: 'C2C' },
};

export function CarrierAccountsPage() {
  const accounts = useAsync(() => api<{ data: Account[] }>('/admin/api/carrier-accounts'), []);
  const tenants = useAsync(() => api<{ data: { id: string; name: string }[] }>('/admin/api/tenants'), []);
  const carriers = useAsync(() => api<{ data: Carrier[] }>('/admin/api/carriers'), []);
  const action = useAction();
  const [form, setForm] = useState({
    tenant_id: '',
    carrier_code: 'MOCK',
    name: '',
    credentials: '{}',
    is_default: true,
    sender_name: '測試寄件人',
    sender_phone: '0911222333',
    sender_address: '桃園市桃園區測試路1號',
  });

  useEffect(() => {
    if (!form.tenant_id && tenants.data?.data[0]) setForm((f) => ({ ...f, tenant_id: tenants.data!.data[0]!.id }));
  }, [tenants.data, form.tenant_id]);

  const tenantName = (id: string) => tenants.data?.data.find((t) => t.id === id)?.name ?? id.slice(0, 8);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    let credentials: Record<string, string>;
    try {
      credentials = JSON.parse(form.credentials || '{}');
    } catch {
      action.setMessage({ tone: 'error', text: 'credentials 不是合法 JSON' });
      return;
    }
    await action.run(
      () =>
        api('/admin/api/carrier-accounts', {
          method: 'POST',
          json: {
            tenant_id: form.tenant_id,
            carrier_code: form.carrier_code,
            name: form.name || form.carrier_code,
            credentials,
            is_sandbox: true,
            is_default: form.is_default,
            sender_info: { name: form.sender_name, phone: form.sender_phone, address: form.sender_address || undefined },
          },
        }),
      '已新增（金鑰已以 AES-256-GCM 加密保存）',
    );
    accounts.reload();
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>物流商帳號</h1>
          <div className="sub">金鑰應用層加密保存，後台只顯示欄位名稱。非正式環境只能新增沙箱帳號。</div>
        </div>
      </div>
      <ErrorBox error={accounts.error} />

      <div className="card">
        <h2>可用物流商</h2>
        <div className="row">
          {carriers.data?.data.map((c) => (
            <Badge key={c.code} tone="brand">
              {c.code} · {c.name}
            </Badge>
          ))}
        </div>
      </div>

      {accounts.loading && !accounts.data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名稱</th>
                <th>物流商</th>
                <th>租戶</th>
                <th>寄件人</th>
                <th>金鑰欄位</th>
                <th>建立</th>
              </tr>
            </thead>
            <tbody>
              {accounts.data?.data.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.name} {a.is_default && <Badge tone="brand">預設</Badge>}
                    <div className="muted mono">{a.id}</div>
                  </td>
                  <td>
                    {a.carrier_code} {a.is_sandbox ? <Badge tone="warn">沙箱</Badge> : <Badge tone="danger">正式</Badge>}
                  </td>
                  <td>{tenantName(a.tenant_id)}</td>
                  <td>
                    {a.sender_info.name}
                    <div className="muted">{a.sender_info.phone}</div>
                  </td>
                  <td className="mono muted">{a.credential_keys.join(', ')}</td>
                  <td>
                    <Time value={a.created_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="card stack" onSubmit={create}>
        <h2>新增帳號</h2>
        {action.view}
        <div className="form-grid">
          <label className="field">
            租戶
            <select value={form.tenant_id} onChange={(e) => setForm({ ...form, tenant_id: e.target.value })}>
              {tenants.data?.data.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            物流商
            <select
              value={form.carrier_code}
              onChange={(e) =>
                setForm({
                  ...form,
                  carrier_code: e.target.value,
                  credentials: JSON.stringify(CREDENTIAL_TEMPLATES[e.target.value] ?? {}, null, 2),
                })
              }
            >
              {carriers.data?.data.map((c) => (
                <option key={c.code}>{c.code}</option>
              ))}
            </select>
          </label>
          <label className="field">
            名稱
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例如 綠界 C2C 測試" />
          </label>
          <label className="check">
            <input type="checkbox" checked={form.is_default} onChange={(e) => setForm({ ...form, is_default: e.target.checked })} />
            設為此物流商的預設帳號
          </label>
          <label className="field">
            寄件人姓名
            <input value={form.sender_name} onChange={(e) => setForm({ ...form, sender_name: e.target.value })} required />
          </label>
          <label className="field">
            寄件人電話
            <input value={form.sender_phone} onChange={(e) => setForm({ ...form, sender_phone: e.target.value })} required />
          </label>
          <label className="field" style={{ gridColumn: 'span 2' }}>
            寄件人地址
            <input value={form.sender_address} onChange={(e) => setForm({ ...form, sender_address: e.target.value })} />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            credentials（JSON；MOCK 留空會自動產生 callbackSecret；綠界預填的是官方公開測試帳號）
            <textarea rows={5} value={form.credentials} onChange={(e) => setForm({ ...form, credentials: e.target.value })} />
          </label>
        </div>
        <div>
          <button className="primary" disabled={action.busy || !form.tenant_id}>
            新增
          </button>
        </div>
      </form>
    </div>
  );
}
