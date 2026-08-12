import { TaxFilingAdapter } from '@billme/desktop-core/electron/tax-filing/adapter';

export const createProTaxFilingAdapter = (getUserDataPath: () => string): TaxFilingAdapter =>
  new TaxFilingAdapter({
    userDataPath: getUserDataPath(),
    resourcesPath: process.resourcesPath,
    binaryPath: process.env.BILLME_ERIC_BINARY,
  });
