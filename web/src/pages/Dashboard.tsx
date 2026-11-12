import { Link } from 'react-router-dom';
import { STATUSES, STATUS_LABEL, api, type ShipmentStatus } from '../api';
import { Badge, ErrorBox, Loading, Time, useAsync } from '../components/ui';

interface Dashboard {
  shipments_by_status: Partial<Record<ShipmentStatus, number>>;
  outbox_by_status: Partial<Record<'PENDING' | 'SENT' | 'DEAD', number>>;
  callback_errors_24h: number;
  recent_failed: { id: string; external_ref: string; carrier_code: string; last_error: string | null; updated_at: string }[];
  env: string;
  mock_carrier: boolean;
}

export function DashboardPage() {
  const { data, error, loading } = useAsync(() => api<Dashboard>('/admin/api/dashboard'), []);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;
  const total = Object.values(data.shipments_by_status).reduce((a, b) => a + (b ?? 0), 0);
  const attention = (data.shipments_by_status.FAILED ?? 0) + (data.shipments_by_status.EXCEPTION ?? 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>總覽</h1>
          <div className="sub">
            環境 <Badge tone={data.env === 'production' ? 'danger' : 'info'}>{data.env}</Badge>
            {data.mock_carrier && <> · 已啟用模擬物流商</>}
          </div>
        </div>
      </div>

      <div className="stats">
        <div className="stat">
          <div className="n">{total}</div>
          <div className="l">託運單總數</div>
        </div>
        <Link className="stat" to="/shipments?status=FAILED,EXCEPTION" style={{ color: attention ? 'var(--danger)' : undefined }}>
          <div className="n">{attention}</div>
          <div className="l">需處理（失敗＋異常）</div>
        </Link>
        <Link className="stat" to="/outbox?status=PENDING">
          <div className="n">{data.outbox_by_status.PENDING ?? 0}</div>
          <div className="l">Webhook 待投遞</div>
        </Link>
        <Link className="stat" to="/outbox?status=DEAD" style={{ color: data.outbox_by_status.DEAD ? 'var(--danger)' : undefined }}>
          <div className="n">{data.outbox_by_status.DEAD ?? 0}</div>
          <div className="l">Webhook 投遞失敗</div>
        </Link>
        <Link className="stat" to="/callbacks?errors=true">
          <div className="n">{data.callback_errors_24h}</div>
          <div className="l">回調錯誤（24h）</div>
        </Link>
      </div>

      <div className="card">
        <h2>依狀態</h2>
        <div className="stats">
          {STATUSES.map((s) => (
            <Link key={s} className="stat" to={`/shipments?status=${s}`}>
              <div className="n">{data.shipments_by_status[s] ?? 0}</div>
              <div className="l">{STATUS_LABEL[s]}</div>
            </Link>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>最近建單失敗</h2>
        {data.recent_failed.length === 0 ? (
          <div className="muted">沒有失敗的託運單</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>外部編號</th>
                <th>物流商</th>
                <th>錯誤</th>
                <th>時間</th>
              </tr>
            </thead>
            <tbody>
              {data.recent_failed.map((f) => (
                <tr key={f.id}>
                  <td>
                    <Link to={`/shipments/${f.id}`}>{f.external_ref}</Link>
                  </td>
                  <td>{f.carrier_code}</td>
                  <td className="mono">{f.last_error}</td>
                  <td>
                    <Time value={f.updated_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
