import React from 'react';
import { BusinessOnboarding, type BusinessOnboardingDraft } from '../components/BusinessOnboarding';
import type { AppSettings, BusinessReportingProfile } from '@billme/desktop-core/types';
import { useSetSettingsMutation } from '@billme/desktop-renderer/hooks/useSettings';

export interface OnboardingWizardProps {
  settings: AppSettings;
  onComplete: () => void;
  /** Edition shown inside the wizard. */
  edition: 'lite' | 'pro';
  productName: string;
  /**
   * Reporting profile a workspace without one starts from. Lite defaults to a
   * sole proprietor on EÜR, Pro to double-entry bookkeeping with SKR03, so the
   * product supplies the default instead of the wizard guessing it.
   */
  defaultReportingProfile: (settings: AppSettings) => BusinessReportingProfile;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({
  settings,
  onComplete,
  edition,
  productName,
  defaultReportingProfile,
}) => {
  const setSettingsMutation = useSetSettingsMutation();

  const initialData = React.useMemo<BusinessOnboardingDraft>(() => ({
    company: {
      name: settings.company.name,
      owner: settings.company.owner,
      street: settings.company.street,
      zip: settings.company.zip,
      city: settings.company.city,
      email: settings.company.email,
      phone: settings.company.phone,
      website: settings.company.website,
    },
    finance: {
      iban: settings.finance.iban,
      taxId: settings.finance.taxId,
      vatId: settings.finance.vatId,
      bankName: settings.finance.bankName,
      bic: settings.finance.bic,
      registerCourt: settings.finance.registerCourt,
    },
    legal: {
      smallBusinessRule: settings.legal.smallBusinessRule,
      defaultVatRate: settings.legal.defaultVatRate,
      paymentTermsDays: settings.legal.paymentTermsDays,
    },
    numbers: {
      invoicePrefix: settings.numbers.invoicePrefix,
      offerPrefix: settings.numbers.offerPrefix,
    },
    businessReportingProfile: settings.businessReportingProfile ?? defaultReportingProfile(settings),
  }), [defaultReportingProfile, settings]);

  const handleComplete = async (draft: BusinessOnboardingDraft) => {
    const updated: AppSettings = {
      ...settings,
      company: { ...settings.company, ...draft.company },
      finance: { ...settings.finance, ...draft.finance },
      legal: {
        ...settings.legal,
        ...draft.legal,
        defaultVatRate: draft.legal.defaultVatRate ?? settings.legal.defaultVatRate,
        paymentTermsDays: draft.legal.paymentTermsDays ?? settings.legal.paymentTermsDays,
        taxAccountingMethod: draft.businessReportingProfile?.vatMethod ?? settings.legal.taxAccountingMethod,
      },
      numbers: {
        ...settings.numbers,
        ...draft.numbers,
      },
      businessReportingProfile: draft.businessReportingProfile,
      onboardingCompleted: true,
      onboardingDraftSaved: false,
    };
    await setSettingsMutation.mutateAsync(updated);
    onComplete();
  };

  const handleSaveAndExit = async (draft: BusinessOnboardingDraft) => {
    await setSettingsMutation.mutateAsync({
      ...settings,
      company: { ...settings.company, ...draft.company },
      finance: { ...settings.finance, ...draft.finance },
      legal: {
        ...settings.legal,
        ...draft.legal,
        defaultVatRate: draft.legal.defaultVatRate ?? settings.legal.defaultVatRate,
        paymentTermsDays: draft.legal.paymentTermsDays ?? settings.legal.paymentTermsDays,
        taxAccountingMethod: draft.businessReportingProfile?.vatMethod ?? settings.legal.taxAccountingMethod,
      },
      numbers: { ...settings.numbers, ...draft.numbers },
      businessReportingProfile: draft.businessReportingProfile,
      onboardingCompleted: false,
      onboardingDraftSaved: true,
    });
  };

  return (
    <BusinessOnboarding
      initialData={initialData}
      onSubmit={handleComplete}
      onSaveAndExit={handleSaveAndExit}
      saving={setSettingsMutation.isPending}
      productName={productName}
      submitLabel="Zu Angeboten und Rechnungen"
      edition={edition}
    />
  );
};
