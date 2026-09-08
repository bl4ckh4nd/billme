// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BusinessOnboarding, type BusinessOnboardingDraft } from '@billme/ui';

type DraftOverrides = {
  company?: Partial<BusinessOnboardingDraft['company']>;
  finance?: Partial<BusinessOnboardingDraft['finance']>;
  legal?: Partial<BusinessOnboardingDraft['legal']>;
  numbers?: Partial<BusinessOnboardingDraft['numbers']>;
  businessReportingProfile?: Partial<NonNullable<BusinessOnboardingDraft['businessReportingProfile']>>;
};

const draft = (overrides: DraftOverrides = {}): BusinessOnboardingDraft => ({
  company: {
    name: '',
    owner: '',
    street: '',
    zip: '',
    city: '',
    email: '',
    phone: '',
    website: '',
    ...overrides.company,
  },
  finance: {
    bankName: '',
    iban: '',
    bic: '',
    taxId: '',
    vatId: '',
    registerCourt: '',
    ...overrides.finance,
  },
  legal: {
    smallBusinessRule: false,
    defaultVatRate: 19,
    paymentTermsDays: 14,
    ...overrides.legal,
  },
  numbers: {
    invoicePrefix: '',
    offerPrefix: '',
    ...overrides.numbers,
  },
  businessReportingProfile: {
    jurisdiction: 'DE',
    legalForm: 'sole_proprietor',
    profitDetermination: 'eur',
    fiscalYearStart: '01-01',
    vatMethod: 'soll',
    ...overrides.businessReportingProfile,
  },
});

describe('BusinessOnboarding validation feedback', () => {
  it('exposes required field errors through the summary and jumps to the selected field', async () => {
    const onSubmit = vi.fn(async () => {});
    render(<BusinessOnboarding initialData={draft()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: /Weiter zu Abrechnung/ }));

    const name = screen.getByRole('textbox', { name: 'Firmenname' });
    expect(name).toHaveAttribute('required');
    expect(name).toHaveAttribute('aria-required', 'true');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAttribute('aria-describedby', 'onboarding-company-name-error');
    expect(screen.getByText('Bitte gib den Firmennamen ein.')).toHaveAttribute(
      'id',
      'onboarding-company-name-error',
    );

    const summary = screen.getByRole('alert');
    expect(summary).toHaveAttribute('aria-live', 'assertive');
    const summaryEntry = screen.getByRole('button', { name: /Firmenname:/ });
    fireEvent.click(summaryEntry);
    await waitFor(() => expect(name).toHaveFocus());
  });

  it('focuses and scrolls the first invalid field when advancing a step fails', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    render(
      <BusinessOnboarding
        initialData={draft({
          company: {
            name: 'Muster GmbH',
            owner: 'Max Muster',
            street: 'Musterstrasse 12',
            zip: '10115',
            city: 'Berlin',
            email: 'kontakt@muster.de',
          },
          finance: { taxId: '' },
        })}
        onSubmit={vi.fn(async () => {})}
      />,
    );

    const taxId = screen.getByRole('textbox', { name: 'Steuernummer' });
    expect(taxId).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Weiter zu Weitere Angaben/ }));

    await waitFor(() => expect(taxId).toHaveFocus());
    expect(taxId).toHaveAttribute('aria-invalid', 'true');
    expect(scrollIntoView).toHaveBeenCalled();
  });
});
