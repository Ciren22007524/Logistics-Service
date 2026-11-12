import { Worker, type Job } from 'bullmq';
import { config } from '../config.js';
import { processCallback } from '../domain/tracking/callbacks.js';
import { QUEUE, queue } from '../infra/queue/queues.js';
import { newRedisConnection } from '../infra/redis.js';
import { ensureBucket } from '../infra/storage/s3.js';
import { alert } from '../lib/alert.js';
import { logger } from '../lib/logger.js';
import { startDispatcher } from '../outbox/dispatcher.js';
import { cvsExpiryCheck, staleAlert } from './daily-checks.js';
import { fetchLabel } from './fetch-label.js';
import { pollShipment, scanForPolling } from './poll-tracking.js';
import { submitShipment } from './submit-shipment.js';

/**
 * 啟動所有背景任務（佇列 worker、排程、outbox 投遞）。
 * 可在獨立的 Worker 程序（main-worker.ts）或 API 程序內（RUN_WORKER=true）執行；
 * 任務都可重入，多個程序同時跑也不會重複處理。回傳 stop() 供關機時呼叫。
 */
export async function startWorkers(): Promise<{ stop: () => Promise<void> }> {
  const c = config();
  await ensureBucket().catch((err) => logger.warn({ err }, 'ensure bucket failed (will retry on upload)'));

  const workers: Worker[] = [];
  const add = <T>(name: string, fn: (job: Job<T>) => Promise<unknown>, concurrency = 5) => {
    const w = new Worker<T>(name, fn, { connection: newRedisConnection(), concurrency });
    w.on('failed', (job, err) => {
      const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
      logger.warn({ queue: name, job_id: job?.id, attempts: job?.attemptsMade, err: err.message, final }, 'job failed');
      if (final) void alert(`${name}_failed`, `${name} 任務重試用盡：${err.message}`, { job_id: job?.id, data: job?.data });
    });
    workers.push(w);
  };

  add<{ shipmentId: string }>(QUEUE.submitShipment, (j) => submitShipment(j.data.shipmentId));
  add<{ shipmentId: string }>(QUEUE.fetchLabel, (j) => fetchLabel(j.data.shipmentId, j.name === 'label-force'));
  add<{ callbackId: string }>(QUEUE.processCallback, (j) => processCallback(j.data.callbackId), 10);
  add<{ shipmentId: string }>(QUEUE.pollTracking, (j) => pollShipment(j.data.shipmentId), 3);
  add(
    QUEUE.scheduled,
    async (j) => {
      if (j.name === 'poll-scan') return scanForPolling();
      if (j.name === 'stale-alert') return staleAlert();
      if (j.name === 'cvs-expiry-check') return cvsExpiryCheck();
      return null;
    },
    1,
  );

  // 排程（時區：Asia/Taipei）；upsertJobScheduler 可重入，多個程序啟動只會有一份
  const scheduled = queue(QUEUE.scheduled);
  const tz = 'Asia/Taipei';
  await scheduled.upsertJobScheduler('poll-scan', { pattern: c.POLL_TRACKING_CRON, tz }, { name: 'poll-scan' });
  await scheduled.upsertJobScheduler('stale-alert', { pattern: c.STALE_ALERT_CRON, tz }, { name: 'stale-alert' });
  await scheduled.upsertJobScheduler('cvs-expiry-check', { pattern: c.CVS_EXPIRY_CRON, tz }, { name: 'cvs-expiry-check' });

  const dispatcher = startDispatcher();
  logger.info({ env: c.APP_ENV }, 'workers started');

  return {
    stop: async () => {
      await dispatcher.stop();
      await Promise.all(workers.map((w) => w.close()));
    },
  };
}
