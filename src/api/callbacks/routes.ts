import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RawCallback } from '../../carriers/carrier.interface.js';
import { MOCK_STORES } from '../../carriers/mock/mock.adapter.js';
import { config } from '../../config.js';
import { handleStoreSelection, renderStoreMap } from '../../domain/cvs/store-map.js';
import { receiveCallback } from '../../domain/tracking/callbacks.js';
import { HttpError } from '../../lib/errors.js';

function toRaw(req: FastifyRequest): RawCallback {
  return {
    headers: req.headers,
    query: req.query as Record<string, string>,
    contentType: req.headers['content-type'] ?? '',
    body: typeof req.body === 'string' ? req.body : req.body == null ? '' : JSON.stringify(req.body),
  };
}

/** 對外（物流商、使用者瀏覽器）公開的端點：body 一律保留原文字串，供驗簽與存檔 */
export async function publicRoutes(app: FastifyInstance) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));

  const handleCallback = async (req: FastifyRequest<{ Params: { carrier: string; accountId?: string } }>, reply: FastifyReply) => {
    const ack = await receiveCallback(req.params.carrier, req.params.accountId, toRaw(req));
    return reply.code(ack.status).type(ack.contentType ?? 'text/plain').send(ack.body);
  };
  app.post('/callbacks/:carrier', handleCallback);
  app.post('/callbacks/:carrier/:accountId', handleCallback);

  app.get<{ Params: { token: string } }>('/cvs/store-map/:token', async (req, reply) => {
    const r = await renderStoreMap(req.params.token);
    if ('redirect' in r) return reply.redirect(r.redirect);
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(r.html);
  });

  app.post<{ Params: { carrier: string } }>('/cvs/store-selection/:carrier', async (req, reply) => {
    const url = await handleStoreSelection(req.params.carrier, toRaw(req));
    return reply.redirect(url, 303);
  });

  // 模擬物流商的門市地圖頁（只有啟用 MOCK 時存在）
  if (config().mockCarrierEnabled) {
    app.get<{ Querystring: { reply?: string; state?: string; sub_type?: string } }>('/mock-carrier/store-map', async (req, reply) => {
      const { reply: replyUrl = '', state = '', sub_type = '' } = req.query;
      // 只允許送回本平台，避免被當成任意網站的表單跳板
      if (!replyUrl.startsWith(new URL('/cvs/store-selection/', config().PUBLIC_BASE_URL).toString()))
        throw new HttpError(400, 'bad_reply_url', 'reply url not allowed');
      const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
      const stores = MOCK_STORES.filter((s) => s.sub_type === sub_type);
      const items = stores
        .map(
          (s, i) => `<label class="store"><input type="radio" name="store_id" value="${esc(s.store_id)}" ${i === 0 ? 'checked' : ''}>
          <b>${esc(s.store_name ?? '')}</b><small>${esc(s.store_id)}・${esc(s.store_address ?? '')}</small></label>`,
        )
        .join('');
      return reply.type('text/html; charset=utf-8').send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>模擬門市地圖</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#1f2937}
.store{display:flex;flex-direction:column;gap:2px;border:1px solid #e5e7eb;border-radius:10px;padding:12px 12px 12px 36px;margin:8px 0;position:relative;cursor:pointer}
.store input{position:absolute;left:12px;top:16px}small{color:#6b7280}button{width:100%;padding:12px;border:0;border-radius:10px;background:#0f766e;color:#fff;font-size:16px;margin-top:12px}
.tag{display:inline-block;background:#fef3c7;color:#92400e;border-radius:6px;padding:2px 8px;font-size:12px}</style></head>
<body><span class="tag">SANDBOX</span><h2>模擬門市地圖（${esc(sub_type)}）</h2>
<form method="post" action="${esc(replyUrl)}"><input type="hidden" name="state" value="${esc(state)}">
${items || '<p>此類型沒有模擬門市</p>'}<button type="submit">選擇此門市</button></form></body></html>`);
    });
  }
}
