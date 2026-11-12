/**
 * 後端伺服器：API、物流商回調、後台前端（web/dist），預設也在同一個程序內跑背景任務。
 * 只要啟動這一個程序即可使用；要分開部署 Worker 時設 RUN_WORKER=false 並另外啟動 main-worker。
 */
import { buildApp } from './api/app.js';
import { config } from './config.js';
import { closeDb } from './infra/db/pool.js';
import { closeQueues } from './infra/queue/queues.js';
import { closeRedis } from './infra/redis.js';
import { logger } from './lib/logger.js';
import { startWorkers } from './workers/runtime.js';

async function main() {
  const c = config();
  const app = await buildApp();
  await app.listen({ host: c.HOST, port: c.PORT });
  const workers = c.RUN_WORKER ? await startWorkers() : null;
  logger.info(
    {
      env: c.APP_ENV,
      url: c.PUBLIC_BASE_URL,
      oauth2: c.oauth2Enabled,
      dev_bypass: c.devBypass,
      mock_carrier: c.mockCarrierEnabled,
      embedded_worker: Boolean(workers),
    },
    `server started: ${c.PUBLIC_BASE_URL}`,
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'server shutting down');
    await app.close();
    await workers?.stop();
    await closeQueues();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'server failed to start');
  process.exit(1);
});
