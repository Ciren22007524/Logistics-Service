import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { STATUSES, STATUS_LABEL, api, errorText, getCsrf, qs, type Shipment, type ShipmentStatus } from '../api';
import { ErrorBox, StatusBadge, Time } from '../components/ui';

interface Tenant {
  id: string;
  name: string;
}

export function ShipmentsPage() {
  const [params, setParams] = useSearchParams();
  const statuses = (params.get('status') ?? '').split(',').filter(Boolean) as ShipmentStatus[];
  const [q, setQ] = useState(params.get('q') ?? '');
  const [rows, setRows] = useState<Shipment[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tenants, setTenants] = useState<Tenant[]>([]);

  const filters = {
    status: params.get('status'),
    q: params.get('q'),
    tenant_id: params.get('tenant_id'),
    carrier_code: params.get('carrier_code'),
  };
  const key = JSON.stringify(filters);

  const load = async (next?: string | null) => {
    setLoading(true);
    try {
      const r = await api<{ data: Shipment[]; next_cursor: string | null }>(
        `/admin/api/shipments${qs({ ...filters, cursor: next ?? undefined })}`,
      );
      setRows((prev) => (next ? [...prev, ...r.data] : r.data));
      setCursor(r.next_cursor);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelected(new Set());
    void load();
  }, [key]);

  useEffect(() => {
    api<{ data: Tenant[] }>('/admin/api/tenants').then((r) => setTenants(r.data)).catch(() => undefined);
  }, []);

  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p);
  };

  const toggleStatus = (s: ShipmentStatus) => {
    const next = statuses.includes(s) ? statuses.filter((x) => x !== s) : [...statuses, s];
    set('status', next.join(','));
  };

  const printSelected = async () => {
    try {
      const res = await fetch('/admin/api/labels/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': getCsrf() },
        body: JSON.stringify({ shipment_ids: [...selected] }),
      });
      if (!res.ok) throw new Error((await res.json()).error?.message ?? `HTTP ${res.status}`);
      const skipped = JSON.parse(res.headers.get('x-labels-skipped') ?? '[]') as unknown[];
      window.open(URL.createObjectURL(await res.blob()), '_blank');
      if (skipped.length) alert(`${skipped.length} 筆沒有 PDF 標籤（尚未產生或為 HTML 標籤），已略過`);
    } catch (e) {
      alert(errorText(e));
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>託運單</h1>
        <div className="row">
          <button disabled={selected.size === 0} onClick={printSelected}>
            合併列印標籤（{selected.size}）
          </button>
          <Link className="btn primary" to="/shipments/new">
            建立測試單
          </Link>
        </div>
      </div>

      <div className="card stack">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            set('q', q.trim() || null);
          }}
        >
          <input
            placeholder="外部編號 / 託運單號 / Shipment ID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ minWidth: 280 }}
          />
          <button type="submit">搜尋</button>
          <select value={filters.tenant_id ?? ''} onChange={(e) => set('tenant_id', e.target.value || null)}>
            <option value="">全部租戶</option>
            {tenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select value={filters.carrier_code ?? ''} onChange={(e) => set('carrier_code', e.target.value || null)}>
            <option value="">全部物流商</option>
            <option value="MOCK">MOCK</option>
            <option value="ECPAY_CVS">ECPAY_CVS</option>
          </select>
          {(statuses.length > 0 || filters.q || filters.tenant_id || filters.carrier_code) && (
            <button type="button" onClick={() => setParams(new URLSearchParams())}>
              清除篩選
            </button>
          )}
        </form>
        <div className="chips">
          {STATUSES.map((s) => (
            <span key={s} className={`chip ${statuses.includes(s) ? 'on' : ''}`} onClick={() => toggleStatus(s)}>
              {STATUS_LABEL[s]}
            </span>
          ))}
        </div>
      </div>

      <ErrorBox error={error} />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input
                  type="checkbox"
                  checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                />
              </th>
              <th>外部編號</th>
              <th>狀態</th>
              <th>物流商</th>
              <th>託運單號</th>
              <th>收件</th>
              <th>建立時間</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={(e) => {
                      const n = new Set(selected);
                      if (e.target.checked) n.add(s.id);
                      else n.delete(s.id);
                      setSelected(n);
                    }}
                  />
                </td>
                <td>
                  <Link to={`/shipments/${s.id}`}>{s.external_ref}</Link>
                  <div className="muted mono">{s.id.slice(0, 8)}</div>
                </td>
                <td>
                  <StatusBadge status={s.status} />
                  {s.last_error && <div className="muted" title={s.last_error} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.last_error}</div>}
                </td>
                <td>
                  {s.carrier_code}
                  <div className="muted">{s.service_type === 'CVS_PICKUP' ? `超商 ${s.cvs_store?.sub_type ?? ''}` : '宅配'}</div>
                </td>
                <td className="mono">{s.tracking_number ?? '—'}</td>
                <td>
                  {s.recipient.name}
                  <div className="muted">{s.service_type === 'CVS_PICKUP' ? s.cvs_store?.store_name ?? s.cvs_store?.store_id : s.recipient.address}</div>
                </td>
                <td>
                  <Time value={s.created_at} />
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  沒有符合的託運單
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {cursor && (
        <button disabled={loading} onClick={() => load(cursor)} style={{ alignSelf: 'center' }}>
          {loading ? '載入中…' : '載入更多'}
        </button>
      )}
    </div>
  );
}
