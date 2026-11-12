import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { STATUS_LABEL, api, type Shipment, type ShipmentStatus } from '../api';
import { Badge, ErrorBox, Json, Loading, StatusBadge, Time, useAction, useAsync } from '../components/ui';

interface Detail {
  shipment: Shipment;
  tenant_id: string;
  idempotency_key: string;
  carrier_payload: Record<string, unknown> | null;
  package: Record<string, number | string | null> | null;
  allowed_next: ShipmentStatus[];
  capabilities: { cancel: boolean } | null;
  tracking_events: {
    status: ShipmentStatus;
    raw_status: string;
    description: string | null;
    location: string | null;
    occurred_at: string;
    received_at: string;
    source: string;
    applied: boolean;
    raw_payload: unknown;
  }[];
  outbox_events: {
    id: string;
    event_type: string;
    status: 'PENDING' | 'SENT' | 'DEAD';
    attempt_count: number;
    last_error: string | null;
    next_retry_at: string;
    sent_at: string | null;
    created_at: string;
    envelope: unknown;
  }[];
  audit_logs: { id: string; actor: string; action: string; created_at: string; detail: unknown }[];
  callbacks: { id: string; kind: string; verified: boolean | null; processed_at: string | null; error: string | null; received_at: string; body: string }[];
  mock_status_codes: Record<string, { status: ShipmentStatus; label: string }> | null;
}

const CANCELLABLE: ShipmentStatus[] = ['CREATED', 'LABEL_PENDING', 'READY_TO_SHIP'];
const OUTBOX_TONE = { PENDING: 'info', SENT: 'ok', DEAD: 'danger' } as const;

