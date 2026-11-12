import { config } from '../config.js';
import { logger } from './logger.js';

/** 告警：一律寫結構化 log（alert=true），有設定 ALERT_WEBHOOK_URL 時另外推播。 */
export async function alert(kind: string, message: string, detail: Record<string, unknown> = {}): Promise<void> {
  logger.error({ alert: true, alert_kind: kind, ...detail }, message);
  const url = config().ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `[logistics][${kind}] ${message}`, detail }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    logger.warn({ err }, 'alert webhook failed');
  }
}
