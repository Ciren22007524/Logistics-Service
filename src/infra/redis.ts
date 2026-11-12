import { Redis } from 'ioredis';
import { config } from '../config.js';

let client: Redis | undefined;

export function redis(): Redis {
  client ??= new Redis(config().REDIS_URL, { maxRetriesPerRequest: null });
  return client;
}

/** BullMQ 每個 Queue/Worker 需要獨立連線 */
export function newRedisConnection(): Redis {
  return new Redis(config().REDIS_URL, { maxRetriesPerRequest: null });
}

export async function closeRedis(): Promise<void> {
  await client?.quit().catch(() => undefined);
  client = undefined;
}
