import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BusinessOnboarding, type BusinessOnboardingDraft } from '@billme/ui';

const initialData: BusinessOnboardingDraft = {
  company: { name: 'Muster', owner: 'Max', street: 'Hauptstr. 1', zip: '10115', city: 'Berlin', email: 'max@example.test', phone: '', website: '' },
  finance: { bankName: '', iban: '', bic: '', taxId: '', vatId: '', registerCourt: '' },
  legal: { smallBusinessRule: false, defaultVatRate: 19, paymentTermsDays: 14 },
  numbers: { invoicePrefix: 'RE-', offerPrefix: 'ANG-' },
};

describe('BusinessOnboarding reporting profile', () => {
  it('defaults GmbH to double-entry and persists the reporting profile', async () => {
    const onSubmit = vi.fn<(draft: BusinessOnboardingDraft) => Promise<void>>(async () => undefined);
    render(<BusinessOnboarding initialData={initialData} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Steuernummer'), { target: { value: '12/345/67890' } });
    fireEvent.change(screen.getByLabelText('Rechtsform'), { target: { value: 'gmbh' } });
    expect(screen.getByLabelText('Gewinnermittlung')).toHaveValue('double_entry');
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
