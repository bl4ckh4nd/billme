import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_SETTINGS, MOCK_SETTINGS } from './mockData';

describe('settings seeds', () => {
  it('keeps demo settings populated for demo and test callers', () => {
    strictEqual(MOCK_SETTINGS.company.name, 'Mustermann GmbH');
    strictEqual(MOCK_SETTINGS.numbers.nextInvoiceNumber, 104);
    strictEqual(MOCK_SETTINGS.numbers.nextOfferNumber, 42);
    strictEqual(MOCK_SETTINGS.numbers.nextCustomerNumber, 4);
    strictEqual(MOCK_SETTINGS.dashboard.monthlyRevenueGoal, 30000);
    strictEqual(MOCK_SETTINGS.catalog.categories.length, 4);
    strictEqual(MOCK_SETTINGS.dunning.levels.length, 3);
    strictEqual(MOCK_SETTINGS.automation.recurringEnabled, true);
  });

  it('keeps fresh workspace settings neutral until onboarding', () => {
    deepStrictEqual(DEFAULT_SETTINGS.company, {
      name: '',
      owner: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
      website: '',
    });
    deepStrictEqual(DEFAULT_SETTINGS.finance, {
      bankName: '',
      iban: '',
      bic: '',
      taxId: '',
      vatId: '',
      registerCourt: '',
    });
    deepStrictEqual(DEFAULT_SETTINGS.numbers, {
      invoicePrefix: 'RE-%Y-',
      nextInvoiceNumber: 1,
      numberLength: 3,
      offerPrefix: 'ANG-%Y-',
      nextOfferNumber: 1,
      customerPrefix: 'KD-',
      nextCustomerNumber: 1,
      customerNumberLength: 4,
    });
    deepStrictEqual(DEFAULT_SETTINGS.catalog.categories, []);
    deepStrictEqual(DEFAULT_SETTINGS.dunning.levels, []);
    strictEqual(DEFAULT_SETTINGS.dashboard.monthlyRevenueGoal, 0);
    strictEqual(DEFAULT_SETTINGS.automation.dunningEnabled, false);
    strictEqual(DEFAULT_SETTINGS.automation.recurringEnabled, false);
    strictEqual(DEFAULT_SETTINGS.onboardingCompleted, false);
  });
});
