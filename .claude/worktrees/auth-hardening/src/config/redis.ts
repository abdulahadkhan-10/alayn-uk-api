import { createClient, type RedisClientOptions } from 'redis';
import { env } from './env';
import { logger } from './logger';

export const redisConnection = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
  ...(env.REDIS_TLS === 'true' ? { tls: {} } : {}),
  maxRetriesPerRequest: null, // Required by BullMQ
};

const options: RedisClientOptions = {
  socket: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    // Keep retrying forever with a capped, jittered back-off so sessions recover on their own
    // after a Redis restart instead of needing an app restart.
    reconnectStrategy: (retries: number) => Math.min(retries * 100, 3000) + Math.floor(Math.random() * 100),
    connectTimeout: 5000,
    ...(env.REDIS_TLS === 'true' ? { tls: true as const } : {}),
  } as RedisClientOptions['socket'],
  ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
};

export const redisClient = createClient(options);

let lastErrorAt = 0;
redisClient.on('error', (err) => {
  // A down Redis emits an error per reconnect attempt; log at most one every 10 s.
  const now = Date.now();
  if (now - lastErrorAt > 10_000) {
    lastErrorAt = now;
    logger.error(`Redis Client Error: ${err?.message || err}`);
  }
});
redisClient.on('ready', () => logger.info('Redis Client Ready'));
redisClient.on('end', () => logger.warn('Redis connection closed'));

// Auto-connect if not testing
if (env.NODE_ENV !== 'test') {
  redisClient.connect().catch((err) => logger.error(`Redis auto-connect failed: ${err?.message || err}`));
}
