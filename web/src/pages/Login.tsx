import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';

const ERRORS: Record<string, string> = {
  forbidden: '此帳號沒有後台權限，請聯絡管理者把你的 email 或角色加入允許清單。',
  login_expired: '登入逾時，請重新登入。',
  callback_failed: '登入驗證失敗，請重試。',
  access_denied: '你已取消登入。',
};

type Protocol = 'oidc' | 'oauth2';
interface AuthConfig {
  protocols: Protocol[];
  issuer: string | null;
  dev_bypass: boolean;
}

const LABEL: Record<Protocol, { title: string; hint: string }> = {
  oidc: { title: '使用 OIDC 登入', hint: 'scope 含 openid，身分由簽章的 ID token 證明' },
  oauth2: { title: '使用 OAuth 2.0 登入', hint: 'scope 不含 openid，身分由 UserInfo 取得' },
};

export function LoginPage() {
  const [params] = useSearchParams();
  const [cfg, setCfg] = useState<AuthConfig | null>(null);
  const error = params.get('error');
  const returnTo = params.get('return_to') ?? '/';

  useEffect(() => {
    api<AuthConfig>('/auth/config').then(setCfg).catch(() => setCfg(null));
  }, []);

  const go = (protocol?: Protocol) => {
    const q = new URLSearchParams({ return_to: returnTo });
    if (protocol) q.set('protocol', protocol);
    window.location.href = `/auth/login?${q}`;
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="brand-mark">⬡</div>
        <h1>物流管理平台</h1>
        <p className="muted">後台登入（auth-service）</p>
        {error && <div className="alert error">{ERRORS[error] ?? `登入失敗（${error}）`}</div>}
        {cfg?.protocols.map((p, i) => (
          <div key={p}>
            <button className={i === 0 ? 'primary' : ''} onClick={() => go(p)}>
              {LABEL[p].title}
            </button>
            <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
              {LABEL[p].hint}
            </p>
          </div>
        ))}
        {cfg && cfg.protocols.length > 0 && (
          <p className="muted" style={{ fontSize: 12 }}>
            {cfg.issuer}
          </p>
        )}
        {cfg && cfg.protocols.length === 0 && cfg.dev_bypass && (
          <>
            <div className="alert warn">尚未設定 auth-service client，使用本機開發登入（僅 development）。</div>
            <button className="primary" onClick={() => go()}>
              開發者登入
            </button>
          </>
        )}
        {cfg && cfg.protocols.length === 0 && !cfg.dev_bypass && (
          <div className="alert error">
            尚未設定 auth-service。請在 .env 設定 OIDC_CLIENT_ID／SECRET 或 OAUTH2_CLIENT_ID／SECRET，或本機開發時設 AUTH_DEV_BYPASS=true。
          </div>
        )}
        {!cfg && <p className="muted">連線 API 中…</p>}
      </div>
    </div>
  );
}