export function ShipmentDetailPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useAsync(() => api<Detail>(`/admin/api/shipments/${id}`), [id]);
  const action = useAction();
  const [simCode, setSimCode] = useState('');
  const [openPayload, setOpenPayload] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const s = data.shipment;

  const post = (path: string, okText: string, json: unknown = {}) =>
    action.run(() => api(`/admin/api/shipments/${s.id}/${path}`, { method: 'POST', json }), okText).then((ok) => {
      // worker 是非同步的，稍等再刷新
      if (ok) setTimeout(reload, 800);
    });

  const mockCodes = data.mock_status_codes
    ? Object.entries(data.mock_status_codes).filter(([, v]) => data.allowed_next.includes(v.status))
    : [];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="sub">
            <Link to="/shipments">託運單</Link> / {s.id}
          </div>
          <div className="row" style={{ marginTop: 4 }}>
            <h1>{s.external_ref}</h1>
            <StatusBadge status={s.status} />
            <Badge>{s.carrier_code}</Badge>
            <Badge>{s.service_type === 'CVS_PICKUP' ? '超商取貨' : '宅配'}</Badge>
          </div>
        </div>
        <div className="row">
          <button onClick={reload}>重新整理</button>
          {s.label_available && (
            <a className="btn" href={`/admin/api/shipments/${s.id}/label`} target="_blank" rel="noreferrer">
              查看標籤
            </a>
          )}
          {(s.tracking_number || s.carrier_shipment_id) && !['CANCELLED', 'FAILED'].includes(s.status) && (
            <button disabled={action.busy} onClick={() => post('refetch-label', '已排程重新取標籤')}>
              重新取標籤
            </button>
          )}
          {s.status === 'FAILED' && (
            <button className="primary" disabled={action.busy} onClick={() => post('retry', '已重新送出')}>
              重新送出
            </button>
          )}
          {CANCELLABLE.includes(s.status) && (
            <button
              className="danger"
              disabled={action.busy}
              onClick={() => confirm('確定取消這張託運單？') && post('cancel', '已取消')}
            >
              取消託運單
            </button>
          )}
        </div>
      </div>

      {action.view}
      {s.last_error && (
        <div className="alert error">
          <b>最近錯誤（第 {s.attempt_count} 次嘗試）</b>
          {'\n'}
          {s.last_error}
        </div>
      )}

      {data.mock_status_codes && s.tracking_number && mockCodes.length > 0 && (
        <div className="card row">
          <b>模擬物流商回調</b>
          <span className="muted">走完整回調流程（驗簽 → 佇列 → 狀態機 → webhook）</span>
          <span className="spacer" />
          <select value={simCode} onChange={(e) => setSimCode(e.target.value)}>
            <option value="">選擇狀態…</option>
            {mockCodes.map(([code, v]) => (
              <option key={code} value={code}>
                {code} {v.label} → {STATUS_LABEL[v.status]}
              </option>
            ))}
          </select>
          <button className="primary" disabled={!simCode || action.busy} onClick={() => post('simulate', `已送出模擬回調 ${simCode}`, { status_code: simCode })}>
            送出
          </button>
        </div>
      )}

      <div className="grid cols-3">
        <div className="card">
          <h2>物流資訊</h2>
          <dl className="kv">
            <dt>託運單號</dt>
            <dd className="mono">{s.tracking_number ?? '—'}</dd>
            <dt>物流商 ID</dt>
            <dd className="mono">{s.carrier_shipment_id ?? '—'}</dd>
            <dt>溫層</dt>
            <dd>{s.temperature}</dd>
            <dt>代收金額</dt>
            <dd>{s.cod_amount ? `NT$${s.cod_amount}` : '—'}</dd>
            <dt>申報價值</dt>
            <dd>{s.declared_value ?? '—'}</dd>
            <dt>品名</dt>
            <dd>{s.items_summary}</dd>
            <dt>時段</dt>
            <dd>{s.preferred_time_slot ?? '—'}</dd>
            <dt>標籤</dt>
            <dd>{s.label_available ? s.label_content_type : '尚未產生'}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>收件人</h2>
          <dl className="kv">
            <dt>姓名</dt>
            <dd>{s.recipient.name}</dd>
            <dt>電話</dt>
            <dd>{s.recipient.phone}</dd>
            {s.recipient.address && (
              <>
                <dt>地址</dt>
                <dd>
                  {s.recipient.zip} {s.recipient.address}
                </dd>
              </>
            )}
            {s.cvs_store && (
              <>
                <dt>門市</dt>
                <dd>
                  {s.cvs_store.store_name} <span className="mono">{s.cvs_store.store_id}</span>
                  <div className="muted">
                    {s.cvs_store.sub_type} · {s.cvs_store.store_address}
                  </div>
                </dd>
              </>
            )}
          </dl>
        </div>
        <div className="card">
          <h2>其他</h2>
          <dl className="kv">
            <dt>建立</dt>
            <dd>
              <Time value={s.created_at} />
            </dd>
            <dt>更新</dt>
            <dd>
              <Time value={s.updated_at} />
            </dd>
            <dt>送達</dt>
            <dd>
              <Time value={s.delivered_at} />
            </dd>
            <dt>租戶</dt>
            <dd className="mono">{data.tenant_id}</dd>
            <dt>冪等鍵</dt>
            <dd className="mono">{data.idempotency_key}</dd>
          </dl>
          <h3 style={{ marginTop: 12 }}>metadata</h3>
          <Json value={s.metadata} />
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>物流軌跡</h2>
          {data.tracking_events.length === 0 ? (
            <div className="muted">尚無軌跡</div>
          ) : (
            <ul className="timeline">
              {[...data.tracking_events].reverse().map((e, i) => (
                <li key={i} className={e.applied ? '' : 'ignored'}>
                  <div className="row">
                    <StatusBadge status={e.status} />
                    <span className="mono muted">{e.raw_status}</span>
                    <span>{e.description}</span>
                    {!e.applied && <Badge>未推進狀態</Badge>}
                  </div>
                  <div className="t">
                    <Time value={e.occurred_at} /> · {e.source}
                    {e.location ? ` · ${e.location}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2>Webhook 事件</h2>
          {data.outbox_events.length === 0 && <div className="muted">尚無事件</div>}
          <table>
            <tbody>
              {data.outbox_events.map((o) => (
                <tr key={o.id}>
                  <td>
                    <div className="mono">{o.event_type}</div>
                    <div className="muted">
                      evt_{o.id} · <Time value={o.created_at} />
                    </div>
                    {o.last_error && <div className="muted mono">{o.last_error}</div>}
                    {openPayload === o.id && <Json value={o.envelope} />}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <Badge tone={OUTBOX_TONE[o.status]}>{o.status}</Badge>
                    <div className="muted">嘗試 {o.attempt_count}</div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="small" onClick={() => setOpenPayload(openPayload === o.id ? null : o.id)}>
                      內容
                    </button>{' '}
                    <button
                      className="small"
                      disabled={action.busy}
                      onClick={() =>
                        action.run(() => api(`/admin/api/outbox/${o.id}/redeliver`, { method: 'POST', json: {} }), `已排程重送 evt_${o.id}`).then(reload)
                      }
                    >
                      重送
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>物流商回應（carrier_payload）</h2>
          <Json value={data.carrier_payload} />
          <h3 style={{ marginTop: 12 }}>包裹</h3>
          <Json value={data.package} />
        </div>
        <div className="card">
          <h2>操作紀錄</h2>
          <table>
            <tbody>
              {data.audit_logs.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.action}</td>
                  <td>{a.actor}</td>
                  <td>
                    <Time value={a.created_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3 style={{ marginTop: 12 }}>物流商回調</h3>
          {data.callbacks.length === 0 && <div className="muted">無</div>}
          <table>
            <tbody>
              {data.callbacks.map((c) => (
                <tr key={c.id}>
                  <td>
                    #{c.id} <Time value={c.received_at} />
                  </td>
                  <td>
                    {c.verified ? <Badge tone="ok">已驗簽</Badge> : <Badge tone="danger">未通過</Badge>}{' '}
                    {c.processed_at ? <Badge>已處理</Badge> : <Badge tone="info">待處理</Badge>}
                  </td>
                  <td className="mono muted">{c.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
