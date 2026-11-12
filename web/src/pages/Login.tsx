import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';

const ERRORS: Record<string, string> = {
  forbidden: '此帳號沒有後台權限，請聯絡管理者把你的 email 或角色加入允許清單。',
  login_expired: '登入逾時，請重新登入。',
  callback_failed: '登入驗證失敗，請重試。',
  access_denied: '你已取消登入。',
};

export function LoginPage() {
  const [params] = useSearchParams();
  const [cfg, setCfg] = useState<{ configured: boolean; issuer: string | null; dev_bypass: boolean } | null>(null);
  const error = params.get('error');
  const returnTo = params.get('return_to') ?? '/';

  useEffect(() => {
    api<{ configured: boolean; issuer: string | null; dev_bypass: boolean }>('/auth/config').then(setCfg).catch(() => setCfg(null));
  }, []);

  const go = () => {
    window.location.href = `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="brand-mark">⬡</div>
        <h1>物流管理平台</h1>
        <p className="muted">後台登入</p>
        {error && <div className="alert error">{ERRORS[error] ?? `登入失敗（${error}）`}</div>}
        {cfg?.configured && (
          <>
            <button className="primary" onClick={go}>
              使用 auth-service 登入（OAuth 2.0）
            </button>
            <p className="muted" style={{ fontSize: 12 }}>{cfg.issuer}</p>
          </>
        )}
        {cfg && !cfg.configured && cfg.dev_bypass && (
          <>
            <div className="alert warn">尚未設定 OAuth 2.0 client，使用本機開發登入（僅 development）。</div>
            <button className="primary" onClick={go}>
              開發者登入
            </button>
          </>
        )}
        {cfg && !cfg.configured && !cfg.dev_bypass && (
          <div className="alert error">
            尚未設定 auth-service。請在 .env 設定 OAUTH2_CLIENT_ID / OAUTH2_CLIENT_SECRET，或本機開發時設 AUTH_DEV_BYPASS=true。
          </div>
        )}
        {!cfg && <p className="muted">連線 API 中…</p>}
      </div>
    </div>
  );
}
