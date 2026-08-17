import { loadEnv } from './env.ts';
import { buildServer } from './server.ts';

const env = loadEnv();
const app = await buildServer(env);

// 0.0.0.0, not localhost — inside a container the loopback binding is not
// reachable from the platform's health checker and the deploy hangs.
await app.listen({ port: env.PORT, host: '0.0.0.0' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`${signal} received, closing`);
    void app.close().then(() => process.exit(0));
  });
}
