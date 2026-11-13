# Logistics-Service 物流管理平台

獨立的物流服務：對內提供統一 API，對外串接多家物流商。上游（電商／ERP／後台）只認得平台的 Shipment 與狀態，不需要知道各家物流商的差異。

- 後端：Node.js 22 + TypeScript + Fastify，PostgreSQL、Redis（BullMQ）、S3 相容儲存（MinIO）
- 前端：React + Vite 後台（`web/`），登入串 [auth-service](https://github.com/Ciren22007524/auth-service) 標準 OIDC
- 物流商：`ECPAY_CVS`（綠界超商取貨，7-11／全家／萊爾富／OK）、`MOCK`（本機模擬，宅配＋超商）

## 連接埠（避開本機既有服務）

auth-service 本機用 `3000`、`5432`、`16379`，本服務全部改用以下連接埠，可在 `.env` 覆寫：

| 服務 | 主機連接埠 | 覆寫變數 |
| --- | --- | --- |
| PostgreSQL | `25432` | `LOGISTICS_PG_PORT` |
| Redis | `26379` | `LOGISTICS_REDIS_PORT` |
| MinIO S3 API／Console | `29000`／`29001` | `LOGISTICS_MINIO_PORT`／`LOGISTICS_MINIO_CONSOLE` |
| 後端伺服器（API＋後台頁面） | `4310` | `PORT`（compose：`LOGISTICS_API_PORT`） |
| （選用）Vite 熱更新 | `5310` | `LOGISTICS_WEB_PORT` |

## 本機開發

前端會建置成靜態檔（`web/dist`），由後端直接提供；背景任務預設也在同一個程序內執行。**只要開後端伺服器一個程序**，瀏覽器開 `http://localhost:4310` 就是後台。

```bash
npm install                   # npm workspaces：一次裝好後端與前端套件
cp .env.example .env          # 填 CREDENTIALS_ENC_KEYS（npm run gen:key）
docker compose up -d --wait   # PostgreSQL、Redis、MinIO
npm run db:migrate
npm run db:seed               # 建立租戶、API key、MOCK 與綠界測試帳號（印出一次 API key）
npm run dev                   # 建置前端後啟動後端（程式改動自動重啟）→ http://localhost:4310
```

正式環境：`npm run build`（後端＋前端）後 `npm start`。

| 情境 | 做法 |
| --- | --- |
| 改了前端，想看結果 | `npm run build:web`，重新整理頁面即可（後端不用重開） |
| 前端要熱更新 | 另開 `npm run dev:web`（`5310`），並在 `.env` 設 `ADMIN_WEB_URL=http://localhost:5310`、`OIDC_REDIRECT_URI=http://localhost:5310/auth/callback` |
| Worker 分開部署 | 後端設 `RUN_WORKER=false`，另跑 `npm run start:worker`（任務可重入，多個程序同時跑也不會重複處理） |
| 不提供後台頁面 | `SERVE_WEB=false` |

整套用容器跑：`docker compose --profile app up --build -d`（API 容器提供後台，Worker 另一個容器）。

## 登入：串接 auth-service（OAuth 2.0）

> 這是 **`oauth2` 分支**：與 `main` 平行、不合併，只有登入改用純 OAuth 2.0，其餘程式都和 `main` 相同。`main` 是 OIDC 版本。兩個分支共用同一份 `.env`，在 auth-service 各註冊一個 client 即可切換比較。

| 項目 | `main`（OIDC） | `oauth2`（本分支） |
| --- | --- | --- |
| `.env` client | `OIDC_CLIENT_ID`／`OIDC_CLIENT_SECRET` | `OAUTH2_CLIENT_ID`／`OAUTH2_CLIENT_SECRET` |
| 請求 scope | `openid email profile` | `email profile`（程式保證不送 `openid`） |
| nonce／ID token | 有，驗 RS256 簽章、iss、aud、exp、nonce | 沒有 |
| 身分來源 | ID token 的 `sub`（再以 UserInfo 補資料） | Bearer access token 呼叫 auth-service 的使用者資料 API（RFC 6750） |
| 端點來源 | OIDC Discovery（`/.well-known/openid-configuration`） | 依 auth-service 文件明確設定，不讀 Discovery |
| 實作 | `openid-client` | 不用任何 OIDC 函式庫，以 `fetch` 依 RFC 6749／7636／6750／7009／9207 實作 |
| 登出 | 撤銷 token；全站登出帶 `id_token_hint`（OIDC RP-Initiated Logout） | 撤銷 access token（RFC 7009）；沒有全站登出 |
| 共通 | Authorization Code + PKCE S256 + state、`client_secret_basic`、同一個回呼、`roles` 來自 UserInfo、相同後台授權規則 | 同左 |

後台採 BFF 模式：授權碼交換與 token 都在後端，瀏覽器只拿 HttpOnly、SameSite=Lax 的 session cookie（存在 Redis）。

1. 到 auth-service 的 `/register` 用 Google 登入，串接方式選**後端**（`client_secret_basic`），scope 勾 `email`、`profile`
2. 回呼網址填 `http://localhost:4310/auth/callback`（正式環境填 `https://<網域>/auth/callback`）；預設是 `PUBLIC_BASE_URL` + `/auth/callback`，必須完全一致
3. 把 client ID／secret 填到 `.env` 的 `OAUTH2_CLIENT_ID`、`OAUTH2_CLIENT_SECRET`（secret 只放 `.env`／Secret 管理，不進版控）
4. 設定誰能進後台：`ADMIN_EMAILS`（已驗證 email 白名單）或 `ADMIN_ROLES`（auth-service 管理者在該 client 設的 `roles`）。兩者都空時，非 production 放行所有登入者，production 一律拒絕

**Refresh token（預設關閉，由設定決定）**：OAuth 2.0 沒規定怎麼申請 refresh token；auth-service 的條件是 scope 含 `offline_access` 且帶 `prompt=consent`（名稱來自 OIDC 規格），所以程式不寫死，要用時自己在 `.env` 設：

```
OAUTH2_SCOPES=email profile offline_access
OAUTH2_PROMPT=consent
```

auth-service 那邊註冊的 client 也要勾 `offline_access`。拿到 refresh token 後的行為與 `main` 相同：access token 剩不到 60 秒時，下一個後台請求自動換新（RFC 6749 §6）並重新呼叫使用者資料 API 同步角色；同一個 session 用 Redis 鎖只換一次；輪替的 refresh token 會換掉舊的；被拒絕就刪 session 要重新登入；auth-service 連不上回 `503`；登出撤銷 refresh token 與 access token。沒設定就維持原本行為（角色停在登入當下，直到 `SESSION_TTL_SECONDS` 到期）。

**保證不混用 OIDC**：`test/unit/oauth2.test.ts` 檢查登入程式不 import 任何 OIDC 函式庫、授權網址不含 `openid`／nonce、收到 ID token 直接拒絕；`test/e2e/sso.test.ts` 記錄授權伺服器收到的每個請求，確認沒有碰 Discovery、JWKS、end_session。auth-service 的端點都在 `/oidc/` 前綴底下只是路徑命名，不帶 `openid` 的 token 呼叫 `/oidc/userinfo` 時，auth-service 走的是它自訂的 OAuth 使用者資料 API。

auth-service 的 `subject_type` 是 public，同一個使用者在兩個 client 拿到相同的 `sub`，兩個分支的資料可以用同一個主鍵對應。

還沒註冊 client 時，本機可設 `AUTH_DEV_BYPASS=true` 直接以開發者身分登入（只在 `APP_ENV=development/test` 生效）。

## 上游 API（`/v1`）

認證 `Authorization: Bearer <api_key>`；所有 POST 必帶 `Idempotency-Key`。

| Method | Path | 說明 |
| --- | --- | --- |
| `POST` | `/v1/shipments` | 建單（非同步，回 `202`；同 key 重送回 `200` 同一筆，內容不同回 `409`） |
| `GET` | `/v1/shipments?external_ref=&status=&from=&to=&cursor=&limit=` | 列表，cursor 分頁 |
| `GET` | `/v1/shipments/{id}` | 單筆 |
| `GET` | `/v1/shipments/{id}/tracking` | 軌跡（含原始狀態碼、是否推進狀態） |
| `GET` | `/v1/shipments/{id}/label` | `302` 到 5 分鐘簽名網址 |
| `POST` | `/v1/labels/batch` | `{ shipment_ids: [] }` 合併 PDF（綠界 HTML 標籤列在 `x-labels-skipped`） |
| `POST` | `/v1/shipments/{id}/cancel` | 交寄前取消 |
| `POST` | `/v1/shipments/{id}/retry` | `FAILED` 重新送出 |
| `GET` | `/v1/cvs/store-map?carrier=&sub_type=&return_url=` | 取得選店網址；選完 `303` 導回 `return_url?store_id=&store_name=&store_address=&sub_type=&carrier_code=` |
| `GET` | `/v1/carriers` | 可用物流商與 capabilities |

`return_url` 的來源必須登記在租戶的「選店導回來源」（後台設定），避免 open redirect。

```bash
curl -X POST http://localhost:4310/v1/shipments \
  -H "Authorization: Bearer $API_KEY" -H "Idempotency-Key: ORD-20261112-0001" \
  -H 'content-type: application/json' \
  -d '{"external_ref":"ORD-20261112-0001","service_type":"HOME_DELIVERY",
       "recipient":{"name":"王小明","phone":"0912345678","zip":"330","address":"桃園市桃園區某某路1號"},
       "declared_value":1500,"items_summary":"服飾一批","metadata":{"channel":"web"}}'
```

### Webhook（平台 → 上游）

事件：`shipment.status_changed`、`shipment.label_ready`、`shipment.failed`、`shipment.exception`、`shipment.cvs_pickup_expiring`（到店接近取貨期限）。

- `X-Signature` = hex(HMAC-SHA256(原始 body, webhook_secret))，另帶 `X-Timestamp`、`X-Event-Id`
- 回 2xx 視為成功；否則 1m → 5m → 30m → 2h → 6h → 24h 重試，用盡標記 `DEAD` 並告警，可在後台重送
- 上游以 `id`（`evt_…`）做冪等，並檢查 `X-Timestamp` 是否在可接受範圍

```js
const ok = crypto.createHmac('sha256', secret).update(rawBody).digest('hex') === req.headers['x-signature'];
```

### 物流商回調（物流商 → 平台）

`POST /callbacks/{carrier_code}/{carrier_account_id}`（建單時自動帶給物流商；也接受規格的 `/callbacks/{carrier_code}`）：原文寫入 `carrier_callbacks` → 驗簽 → 進佇列 → 依物流商格式立即回應（綠界 `1|OK`）。物流商必須連得到 `PUBLIC_BASE_URL`；本機測真實回調需 ngrok／cloudflared。

## 狀態機

`CREATED → LABEL_PENDING（已取號）→ READY_TO_SHIP（標籤已存）→ PICKED_UP → IN_TRANSIT → OUT_FOR_DELIVERY（宅配）／ARRIVED_AT_STORE（超商）→ DELIVERED`，例外 `EXCEPTION`、`RETURNING → RETURNED`，終態 `DELIVERED`／`RETURNED`／`CANCELLED`／`FAILED`。

- 物流商漏報中間狀態時允許往前跳，不允許往回走；比「已套用的最新事件」還舊的回調只保留軌跡（亂序保護）
- 狀態更新與 outbox 事件同一個 transaction；所有 worker 任務可重入
- 綠界狀態碼對照在 `src/carriers/ecpay-cvs/status-map.ts`，未列的代碼只記錄、不推進。**上線前請以綠界最新狀態碼表核對**

## 背景任務（預設在後端程序內；`RUN_WORKER=false` 時改用 `npm run start:worker`）

| 任務 | 觸發 |
| --- | --- |
| `submit-shipment` | 建單後；可重試錯誤指數退避，驗證／認證錯誤直接 `FAILED` |
| `fetch-label` | 取號後；標籤存 S3，發 `shipment.label_ready` |
| `process-callback` | 回調驗簽後 |
| `poll-scan` | `POLL_TRACKING_CRON`：查詢久未更新的單，並補送卡住的 CREATED／缺標籤的單 |
| outbox dispatcher | 持續輪詢（`FOR UPDATE SKIP LOCKED`，可多個 worker） |
| `stale-alert`、`cvs-expiry-check` | 每日（Asia/Taipei） |

告警寫結構化 log（`alert: true`），設 `ALERT_WEBHOOK_URL` 可另外推播。

## 後台（`web/`）

總覽、託運單查詢與篩選、詳細頁（軌跡時間軸、webhook 事件、回調原文、操作紀錄）、取消／重送／重新取標籤、合併列印、MOCK 狀態模擬、建立測試單（含門市地圖選店）、Webhook 重送、租戶／API key／webhook secret 管理、物流商帳號。

## 測試與檢查

```bash
npm run typecheck && npm run lint
npm test   # 單元測試；設 TEST_DATABASE_URL、TEST_REDIS_URL 時另跑整合測試
```

整合測試會清空測試資料庫的 public schema，所以先另建專用的 `logistics_test`：

```bash
docker compose exec postgres createdb -U logistics logistics_test
```

```bash
TEST_DATABASE_URL=postgresql://logistics:logistics-local-only@127.0.0.1:25432/logistics_test TEST_REDIS_URL=redis://127.0.0.1:26379/15 CREDENTIALS_ENC_KEYS=$(npm run -s gen:key) npm test
```

> ⚠️ 不要把 `TEST_DATABASE_URL` 指向開發用的 `logistics` 資料庫。

## 安全與營運

- 物流商金鑰 AES-256-GCM 應用層加密；輪替：新金鑰放 `CREDENTIALS_ENC_KEYS` 第一把 → `npm run credentials:rotate` → 移除舊金鑰
- log 遮罩收件人、Authorization、cookie、金鑰欄位；API key 只存 sha256
- 非 production 禁止使用 `is_sandbox=false` 的帳號；production 預設停用 MOCK

## 目前限制／下一步

- 宅配直連物流商（黑貓、新竹）尚未實作：需要合約與各家 API 文件，新增方式為實作 `CarrierAdapter` 並在 `carrier.registry.ts` 註冊
- 綠界 adapter 依官方文件格式實作並以 fixtures 測試，**尚未對綠界沙箱實際連線驗證**（開發環境無法連外）
- 綠界 B2C 無取消 API；C2C 僅 7-11 可透過 API 取消
- 郵遞區號自動補齊尚未內建對照表（目前只從地址前綴擷取）
- 規格第 13 節的待確認事項（貨到付款對帳、冷鏈、拆包裹、逆物流、標籤印表機規格）仍待決定

規格原文見開工文件 v0.1。
