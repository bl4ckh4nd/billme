import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOCK_SETTINGS } from '@billme/desktop-services/mockData';

const { strictJsonParseMock, loggerErrorMock } = vi.hoisted(() => ({
  strictJsonParseMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('@billme/desktop-data/validation-schemas', async () => {
  const actual = await vi.importActual<typeof import('@billme/desktop-data/validation-schemas')>(
    '@billme/desktop-data/validation-schemas',
  );
  return {
    ...actual,
    strictJsonParse: strictJsonParseMock,
  };
});

vi.mock('@billme/desktop-core/utils/logger', () => ({
  logger: {
    error: loggerErrorMock,
  },
}));

import { getSettings, setSettings } from './settingsRepo';

type FakeDb = {
  prepare: (sql: string) => {
    get: () => { settings_json: string } | undefined;
    run: (args?: unknown) => void;
  };
};

const makeDb = (row?: { settings_json: string }) => {
  const runMock = vi.fn();
  const prepareMock = vi.fn((sql: string) => ({
    get: () => (sql.includes('SELECT') ? row : undefined),
    run: runMock,
  }));

  return {
    db: { prepare: prepareMock } as unknown as FakeDb,
    runMock,
    prepareMock,
  };
};

describe('settingsRepo', () => {
  beforeEach(() => {
    strictJsonParseMock.mockReset();
    loggerErrorMock.mockReset();
  });

  it('returns null when no settings row exists', () => {
    const { db } = makeDb();
    expect(getSettings(db as any)).toBeNull();
    expect(strictJsonParseMock).not.toHaveBeenCalled();
  });

  it('returns parsed settings when JSON is valid', () => {
    const { db } = makeDb({ settings_json: '{"some":"json"}' });
    strictJsonParseMock.mockReturnValue(structuredClone(MOCK_SETTINGS));

    const result = getSettings(db as any);

    expect(result).toEqual(MOCK_SETTINGS);
    expect(strictJsonParseMock).toHaveBeenCalledTimes(1);
  });

  it('returns null and logs when parsing fails', () => {
    const { db } = makeDb({ settings_json: '{"broken":true}' });
    const parseError = new Error('invalid payload');
    strictJsonParseMock.mockImplementation(() => {
      throw parseError;
    });

    const result = getSettings(db as any);

    expect(result).toBeNull();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'SettingsRepo',
      'Failed to parse settings, returning null',
      parseError,
    );
  });

  it('normalizes missing optional sections for backward compatibility', () => {
    const { db } = makeDb({ settings_json: '{"legacy":true}' });
    strictJsonParseMock.mockReturnValue({
      company: MOCK_SETTINGS.company,
      finance: MOCK_SETTINGS.finance,
      dunning: { levels: [{ ...MOCK_SETTINGS.dunning.levels[0], enabled: undefined }] },
      legal: MOCK_SETTINGS.legal,
      catalog: MOCK_SETTINGS.catalog,
    });

    const result = getSettings(db as any);
    expect(result).not.toBeNull();

    expect(result?.portal).toEqual({ baseUrl: '' });
    expect(result?.eInvoice).toEqual({
      enabled: false,
      standard: 'zugferd-en16931',
      profile: 'EN16931',
      version: '2.3',
    });
    expect(result?.email?.provider).toBe('none');
    expect(result?.numbers?.customerPrefix).toBe('KD-');
    expect(result?.automation?.recurringRunTime).toBe('03:00');
    expect(result?.dashboard?.monthlyRevenueGoal).toBe(30000);
    expect(result?.dunning.levels[0]?.enabled).toBe(true);
  });

  it('normalizes malformed optional section values', () => {
    const { db } = makeDb({ settings_json: '{"legacy":true}' });
    strictJsonParseMock.mockReturnValue({
      ...structuredClone(MOCK_SETTINGS),
      portal: { baseUrl: 123 as unknown as string },
      eInvoice: {
        enabled: 'yes' as unknown as boolean,
        standard: 'wrong',
        profile: 'wrong',
        version: '1.0',
      },
      numbers: {
        ...structuredClone(MOCK_SETTINGS.numbers),
        customerPrefix: 123,
        nextCustomerNumber: Number.NaN,
        customerNumberLength: Number.POSITIVE_INFINITY,
      },
      automation: {
        ...structuredClone(MOCK_SETTINGS.automation),
        recurringEnabled: 'no' as unknown as boolean,
        recurringRunTime: 700 as unknown as string,
      },
    });

    const result = getSettings(db as any);
    expect(result).not.toBeNull();

    expect(result?.portal.baseUrl).toBe('');
    expect(result?.eInvoice).toEqual({
      enabled: false,
      standard: 'zugferd-en16931',
      profile: 'EN16931',
      version: '2.3',
    });
    expect(result?.numbers.customerPrefix).toBe('KD-');
    expect(result?.numbers.nextCustomerNumber).toBe(1);
    expect(result?.numbers.customerNumberLength).toBe(4);
    expect(result?.automation.recurringEnabled).toBe(false);
    expect(result?.automation.recurringRunTime).toBe('03:00');
  });

  it('upserts settings as JSON string', () => {
    const { db, runMock, prepareMock } = makeDb();
    setSettings(db as any, MOCK_SETTINGS);

    expect(prepareMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO settings'));
    expect(runMock).toHaveBeenCalledWith({ json: JSON.stringify(MOCK_SETTINGS) });
  });
});
