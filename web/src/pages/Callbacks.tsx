import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, ErrorBox, Loading, Time, useAsync } from '../components/ui';

interface Callback {
  id: string;
  carrier_code: string;
  kind: string;
  carrier_account_id: string | null;
  shipment_id: string | null;
  verified: boolean | null;
  processed_at: string | null;
  error: string | null;
  received_at: string;
  body: string;
}

export function CallbacksPage() {
  const [params, setParams] = useSearchParams();
  const errorsOnly = params.get('errors') === 'true';
  const { data, error, loading } = useAsync(
    () => api<{ data: Callback[] }>(`/admin/api/callbacks${qs({ errors: errorsOnly ? 'true' : undefined })}`),
    [errorsOnly],
  );
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>物流商回調</h1>
          <div className="sub">原文先存再處理；驗簽失敗的回調也會保留以便追查</div>
        </div>
        <label className="check">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setParams(e.target.checked ? { errors: 'true' } : {})} />
          只看錯誤
        </label>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>物流商</th>
                <th>狀態</th>
                <th>託運單</th>
                <th>錯誤</th>
                <th>收到時間</th>
              </tr>
            </thead>
            <tbody>
              {data?.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    <button className="small" onClick={() => setOpen(open === c.id ? null : c.id)}>
                      {c.id}
                    </button>
                  </td>
                  <td>
                    {c.carrier_code}
                    <div className="muted">{c.kind === 'STORE_SELECTION' ? '選店' : '狀態'}</div>
                  </td>
                  <td>
                    {c.verified ? <Badge tone="ok">已驗簽</Badge> : c.verified === false ? <Badge tone="danger">驗簽失敗</Badge> : <Badge>未驗</Badge>}{' '}
                    {c.processed_at ? <Badge>已處理</Badge> : <Badge tone="info">待處理</Badge>}
                  </td>
                  <td>{c.shipment_id ? <Link to={`/shipments/${c.shipment_id}`}>{c.shipment_id.slice(0, 8)}</Link> : '—'}</td>
                  <td className="mono muted">
                    {c.error}
                    {open === c.id && <pre className="json">{c.body}</pre>}
                  </td>
                  <td>
                    <Time value={c.received_at} />
                  </td>
                </tr>
              ))}
              {data?.data.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    沒有回調紀錄
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
