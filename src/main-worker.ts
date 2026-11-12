/** 獨立 Worker 程序：API 與 Worker 分開部署時使用（API 端設 RUN_WORKER=false）。 */
import { closeDb } from './infra/db/pool.js';
import { closeQueues } from './infra/queue/queues.js';
import { closeRedis } from './infra/redis.js';
import { logger } from './lib/logger.js';
import { startWorkers } from './workers/runtime.js';

async function main() {
  const workers = await startWorkers();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    await workers.stop();
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
