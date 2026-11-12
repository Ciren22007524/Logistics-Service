import { api } from '../api';
import { Badge, ErrorBox, Json, Loading, Time, useAsync } from '../components/ui';

type Protocol = 'oidc' | 'oauth2';
interface LoginDetails {
  protocol: Protocol;
  client_id: string;
  requested_scope: string;
  granted_scope: string | null;
  token_type: string | null;
  expires_in: number | null;
  received: { id_token: boolean; access_token: 'jwt' | 'opaque'; refresh_token: boolean };
  identity_source: 'id_token' | 'userinfo';
  checks: string[];
  id_token_claims: Record<string, unknown> | null;
  userinfo: Record<string, unknown>;
  logged_in_at: string;
}
interface Compare {
  current: Protocol | null;
  protocols: Protocol[];
  oidc: LoginDetails | null;
  oauth2: LoginDetails | null;
}

const NAME: Record<Protocol, string> = { oidc: 'OIDC', oauth2: 'OAuth 2.0' };
const yes = (v: boolean) => (v ? <Badge tone="ok">有</Badge> : <Badge>無</Badge>);

/** 同一個使用者分別用 OIDC 與 OAuth 2.0 登入後，並排比較拿到的東西與做了哪些驗證 */
export function SsoComparePage() {
  const { data, error, loading } = useAsync(() => api<Compare>('/auth/compare'), []);
  if (loading && !data) return <Loading />;
  if (!data) return <ErrorBox error={error} />;

  const cols: Protocol[] = ['oidc', 'oauth2'];
  const d = (p: Protocol) => data[p];
  const loginAgain = (p: Protocol) => {
    window.location.href = `/auth/login?${new URLSearchParams({ protocol: p, return_to: '/sso-compare' })}`;
  };
  const row = (label: string, render: (x: LoginDetails) => React.ReactNode) => (
    <tr>
      <th style={{ position: 'static', width: 160 }}>{label}</th>
      {cols.map((p) => (
        <td key={p}>{d(p) ? render(d(p)!) : <span className="muted">—</span>}</td>
      ))}
    </tr>
  );
  const sameSub = data.oidc && data.oauth2 && data.oidc.userinfo.sub === data.oauth2.userinfo.sub;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>登入協議比較</h1>
          <div className="sub">
            同一份設定、同一個回呼網址，auth-service 註冊兩個 client。分別登入一次後在這裡並排比較（保留各協議最近一次，30 天）。
          </div>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              {cols.map((p) => (
                <th key={p}>
                  <div className="row">
                    {NAME[p]}
                    {data.current === p && <Badge tone="brand">目前 session</Badge>}
                    <span className="spacer" />
                    {data.protocols.includes(p) ? (
                      <button className="small" onClick={() => loginAgain(p)}>
                        {d(p) ? '重新登入' : '用此協議登入'}
                      </button>
                    ) : (
                      <Badge tone="warn">未設定 client</Badge>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row('登入時間', (x) => <Time value={x.logged_in_at} />)}
            {row('client_id', (x) => <span className="mono">{x.client_id}</span>)}
            {row('請求 scope', (x) => <span className="mono">{x.requested_scope}</span>)}
            {row('核准 scope', (x) => <span className="mono">{x.granted_scope ?? '（未回傳）'}</span>)}
            {row('身分來源', (x) => (x.identity_source === 'id_token' ? <Badge tone="ok">簽章的 ID token</Badge> : <Badge tone="warn">UserInfo 回應</Badge>))}
            {row('ID token', (x) => yes(x.received.id_token))}
            {row('access token', (x) => (
              <>
                {x.received.access_token === 'jwt' ? 'JWT' : '不透明字串'}（{x.token_type}，{x.expires_in ?? '?'} 秒）
              </>
            ))}
            {row('refresh token', (x) => yes(x.received.refresh_token))}
            {row('做了哪些驗證', (x) => (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {x.checks.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ))}
            {row('ID token claims', (x) => (x.id_token_claims ? <Json value={x.id_token_claims} /> : <span className="muted">沒有 ID token</span>))}
            {row('UserInfo', (x) => <Json value={x.userinfo} />)}
          </tbody>
        </table>
      </div>

      {sameSub !== null && (
        <div className={`alert ${sameSub ? 'ok' : 'warn'}`}>
          {sameSub ? '兩個 client 拿到相同的 sub，可以用同一個主鍵對應使用者。' : '兩個 client 的 sub 不同，請確認 auth-service 的 subject_type。'}
        </div>
      )}

      <div className="card">
        <h2>差異重點</h2>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          <li>
            <b>OIDC</b>：ID token 是授權伺服器簽章的身分聲明，綁定 audience（本 client）與 nonce（本次登入），本站可離線驗證「是誰、給誰、哪一次」。
          </li>
          <li>
            <b>OAuth 2.0</b>：access token 只代表「可以存取資源」，沒有給本站驗證的身分聲明；身分是拿 token 打 UserInfo 才知道，可信度依賴 TLS
            與 issuer 本身，也沒有 nonce 可綁定這次登入（只靠 state + PKCE）。
          </li>
          <li>兩者都用 Authorization Code + PKCE S256 + state、client_secret_basic；角色都從 UserInfo 的 roles 取得，後台授權規則相同。</li>
          <li>登出：兩者都撤銷 access token；全站登出只有 OIDC 能帶 id_token_hint。</li>
        </ul>
      </div>
    </div>
  );
}
