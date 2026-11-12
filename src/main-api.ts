import { buildApp } from './api/app.js';
import { config } from './config.js';
import { closeDb } from './infra/db/pool.js';
import { closeQueues } from './infra/queue/queues.js';
import { closeRedis } from './infra/redis.js';
import { logger } from './lib/logger.js';

async function main() {
  const c = config();
  const app = await buildApp();
  await app.listen({ host: c.HOST, port: c.PORT });
  logger.info(
    { env: c.APP_ENV, url: c.PUBLIC_BASE_URL, oidc: c.oidcEnabled, dev_bypass: c.devBypass, mock_carrier: c.mockCarrierEnabled },
    'api started',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'api shutting down');
    await app.close();
    await closeQueues();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});
