import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { Badge, ErrorBox, Json, Loading, Time, useAction, useAsync } from '../components/ui';

interface OutboxEvent {
  id: string;
  tenant_id: string;
  event_type: string;
  status: 'PENDING' | 'SENT' | 'DEAD';
  attempt_count: number;
  last_error: string | null;
  next_retry_at: string;
  sent_at: string | null;
  created_at: string;
  envelope: { data: { shipment_id?: string; external_ref?: string; status?: string } };
}

const TONE = { PENDING: 'info', SENT: 'ok', DEAD: 'danger' } as const;

export function OutboxPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const { data, error, loading, reload } = useAsync(() => api<{ data: OutboxEvent[] }>(`/admin/api/outbox${qs({ status })}`), [status]);
  const action = useAction();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Webhook 事件（Outbox）</h1>
          <div className="sub">重試間隔 1m → 5m → 30m → 2h → 6h → 24h，用盡標記 DEAD</div>
        </div>
        <div className="chips">
          {['', 'PENDING', 'DEAD', 'SENT'].map((s) => (
            <span key={s} className={`chip ${status === s ? 'on' : ''}`} onClick={() => setParams(s ? { status: s } : {})}>
              {s || '全部'}
            </span>
          ))}
        </div>
      </div>
      <ErrorBox error={error} />
      {action.view}
      {loading && !data ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>事件</th>
                <th>託運單</th>
                <th>狀態</th>
                <th>錯誤</th>
                <th>時間</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.data.map((o) => (
                <tr key={o.id}>
                  <td>
                    <div className="mono">{o.event_type}</div>
                    <div className="muted mono">evt_{o.id}</div>
                    {open === o.id && <Json value={o.envelope} />}
                  </td>
                  <td>
                    {o.envelope.data.shipment_id ? (
                      <Link to={`/shipments/${o.envelope.data.shipment_id}`}>{o.envelope.data.external_ref}</Link>
                    ) : (
                      '—'
                    )}
                    <div className="muted">{o.envelope.data.status}</div>
                  </td>
                  <td>
                    <Badge tone={TONE[o.status]}>{o.status}</Badge>
                    <div className="muted">嘗試 {o.attempt_count}</div>
                  </td>
                  <td className="mono muted">{o.last_error}</td>
                  <td>
                    <Time value={o.created_at} />
                    {o.status === 'PENDING' && (
                      <div className="muted">
                        下次 <Time value={o.next_retry_at} />
                      </div>
                    )}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="small" onClick={() => setOpen(open === o.id ? null : o.id)}>
                      內容
                    </button>{' '}
                    <button
                      className="small"
                      disabled={action.busy}
                      onClick={() => action.run(() => api(`/admin/api/outbox/${o.id}/redeliver`, { method: 'POST', json: {} }), `已排程重送 evt_${o.id}`).then(reload)}
                    >
                      重送
                    </button>
                  </td>
                </tr>
              ))}
              {data?.data.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                    沒有事件
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
