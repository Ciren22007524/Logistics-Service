import { Worker, type Job } from 'bullmq';
import { config } from './config.js';
import { processCallback } from './domain/tracking/callbacks.js';
import { closeDb } from './infra/db/pool.js';
import { QUEUE, closeQueues, queue } from './infra/queue/queues.js';
import { closeRedis, newRedisConnection } from './infra/redis.js';
import { ensureBucket } from './infra/storage/s3.js';
import { alert } from './lib/alert.js';
import { logger } from './lib/logger.js';
import { startDispatcher } from './outbox/dispatcher.js';
import { cvsExpiryCheck, staleAlert } from './workers/daily-checks.js';
import { fetchLabel } from './workers/fetch-label.js';
import { pollShipment, scanForPolling } from './workers/poll-tracking.js';
import { submitShipment } from './workers/submit-shipment.js';

async function main() {
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

  // 排程（時區：Asia/Taipei）；upsertJobScheduler 可重入，多個 worker 啟動只會有一份
  const scheduled = queue(QUEUE.scheduled);
  const tz = 'Asia/Taipei';
  await scheduled.upsertJobScheduler('poll-scan', { pattern: c.POLL_TRACKING_CRON, tz }, { name: 'poll-scan' });
  await scheduled.upsertJobScheduler('stale-alert', { pattern: c.STALE_ALERT_CRON, tz }, { name: 'stale-alert' });
  await scheduled.upsertJobScheduler('cvs-expiry-check', { pattern: c.CVS_EXPIRY_CRON, tz }, { name: 'cvs-expiry-check' });

  const dispatcher = startDispatcher();
  logger.info({ env: c.APP_ENV }, 'worker started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    await dispatcher.stop();
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
