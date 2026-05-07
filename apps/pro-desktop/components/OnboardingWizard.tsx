import React from 'react';
import {
  BusinessOnboarding,
  applyBusinessOnboardingDraft,
  buildBusinessOnboardingDraft,
  type BusinessOnboardingDraft,
} from '@billme/ui';
import type { AppSettings } from '../types';
import { useSetSettingsMutation } from '../hooks/useSettings';

interface OnboardingWizardProps {
  settings: AppSettings;
  onComplete: () => void;
}

export const OnboardingWizard: React.FC<OnboardingWizardProps> = ({ settings, onComplete }) => {
  const setSettingsMutation = useSetSettingsMutation();

  const initialData = React.useMemo<BusinessOnboardingDraft>(
    () => buildBusinessOnboardingDraft(settings),
    [settings],
  );

  const handleComplete = async (draft: BusinessOnboardingDraft) => {
    const updated: AppSettings = applyBusinessOnboardingDraft(settings, draft);
    await setSettingsMutation.mutateAsync(updated);
    onComplete();
  };

  return (
    <BusinessOnboarding
      initialData={initialData}
      onSubmit={handleComplete}
      saving={setSettingsMutation.isPending}
      productName="Billme Pro"
      submitLabel="Zu Angeboten und Rechnungen"
    />
  );
};
