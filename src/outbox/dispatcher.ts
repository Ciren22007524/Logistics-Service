import { config } from '../config.js';
import { hmacSha256 } from '../infra/crypto/secrets.js';
import { tx } from '../infra/db/pool.js';
import { alert } from '../lib/alert.js';
import { logger } from '../lib/logger.js';
import { nextRetryDelaySeconds, webhookEnvelope, type OutboxRow } from './outbox.js';

/** 上游驗簽：X-Signature = hex(HMAC-SHA256(raw body, webhook_secret)) */
export function signWebhook(secret: string, body: string): string {
  return hmacSha256(secret, body);
}

interface DispatchRow extends OutboxRow {
  webhook_url: string | null;
  webhook_secret: string;
}

export interface DispatchStats {
  sent: number;
  failed: number;
  dead: number;
  skipped: number;
}

/**
 * 取一批到期的 PENDING 事件投遞（FOR UPDATE SKIP LOCKED，多個 worker 可並行）。
 * 同一租戶的事件依 id 順序送；上游需以 event id 冪等。
 */
export async function dispatchBatch(limit = 20, fetchImpl: typeof fetch = fetch): Promise<DispatchStats> {
  const stats: DispatchStats = { sent: 0, failed: 0, dead: 0, skipped: 0 };
  await tx(async (c) => {
    const r = await c.query<DispatchRow>(
      `SELECT o.*, t.webhook_url, t.webhook_secret
       FROM outbox_events o JOIN tenants t ON t.id = o.tenant_id
       WHERE o.status = 'PENDING' AND o.next_retry_at <= now()
       ORDER BY o.id
       LIMIT $1
       FOR UPDATE OF o SKIP LOCKED`,
      [limit],
    );
    for (const row of r.rows) {
      if (!row.webhook_url) {
        await c.query(
          `UPDATE outbox_events SET status = 'SENT', sent_at = now(), last_error = 'skipped: tenant has no webhook_url' WHERE id = $1`,
          [row.id],
        );
        stats.skipped++;
        continue;
      }
      const body = JSON.stringify(webhookEnvelope(row));
      const timestamp = String(Math.floor(Date.now() / 1000));
      let error: string | null = null;
      try {
        const res = await fetchImpl(row.webhook_url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'logistics-service-webhook/1',
            'x-event-id': `evt_${row.id}`,
            'x-event-type': row.event_type,
            'x-timestamp': timestamp,
            'x-signature': signWebhook(row.webhook_secret, body),
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(config().WEBHOOK_TIMEOUT_MS),
        });
        if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
        await res.body?.cancel().catch(() => undefined);
      } catch (err) {
        error = (err as Error).name === 'TimeoutError' ? 'timeout' : (err as Error).message;
      }

      const attempts = row.attempt_count + 1;
      if (!error) {
        await c.query(
          `UPDATE outbox_events SET status = 'SENT', sent_at = now(), attempt_count = $2, last_error = NULL WHERE id = $1`,
          [row.id, attempts],
        );
        stats.sent++;
        continue;
      }
      const delay = nextRetryDelaySeconds(attempts);
      if (delay === null) {
        await c.query(`UPDATE outbox_events SET status = 'DEAD', attempt_count = $2, last_error = $3 WHERE id = $1`, [
          row.id,
          attempts,
          error,
        ]);
        stats.dead++;
        await alert('webhook_dead', `Webhook 投遞重試用盡：evt_${row.id}`, {
          tenant_id: row.tenant_id,
          event_type: row.event_type,
          error,
        });
      } else {
        await c.query(
          `UPDATE outbox_events SET attempt_count = $2, last_error = $3,
             next_retry_at = now() + make_interval(secs => $4) WHERE id = $1`,
          [row.id, attempts, error, delay],
        );
        stats.failed++;
        logger.warn({ event_id: row.id, attempts, error, retry_in_s: delay }, 'webhook delivery failed');
      }
    }
  });
  return stats;
}

/** 持續輪詢直到 stop() */
export function startDispatcher(intervalMs = config().OUTBOX_POLL_MS): { stop: () => Promise<void> } {
  let stopped = false;
  let current: Promise<unknown> = Promise.resolve();
  const loop = async () => {
    while (!stopped) {
      try {
        current = dispatchBatch();
        const s = (await current) as DispatchStats;
        // 有滿批就馬上再跑
        if (s.sent + s.failed + s.dead + s.skipped >= 20) continue;
      } catch (err) {
        logger.error({ err }, 'outbox dispatch loop error');
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };
  void loop();
  return {
    stop: async () => {
      stopped = true;
      await current.catch(() => undefined);
    },
  };
}
