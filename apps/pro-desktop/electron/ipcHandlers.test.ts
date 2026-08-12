import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetAccountingPolicy = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
    openExternal: vi.fn(),
  },
}));

vi.mock('./updater', () => ({
  getCurrentUpdateStatus: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}));

vi.mock('./dunningScheduler', () => ({ manualDunningRun: vi.fn() }));
vi.mock('./recurringScheduler', () => ({ manualRecurringRun: vi.fn() }));

vi.mock('@billme/accounting-engine', async () => {
  const actual = await vi.importActual<typeof import('@billme/accounting-engine')>('@billme/accounting-engine');
  return {
    ...actual,
    createProAccountingService: () => ({ getAccountingPolicy: mockGetAccountingPolicy }),
  };
});

import { registerIpcHandlers } from './ipcHandlers';
import { ipcRoutes } from '../ipc/contract';

describe('Pro accounting IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers and serves the typed authoritative policy route', async () => {
    const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, args: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const policy = {
      tenantId: 'default',
      activeChart: 'SKR04' as const,
      vatMethod: 'soll' as const,
      periodPolicy: 'calendar_month' as const,
      updatedAt: '2026-08-12T00:00:00.000Z',
    };
    mockGetAccountingPolicy.mockResolvedValue(policy);

    registerIpcHandlers(ipcMain as never, {
      requireDb: () => ({}) as never,
      getUserDataPath: () => '/tmp/billme-test',
      getMainWindow: () => null,
    });

    const channel = ipcRoutes['pro:getAccountingPolicy'].channel;
    const handler = handlers.get(channel);
    expect(handler).toBeDefined();
    await expect(handler?.(undefined, undefined)).resolves.toEqual(policy);
    expect(mockGetAccountingPolicy).toHaveBeenCalledWith();
  });
});
