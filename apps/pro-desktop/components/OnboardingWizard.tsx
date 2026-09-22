import React from 'react';
import {
  OnboardingWizard as ShellOnboardingWizard,
  type OnboardingWizardProps,
} from '@billme/desktop-ui';
import type { AppSettings, BusinessReportingProfile } from '../types';

type Props = Omit<OnboardingWizardProps, 'edition' | 'productName' | 'defaultReportingProfile'>;

// Pro books double entry. A GmbH or a register entry implies the small
// Kapitalgesellschaft class and the SKR03 chart.
const defaultReportingProfile = (settings: AppSettings): BusinessReportingProfile => {
  const isCorporation = /(?:GmbH|HRB)/i.test(`${settings.company.name} ${settings.finance.registerCourt}`);

  return {
    jurisdiction: 'DE',
    legalForm: isCorporation ? 'gmbh' : 'sole_proprietor',
    profitDetermination: 'double_entry',
    hgbSizeClass: isCorporation ? 'small' : undefined,
    fiscalYearStart: '01-01',
    chart: 'SKR03',
    vatMethod: settings.legal.taxAccountingMethod ?? 'soll',
  };
};

export const OnboardingWizard: React.FC<Props> = (props) => (
  <ShellOnboardingWizard
    {...props}
    edition="pro"
    productName="Billme Pro"
    defaultReportingProfile={defaultReportingProfile}
  />
);
