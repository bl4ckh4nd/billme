import React from 'react';
import {
  OnboardingWizard as ShellOnboardingWizard,
  type OnboardingWizardProps,
} from '@billme/desktop-ui';
import type { AppSettings, BusinessReportingProfile } from '../types';

type Props = Omit<OnboardingWizardProps, 'edition' | 'productName' | 'defaultReportingProfile'>;

// Lite is built for Einzelunternehmer: EÜR profitability, no chart of accounts.
const defaultReportingProfile = (settings: AppSettings): BusinessReportingProfile => ({
  jurisdiction: 'DE',
  legalForm: 'sole_proprietor',
  profitDetermination: 'eur',
  hgbSizeClass: undefined,
  fiscalYearStart: '01-01',
  chart: undefined,
  vatMethod: settings.legal.taxAccountingMethod ?? 'soll',
});

export const OnboardingWizard: React.FC<Props> = (props) => (
  <ShellOnboardingWizard
    {...props}
    edition="lite"
    productName="Billme"
    defaultReportingProfile={defaultReportingProfile}
  />
);
