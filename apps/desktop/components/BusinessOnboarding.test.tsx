import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BusinessOnboarding, type BusinessOnboardingDraft } from '@billme/desktop-ui';

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
    render(<BusinessOnboarding initialData={initialData} onSubmit={onSubmit} edition="pro" />);

    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    const legalForm = document.getElementById('onboarding-reporting-legal-form') as HTMLSelectElement;
    fireEvent.change(legalForm, { target: { value: 'gmbh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Angaben anzeigen' }));
    const profitDetermination = document.getElementById('onboarding-reporting-profit-determination') as HTMLSelectElement;
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

  it('keeps a German decimal while editing the VAT rate and submits its numeric value', async () => {
    const onSubmit = vi.fn<(draft: BusinessOnboardingDraft) => Promise<void>>(async () => undefined);
    render(<BusinessOnboarding initialData={initialData} onSubmit={onSubmit} edition="lite" />);

    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    const vatRate = screen.getByRole('textbox', { name: 'Standard-MwSt. in Prozent' });
    fireEvent.change(vatRate, { target: { value: '19,5' } });
    expect(vatRate).toHaveValue('19,5');
    fireEvent.blur(vatRate);

    fireEvent.click(screen.getByRole('button', { name: /Weiter zu Weitere Angaben/i }));
    fireEvent.click(screen.getByRole('button', { name: /Einrichtung abschließen/i }));

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit.mock.calls[0]?.[0].legal.defaultVatRate).toBe(19.5);
  });

  it('does not expose Pro reporting controls in Lite', () => {
    render(<BusinessOnboarding initialData={initialData} onSubmit={vi.fn(async () => undefined)} edition="lite" />);
    fireEvent.click(screen.getByRole('button', { name: 'Zurück' }));
    fireEvent.click(screen.getByRole('button', { name: 'Weitere Angaben anzeigen' }));

    expect(screen.queryByRole('combobox', { name: 'Gewinnermittlung' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Kontenrahmen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'HGB-Größenklasse' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'GmbH' })).not.toBeInTheDocument();
  });
});
