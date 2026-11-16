// main.ts — entrypoint. Binds an ephemeral port, registers it with the trial
// environment, then polls until the environment reports done and exits 0.
// When MAKEFUN_ENV_URL is unset, the server runs standalone on FORGE_PORT
// (or an ephemeral port) for local development and testing.

import { createForgeServer } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<void> {
  const url = envUrl.replace(/\/$/, '');
  const deadline = Date.now() + 20_000;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await fetch(`${url}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`registration rejected with ${response.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('registration rejected')) throw err;
      // The environment may not be listening yet; keep retrying.
    }
    if (Date.now() >= deadline) throw new Error('registration timed out');
    await sleep(Math.min(250 * 2 ** Math.min(attempt, 4), 2000));
  }
}

async function waitUntilDone(envUrl: string): Promise<void> {
  const url = envUrl.replace(/\/$/, '');
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await fetch(`${url}/done`, { method: 'GET' });
      if (response.ok) {
        const payload = (await response.json()) as { done?: boolean };
        if (payload.done === true) return;
      }
    } catch {
      // Transient network error; the environment answers /done immediately
      // when healthy, so retry with backoff.
    }
    await sleep(Math.min(250 * 2 ** Math.min(attempt, 3), 2000));
  }
}

async function main(): Promise<void> {
  const { server } = createForgeServer();
  const standalone = ENV_URL === '';
  const requestedPort = standalone ? Number(process.env.FORGE_PORT ?? process.env.PORT ?? 0) : 0;
  const port = Number.isFinite(requestedPort) && requestedPort >= 0 ? requestedPort : 0;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // No host: bind every interface, like the starter. The environment dials
    // the address the register request came from, which may not be loopback.
    server.listen(port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`forge listening on http://127.0.0.1:${boundPort}`);

  if (standalone) {
    // Local mode: serve forever until the process is stopped.
    return;
  }

  await register(ENV_URL, boundPort);
  await waitUntilDone(ENV_URL);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    setTimeout(resolve, 1000).unref();
  });
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
