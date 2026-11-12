import { useState } from 'react';
import { api } from '../api';
import { Badge, ErrorBox, Loading, Time, useAction, useAsync } from '../components/ui';

interface Tenant {
  id: string;
  name: string;
  webhook_url: string | null;
  webhook_secret: string;
  store_map_return_origins: string[];
  created_at: string;
}
interface ApiKey {
  id: string;
  key_prefix: string;
  label: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export function TenantsPage() {
  const { data, error, loading, reload } = useAsync(() => api<{ data: Tenant[] }>('/admin/api/tenants'), []);
  const action = useAction();
  const [name, setName] = useState('');
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    await action.run(async () => {
      const t = await api<Tenant>('/admin/api/tenants', { method: 'POST', json: { name } });
      setSecret({ title: `「${t.name}」的 Webhook Secret（只顯示這一次）`, value: t.webhook_secret });
      setName('');
      reload();
    });
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>租戶與 API Key</h1>
          <div className="sub">上游以 Authorization: Bearer &lt;api_key&gt; 呼叫 /v1；webhook 以 X-Signature = HMAC-SHA256(body, secret) 簽章</div>
        </div>
        <form className="row" onSubmit={create}>
          <input placeholder="新租戶名稱" value={name} onChange={(e) => setName(e.target.value)} required />
          <button className="primary" disabled={action.busy}>
            建立租戶
          </button>
        </form>
      </div>
      <ErrorBox error={error} />
      {action.view}
      {secret && <SecretBox {...secret} onClose={() => setSecret(null)} />}
      {loading && !data ? <Loading /> : data?.data.map((t) => <TenantCard key={t.id} tenant={t} onChanged={reload} onSecret={setSecret} />)}
    </div>
  );
}

function SecretBox({ title, value, onClose }: { title: string; value: string; onClose: () => void }) {
  return (
    <div className="card stack">
      <div className="row">
        <b>{title}</b>
        <span className="spacer" />
        <button className="small" onClick={() => navigator.clipboard.writeText(value)}>
          複製
        </button>
        <button className="small" onClick={onClose}>
          我已保存
        </button>
      </div>
      <div className="secret">{value}</div>
    </div>
  );
}

function TenantCard({
  tenant,
  onChanged,
  onSecret,
}: {
  tenant: Tenant;
  onChanged: () => void;
  onSecret: (s: { title: string; value: string }) => void;
}) {
  const keys = useAsync(() => api<{ data: ApiKey[] }>(`/admin/api/tenants/${tenant.id}/api-keys`), [tenant.id]);
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const [webhook, setWebhook] = useState(tenant.webhook_url ?? '');
  const [origins, setOrigins] = useState(tenant.store_map_return_origins.join('\n'));
  const [label, setLabel] = useState('');

  const save = () =>
    action
      .run(
        () =>
          api(`/admin/api/tenants/${tenant.id}`, {
            method: 'PATCH',
            json: {
              webhook_url: webhook.trim() || null,
              store_map_return_origins: origins.split(/\s+/).filter(Boolean),
            },
          }),
        '已儲存',
      )
      .then((ok) => {
        if (ok) {
          setEditing(false);
          onChanged();
        }
      });

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>{tenant.name}</h2>
        <span className="mono muted">{tenant.id}</span>
        <span className="spacer" />
        <button className="small" onClick={() => setEditing(!editing)}>
          {editing ? '取消' : '編輯'}
        </button>
        <button
          className="small"
          disabled={action.busy}
          onClick={() =>
            confirm('重新產生 webhook secret？上游需同步更新驗簽金鑰。') &&
            action.run(async () => {
              const t = await api<Tenant>(`/admin/api/tenants/${tenant.id}`, { method: 'PATCH', json: { rotate_secret: true } });
              onSecret({ title: `「${t.name}」的新 Webhook Secret（只顯示這一次）`, value: t.webhook_secret });
              onChanged();
            })
          }
        >
          輪替 Webhook Secret
        </button>
      </div>
      {action.view}
      {editing ? (
        <div className="form-grid">
          <label className="field" style={{ gridColumn: 'span 2' }}>
            Webhook URL
            <input value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://erp.example.com/webhooks/logistics" />
          </label>
          <label className="field" style={{ gridColumn: 'span 2' }}>
            選店後允許導回的來源（每行一個）
            <textarea rows={3} value={origins} onChange={(e) => setOrigins(e.target.value)} placeholder="https://shop.example.com" />
          </label>
          <div>
            <button className="primary" onClick={save} disabled={action.busy}>
              儲存
            </button>
          </div>
        </div>
      ) : (
        <dl className="kv">
          <dt>Webhook URL</dt>
          <dd>{tenant.webhook_url ?? <span className="muted">未設定（事件會標記為略過）</span>}</dd>
          <dt>Webhook Secret</dt>
          <dd className="mono">{tenant.webhook_secret}</dd>
          <dt>選店導回來源</dt>
          <dd>{tenant.store_map_return_origins.length ? tenant.store_map_return_origins.join('、') : <span className="muted">無</span>}</dd>
        </dl>
      )}

      <h3>API Keys</h3>
      <div className="row">
        <input placeholder="用途標籤（例如 ERP 正式）" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button
          disabled={action.busy}
          onClick={() =>
            action.run(async () => {
              const r = await api<{ key: string }>(`/admin/api/tenants/${tenant.id}/api-keys`, { method: 'POST', json: { label: label || null } });
              onSecret({ title: `「${tenant.name}」的新 API Key（只顯示這一次）`, value: r.key });
              setLabel('');
              keys.reload();
            })
          }
        >
          發行 API Key
        </button>
      </div>
      <table>
        <tbody>
          {keys.data?.data.map((k) => (
            <tr key={k.id}>
              <td className="mono">{k.key_prefix}…</td>
              <td>{k.label}</td>
              <td>{k.revoked_at ? <Badge tone="danger">已撤銷</Badge> : <Badge tone="ok">有效</Badge>}</td>
              <td className="muted">
                最後使用 <Time value={k.last_used_at} />
              </td>
              <td>
                {!k.revoked_at && (
                  <button
                    className="small danger"
                    onClick={() =>
                      confirm('撤銷後立即失效，確定？') &&
                      action.run(() => api(`/admin/api/tenants/${tenant.id}/api-keys/${k.id}`, { method: 'DELETE' }), '已撤銷').then(keys.reload)
                    }
                  >
                    撤銷
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
