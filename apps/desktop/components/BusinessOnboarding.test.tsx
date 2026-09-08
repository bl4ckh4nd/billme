import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BusinessOnboarding, type BusinessOnboardingDraft } from '@billme/ui';

const initialData: BusinessOnboardingDraft = {
  company: { name: 'Muster', owner: 'Max', street: 'Hauptstr. 1', zip: '10115', city: 'Berlin', email: 'max@example.test', phone: '', website: '' },
  finance: { bankName: '', iban: '', bic: '', taxId: '12/345/67890', vatId: '', registerCourt: '' },
  legal: { smallBusinessRule: false, defaultVatRate: 19, paymentTermsDays: 14 },
  numbers: { invoicePrefix: 'RE-', offerPrefix: 'ANG-' },
  businessReportingProfile: {
    jurisdiction: 'DE',
    legalForm: 'sole_proprietor',
    profitDetermination: 'eur',
    fiscalYearStart: '01-01',
    vatMethod: 'soll',
  },
};

describe('BusinessOnboarding reporting profile', () => {
  it('defaults GmbH to double-entry and persists the reporting profile', async () => {
    const onSubmit = vi.fn<(draft: BusinessOnboardingDraft) => Promise<void>>(async () => undefined);
    render(<BusinessOnboarding initialData={initialData} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    const legalForm = document.getElementById('onboarding-reporting-legal-form') as HTMLSelectElement;
    const profitDetermination = document.getElementById('onboarding-reporting-profit-determination') as HTMLSelectElement;
    fireEvent.change(legalForm, { target: { value: 'gmbh' } });
    expect(profitDetermination).toHaveValue('double_entry');
    fireEvent.click(screen.getByRole('button', { name: /Weiter zu Weitere Angaben/i }));
    fireEvent.click(screen.getByRole('button', { name: /Einrichtung abschließen/i }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]?.[0].businessReportingProfile).toMatchObject({
      jurisdiction: 'DE',
      legalForm: 'gmbh',
      profitDetermination: 'double_entry',
      hgbSizeClass: 'micro',
      chart: 'SKR03',
      fiscalYearStart: '01-01',
      vatMethod: 'soll',
    });
  });
});
