import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(4310),
  /** 對外網址（物流商回調、選店導回、OIDC callback 都以此為準） */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4310'),
  /** 後台前端網址；預設與 PUBLIC_BASE_URL 相同（由 API 直接提供 web/dist）。只有另開 Vite 開發伺服器時才需要設 */
  ADMIN_WEB_URL: z.string().url().optional(),
  /** 由 API 直接提供建置好的後台（web/dist）；預設開啟，設 false 關閉 */
  SERVE_WEB: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  /** 前端靜態檔位置，預設 ./web/dist */
  WEB_DIST_DIR: z.string().default('web/dist'),
  /** 在 API 程序內一併執行背景任務；預設開啟。分開部署 Worker（npm run start:worker）時設 false */
  RUN_WORKER: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  TRUST_PROXY: bool,

  DATABASE_URL: z.string().default('postgresql://logistics:logistics-local-only@127.0.0.1:25432/logistics'),
  REDIS_URL: z.string().default('redis://127.0.0.1:26379'),

  S3_ENDPOINT: z.string().default('http://127.0.0.1:29000'),
  /** 產生簽名網址給瀏覽器用的 endpoint（容器內外 host 可能不同） */
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('logistics-labels'),
  S3_ACCESS_KEY_ID: z.string().default('logistics'),
  S3_SECRET_ACCESS_KEY: z.string().default('logistics-local-only'),
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  LABEL_URL_TTL_SECONDS: z.coerce.number().int().default(300),

  /** 物流商金鑰 AES-256-GCM 金鑰（base64 32 bytes）；逗號分隔多把，第一把加密，其餘只解密（輪替用） */
  CREDENTIALS_ENC_KEYS: z.string().min(1, 'CREDENTIALS_ENC_KEYS 必填，可用 npm run gen:key 產生'),

  // --- OIDC（auth-service） ---
  OIDC_ISSUER: z.string().url().default('http://localhost:3000'),
  OIDC_CLIENT_ID: z.string().default(''),
  OIDC_CLIENT_SECRET: z.string().default(''),
  /** 必須與 auth-service 註冊的回呼完全相同；預設 PUBLIC_BASE_URL + /auth/callback */
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_SCOPES: z.string().default('openid email profile'),
  /**
   * OAuth 2.0 client（與 OIDC 共用 issuer、回呼網址與 discovery，只是另一組 client）。
   * scope 不含 openid：不發 ID token，身分改由 access token 呼叫 UserInfo 取得。
   */
  OAUTH2_CLIENT_ID: z.string().default(''),
  OAUTH2_CLIENT_SECRET: z.string().default(''),
  OAUTH2_SCOPES: z.string().default('email profile'),
  /** 有在 auth-service 登記 post_logout_redirect_uris 才設定；未設時「全站登出」不帶導回 */
  OIDC_POST_LOGOUT_REDIRECT_URI: z.string().url().optional(),
  /** 允許進後台的 email（白名單）；與 ADMIN_ROLES 任一符合即可 */
  ADMIN_EMAILS: list,
  /** auth-service UserInfo `roles` 中任一符合即可進後台 */
  ADMIN_ROLES: list,
  /** 僅 development/test：不經 auth-service 直接以開發者身分登入（沒有 OIDC client 時方便本機開發） */
  AUTH_DEV_BYPASS: bool,
  SESSION_TTL_SECONDS: z.coerce.number().int().default(8 * 3600),

  // --- Worker ---
  POLL_TRACKING_CRON: z.string().default('17 * * * *'),
  POLL_TRACKING_STALE_HOURS: z.coerce.number().default(2),
  STALE_ALERT_CRON: z.string().default('5 9 * * *'),
  CVS_EXPIRY_CRON: z.string().default('35 9 * * *'),
  STALE_READY_TO_SHIP_DAYS: z.coerce.number().default(3),
  CVS_PICKUP_DAYS: z.coerce.number().default(7),
  CVS_EXPIRY_WARN_DAYS: z.coerce.number().default(2),
  SUBMIT_MAX_ATTEMPTS: z.coerce.number().int().default(6),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().default(10_000),
  OUTBOX_POLL_MS: z.coerce.number().int().default(2_000),
  /** 告警另外 POST 到這裡（Slack／Discord 相容的 JSON {text}）；未設定只寫 log */
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  /** 允許 MOCK 物流商（本機模擬）；production 預設關閉 */
  ENABLE_MOCK_CARRIER: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

export type AuthProtocol = 'oidc' | 'oauth2';

export type Config = Omit<z.infer<typeof schema>, 'ADMIN_WEB_URL' | 'OIDC_REDIRECT_URI'> & {
  ADMIN_WEB_URL: string;
  OIDC_REDIRECT_URI: string;
  isProduction: boolean;
  mockCarrierEnabled: boolean;
  oidcEnabled: boolean;
  oauth2Enabled: boolean;
  /** 已設定的登入協議（登入頁依此顯示按鈕） */
  authProtocols: AuthProtocol[];
  devBypass: boolean;
  secureCookies: boolean;
};

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`環境變數設定錯誤：\n${msg}`);
  }
  const c = parsed.data;
  const isProduction = c.APP_ENV === 'production';
  return {
    ...c,
    ADMIN_WEB_URL: c.ADMIN_WEB_URL ?? c.PUBLIC_BASE_URL,
    OIDC_REDIRECT_URI: c.OIDC_REDIRECT_URI ?? new URL('/auth/callback', c.PUBLIC_BASE_URL).toString(),
    isProduction,
    mockCarrierEnabled: c.ENABLE_MOCK_CARRIER ?? !isProduction,
    oidcEnabled: Boolean(c.OIDC_CLIENT_ID && c.OIDC_CLIENT_SECRET),
    oauth2Enabled: Boolean(c.OAUTH2_CLIENT_ID && c.OAUTH2_CLIENT_SECRET),
    authProtocols: [
      ...(c.OIDC_CLIENT_ID && c.OIDC_CLIENT_SECRET ? (['oidc'] as const) : []),
      ...(c.OAUTH2_CLIENT_ID && c.OAUTH2_CLIENT_SECRET ? (['oauth2'] as const) : []),
    ],
    devBypass: c.AUTH_DEV_BYPASS && (c.APP_ENV === 'development' || c.APP_ENV === 'test'),
    secureCookies: c.PUBLIC_BASE_URL.startsWith('https://'),
  };
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

/** 測試用 */
export function setConfig(c: Config): void {
  cached = c;
}
