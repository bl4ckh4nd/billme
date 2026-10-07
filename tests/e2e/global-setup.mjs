import { execFileSync } from 'node:child_process';
import { isServerModeE2E, startServerModeStack, stopServerModeStack } from './server/harness.mjs';

export default async function globalSetup() {
  if (process.env.E2E_SERVER_DEBUG === '1') {
    console.error('[global-setup]', JSON.stringify({ serverMode: isServerModeE2E() }));
  }
  if (isServerModeE2E()) {
    const state = await startServerModeStack();
    return async () => {
      await stopServerModeStack(state);
    };
  }

  if (process.env.E2E_SKIP_BUILD === '1') return;

  execFileSync('pnpm', ['-C', 'apps/desktop', 'build'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  execFileSync('pnpm', ['-C', 'apps/pro-desktop', 'build'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}
