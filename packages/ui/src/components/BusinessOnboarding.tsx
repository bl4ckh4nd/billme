import React from 'react';
import { Button } from './Button';
import { Input } from './Input';
import { ValidationSummary } from './ValidationSummary';

export type BusinessReportingProfile = {
  jurisdiction: 'DE';
  legalForm: 'sole_proprietor' | 'gmbh';
  profitDetermination: 'eur' | 'double_entry';
  hgbSizeClass?: 'micro' | 'small';
  /** Calendar month and day, e.g. 01-01. */
  fiscalYearStart: string;
  chart?: 'SKR03' | 'SKR04';
  vatMethod: 'soll' | 'ist';
};

const DEFAULT_BUSINESS_REPORTING_PROFILE: BusinessReportingProfile = {
  jurisdiction: 'DE',
  legalForm: 'sole_proprietor',
  profitDetermination: 'eur',
  fiscalYearStart: '01-01',
  vatMethod: 'soll',
};

export type BusinessOnboardingDraft = {
  company: {
    name: string;
    owner: string;
    street: string;
    zip: string;
    city: string;
    email: string;
    phone: string;
    website: string;
  };
  finance: {
    bankName: string;
    iban: string;
    bic: string;
    taxId: string;
    vatId: string;
    registerCourt: string;
  };
  legal: {
    smallBusinessRule: boolean;
    defaultVatRate: number;
    paymentTermsDays: number;
  };
  numbers: {
    invoicePrefix: string;
    offerPrefix: string;
  };
  businessReportingProfile?: BusinessReportingProfile;
};

type OnboardingVisibilitySettings = {
  company: {
    name: string;
  };
  onboardingCompleted?: boolean;
};

type StepId = 'identity' | 'billing' | 'details';
type FieldPath =
  | 'company.name'
  | 'company.owner'
  | 'company.street'
  | 'company.zip'
  | 'company.city'
  | 'company.email'
  | 'finance.taxId'
  | 'numbers.invoicePrefix'
  | 'numbers.offerPrefix'
  | 'legal.paymentTermsDays'
  | 'legal.defaultVatRate'
  | 'finance.bankName'
  | 'finance.iban'
  | 'businessReportingProfile.jurisdiction'
  | 'businessReportingProfile.legalForm'
  | 'businessReportingProfile.profitDetermination'
  | 'businessReportingProfile.hgbSizeClass'
  | 'businessReportingProfile.fiscalYearStart'
  | 'businessReportingProfile.chart'
  | 'businessReportingProfile.vatMethod';

const FIELD_IDS: Record<FieldPath, string> = {
  'company.name': 'onboarding-company-name',
  'company.owner': 'onboarding-company-owner',
  'company.street': 'onboarding-company-street',
  'company.zip': 'onboarding-company-zip',
  'company.city': 'onboarding-company-city',
  'company.email': 'onboarding-company-email',
  'finance.taxId': 'onboarding-finance-tax-id',
  'numbers.invoicePrefix': 'onboarding-invoice-prefix',
  'numbers.offerPrefix': 'onboarding-offer-prefix',
  'legal.paymentTermsDays': 'onboarding-payment-terms-days',
  'legal.defaultVatRate': 'onboarding-default-vat-rate',
  'finance.bankName': 'onboarding-bank-name',
  'finance.iban': 'onboarding-iban',
  'businessReportingProfile.jurisdiction': 'onboarding-reporting-jurisdiction',
  'businessReportingProfile.legalForm': 'onboarding-reporting-legal-form',
  'businessReportingProfile.profitDetermination': 'onboarding-reporting-profit-determination',
  'businessReportingProfile.hgbSizeClass': 'onboarding-reporting-hgb-size-class',
  'businessReportingProfile.fiscalYearStart': 'onboarding-fiscal-year-start',
  'businessReportingProfile.chart': 'onboarding-reporting-chart',
  'businessReportingProfile.vatMethod': 'onboarding-reporting-vat-method',
};

const FIELD_LABELS: Record<FieldPath, string> = {
  'company.name': 'Firmenname',
  'company.owner': 'Inhaber oder Geschäftsführung',
  'company.street': 'Strasse und Hausnummer',
  'company.zip': 'PLZ',
  'company.city': 'Stadt',
  'company.email': 'E-Mail für Angebote und Rechnungen',
  'finance.taxId': 'Steuernummer',
  'numbers.invoicePrefix': 'Rechnungs-Praefix',
  'numbers.offerPrefix': 'Angebots-Praefix',
  'legal.paymentTermsDays': 'Zahlungsziel in Tagen',
  'legal.defaultVatRate': 'Standard-MwSt. in Prozent',
  'finance.bankName': 'Bankname',
  'finance.iban': 'IBAN',
  'businessReportingProfile.jurisdiction': 'Rechtsraum',
  'businessReportingProfile.legalForm': 'Rechtsform',
  'businessReportingProfile.profitDetermination': 'Gewinnermittlung',
  'businessReportingProfile.hgbSizeClass': 'GmbH-Größenklasse',
  'businessReportingProfile.fiscalYearStart': 'Wirtschaftsjahresbeginn (MM-TT)',
  'businessReportingProfile.chart': 'Kontenrahmen',
  'businessReportingProfile.vatMethod': 'Umsatzsteuer-Methode',
};

const STEP_FIELDS: Record<StepId, readonly FieldPath[]> = {
  identity: [
    'company.name',
    'company.owner',
    'company.street',
    'company.zip',
    'company.city',
    'company.email',
  ],
  billing: [
    'finance.taxId',
    'numbers.invoicePrefix',
    'numbers.offerPrefix',
    'legal.paymentTermsDays',
    'legal.defaultVatRate',
    'businessReportingProfile.jurisdiction',
    'businessReportingProfile.legalForm',
    'businessReportingProfile.profitDetermination',
    'businessReportingProfile.hgbSizeClass',
    'businessReportingProfile.fiscalYearStart',
    'businessReportingProfile.chart',
    'businessReportingProfile.vatMethod',
  ],
  details: ['finance.bankName', 'finance.iban'],
};

type SelectFieldProps = {
  id: string;
  label: string;
  value: string;
  required?: boolean;
  error?: string;
  hint?: React.ReactNode;
  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  children: React.ReactNode;
};

const SelectField: React.FC<SelectFieldProps> = ({
  id,
  label,
  value,
  required = false,
  error,
  hint,
  onChange,
  children,
}) => {
  const errorId = `${id}-error`;

  return (
    <div className="block text-sm font-medium text-foreground">
      <label htmlFor={id}>
        <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-muted">
          {label}
          {required && <span aria-hidden="true" className="ml-1 text-error">*</span>}
        </span>
      </label>
      <select
        id={id}
        value={value}
        onChange={onChange}
        required={required}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={`h-11 w-full rounded-xl border bg-surface px-3 text-sm font-medium outline-none focus:ring-2 focus:ring-accent ${error ? 'border-error focus:ring-error' : 'border-border'}`}
      >
        {children}
      </select>
      {hint && <span className="mt-2 block text-xs text-muted">{hint}</span>}
      {error && <p id={errorId} className="mt-2 block text-xs text-error">{error}</p>}
    </div>
  );
};

type StepDefinition = {
  id: StepId;
  label: string;
  title: string;
  description: string;
  eyebrow: string;
};

const STEPS: StepDefinition[] = [
  {
    id: 'identity',
    label: 'Unternehmen',
    title: 'Richte deinen Firmenkopf ein',
    description: 'Diese Angaben landen direkt auf deinen Angeboten und Rechnungen.',
    eyebrow: 'Schritt 1',
  },
  {
    id: 'billing',
    label: 'Abrechnung',
    title: 'Lege deine Abrechnungslogik fest',
    description: 'Hier legst du Steuer, Zahlungsziel und Nummernkreise für deine Dokumente fest.',
    eyebrow: 'Schritt 2',
  },
  {
    id: 'details',
    label: 'Weitere Angaben',
    title: 'Ergänze Zahlungs- und Kontaktdaten',
    description: 'Diese Felder sind optional. Sie ergänzen die Angaben auf deinen Dokumenten.',
    eyebrow: 'Schritt 3',
  },
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const trim = (value: string) => value.trim();

const withReportingProfile = (draft: BusinessOnboardingDraft): BusinessOnboardingDraft => ({
  ...draft,
  businessReportingProfile: {
    ...DEFAULT_BUSINESS_REPORTING_PROFILE,
    ...draft.businessReportingProfile,
  },
});

const reportingProfileOf = (draft: BusinessOnboardingDraft): BusinessReportingProfile =>
  draft.businessReportingProfile ?? DEFAULT_BUSINESS_REPORTING_PROFILE;

const getInitialStepIndex = (draft: BusinessOnboardingDraft) => {
  if (!trim(draft.company.name)) return 0;
  if (!trim(draft.finance.taxId)) return 1;
  return 2;
};

const validateIdentityStep = (draft: BusinessOnboardingDraft): Partial<Record<FieldPath, string>> => {
  const errors: Partial<Record<FieldPath, string>> = {};

  if (!trim(draft.company.name)) errors['company.name'] = 'Bitte gib den Firmennamen ein.';
  if (!trim(draft.company.owner)) errors['company.owner'] = 'Bitte gib die verantwortliche Person ein.';
  if (!trim(draft.company.street)) errors['company.street'] = 'Bitte gib Strasse und Hausnummer ein.';
  if (!trim(draft.company.zip)) errors['company.zip'] = 'Bitte gib die Postleitzahl ein.';
  if (!trim(draft.company.city)) errors['company.city'] = 'Bitte gib die Stadt ein.';
  if (!trim(draft.company.email)) {
    errors['company.email'] = 'Bitte gib eine E-Mail-Adresse ein.';
  } else if (!EMAIL_PATTERN.test(trim(draft.company.email))) {
    errors['company.email'] = 'Die E-Mail-Adresse braucht ein @ und eine gueltige Domain.';
  }

  return errors;
};

const validateBillingStep = (draft: BusinessOnboardingDraft): Partial<Record<FieldPath, string>> => {
  const errors: Partial<Record<FieldPath, string>> = {};
  const profile = reportingProfileOf(draft);

  if (!trim(draft.finance.taxId)) errors['finance.taxId'] = 'Bitte gib die Steuernummer ein.';
  if (!trim(draft.numbers.invoicePrefix)) {
    errors['numbers.invoicePrefix'] = 'Bitte lege ein Rechnungs-Praefix fest.';
  }
  if (!trim(draft.numbers.offerPrefix)) {
    errors['numbers.offerPrefix'] = 'Bitte lege ein Angebots-Praefix fest.';
  }
  if (!Number.isFinite(draft.legal.paymentTermsDays) || draft.legal.paymentTermsDays < 1) {
    errors['legal.paymentTermsDays'] = 'Bitte gib ein Zahlungsziel von mindestens 1 Tag an.';
  }
  if (
    !draft.legal.smallBusinessRule
    && (!Number.isFinite(draft.legal.defaultVatRate) || draft.legal.defaultVatRate < 0 || draft.legal.defaultVatRate > 100)
  ) {
    errors['legal.defaultVatRate'] = 'Bitte gib einen Mehrwertsteuersatz zwischen 0 und 100 an.';
  }

  if (profile.jurisdiction !== 'DE') {
    errors['businessReportingProfile.jurisdiction'] = 'Der Berichts- und Steuerumfang unterstützt derzeit nur Deutschland.';
  }
  if (profile.legalForm === 'gmbh' && profile.profitDetermination !== 'double_entry') {
    errors['businessReportingProfile.profitDetermination'] = 'Eine GmbH muss in diesem Umfang doppelte Buchführung verwenden.';
  }
  if (profile.legalForm === 'sole_proprietor' && profile.profitDetermination !== 'eur') {
    errors['businessReportingProfile.profitDetermination'] = 'Einzelunternehmen sind in diesem Umfang nur mit EÜR möglich.';
  }
  if (profile.legalForm === 'gmbh' && !profile.hgbSizeClass) {
    errors['businessReportingProfile.hgbSizeClass'] = 'Für eine GmbH bitte Micro oder Small auswählen.';
  }
  if (profile.profitDetermination === 'double_entry' && !profile.chart) {
    errors['businessReportingProfile.chart'] = 'Bei doppelter Buchführung bitte SKR03 oder SKR04 auswählen.';
  }
  if (!/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(profile.fiscalYearStart)) {
    errors['businessReportingProfile.fiscalYearStart'] = 'Bitte den Wirtschaftsjahresbeginn als MM-TT eingeben, z. B. 01-01.';
  }

  return errors;
};

const validateDetailsStep = (draft: BusinessOnboardingDraft): Partial<Record<FieldPath, string>> => {
  const errors: Partial<Record<FieldPath, string>> = {};

  if (trim(draft.finance.iban) && !trim(draft.finance.bankName)) {
    errors['finance.bankName'] = 'Bitte gib den Banknamen an, wenn du eine IBAN hinterlegst.';
  }
  if (trim(draft.finance.bankName) && !trim(draft.finance.iban)) {
    errors['finance.iban'] = 'Bitte gib die IBAN an, wenn du ein Bankkonto hinterlegst.';
  }

  return errors;
};

const validateStep = (
  stepIndex: number,
  draft: BusinessOnboardingDraft,
): Partial<Record<FieldPath, string>> => {
  if (stepIndex === 0) return validateIdentityStep(draft);
  if (stepIndex === 1) return validateBillingStep(draft);
  return validateDetailsStep(draft);
};

const countEssentials = (draft: BusinessOnboardingDraft) => {
  const essentials = [
    trim(draft.company.name),
    trim(draft.company.owner),
    trim(draft.company.street),
    trim(draft.company.zip),
    trim(draft.company.city),
    trim(draft.company.email),
    trim(draft.finance.taxId),
    trim(draft.numbers.invoicePrefix),
    trim(draft.numbers.offerPrefix),
  ];
  return essentials.filter(Boolean).length;
};

export const shouldShowBusinessOnboarding = (
  settings: OnboardingVisibilitySettings | null | undefined,
): boolean => Boolean(
  settings
  && settings.onboardingCompleted !== true
  && !trim(settings.company.name),
);

export interface BusinessOnboardingProps {
  initialData: BusinessOnboardingDraft;
  onSubmit: (draft: BusinessOnboardingDraft) => Promise<void>;
  saving?: boolean;
  productName?: string;
  submitLabel?: string;
}

export const BusinessOnboarding: React.FC<BusinessOnboardingProps> = ({
  initialData,
  onSubmit,
  saving = false,
  productName = 'Billme',
  submitLabel = 'Einrichtung abschließen',
}) => {
  const [draft, setDraft] = React.useState(() => withReportingProfile(initialData));
  const [stepIndex, setStepIndex] = React.useState(() => getInitialStepIndex(initialData));
  const [errors, setErrors] = React.useState<Partial<Record<FieldPath, string>>>({});
  const [pendingFocusId, setPendingFocusId] = React.useState<string | null>(null);

  React.useEffect(() => {
    setDraft(withReportingProfile(initialData));
    setStepIndex(getInitialStepIndex(initialData));
    setErrors({});
    setPendingFocusId(null);
  }, [initialData]);

  React.useEffect(() => {
    if (!pendingFocusId) return;
    const field = document.getElementById(pendingFocusId);
    setPendingFocusId(null);
    if (!(field instanceof HTMLElement)) return;
    field.focus({ preventScroll: true });
    field.scrollIntoView?.({ block: 'center' });
  }, [pendingFocusId, stepIndex]);

  const currentStep = STEPS[stepIndex];
  const progress = ((stepIndex + 1) / STEPS.length) * 100;
  const essentialsCompleted = countEssentials(draft);
  const reportingProfile = reportingProfileOf(draft);

  const currentStepErrors = STEP_FIELDS[currentStep.id]
    .filter((field) => errors[field])
    .map((field) => ({
      id: FIELD_IDS[field],
      message: `${FIELD_LABELS[field]}: ${errors[field]}`,
    }));
  const firstStepError = currentStepErrors[0]?.message;

  const focusField = (id: string) => {
    setPendingFocusId(id);
  };

  const updateCompany = (field: keyof BusinessOnboardingDraft['company'], value: string) => {
    setDraft((current) => ({
      ...current,
      company: { ...current.company, [field]: value },
    }));
  };

  const updateFinance = (field: keyof BusinessOnboardingDraft['finance'], value: string) => {
    setDraft((current) => ({
      ...current,
      finance: { ...current.finance, [field]: value },
    }));
  };

  const updateLegal = (
    field: keyof BusinessOnboardingDraft['legal'],
    value: BusinessOnboardingDraft['legal'][keyof BusinessOnboardingDraft['legal']],
  ) => {
    setDraft((current) => ({
      ...current,
      legal: { ...current.legal, [field]: value },
    }));
  };

  const updateNumbers = (field: keyof BusinessOnboardingDraft['numbers'], value: string) => {
    setDraft((current) => ({
      ...current,
      numbers: { ...current.numbers, [field]: value },
    }));
  };

  const updateReportingProfile = <K extends keyof BusinessReportingProfile>(
    field: K,
    value: BusinessReportingProfile[K],
  ) => {
    setDraft((current) => {
      const profile = reportingProfileOf(current);
      if (field === 'legalForm' && value === 'gmbh') {
        return {
          ...current,
          businessReportingProfile: {
            ...profile,
            legalForm: value as BusinessReportingProfile['legalForm'],
            profitDetermination: 'double_entry',
            hgbSizeClass: profile.hgbSizeClass ?? 'micro',
            chart: profile.chart ?? 'SKR03',
          },
        };
      }
      if (field === 'legalForm' && value === 'sole_proprietor') {
        return {
          ...current,
          businessReportingProfile: {
            ...profile,
            legalForm: value as BusinessReportingProfile['legalForm'],
            profitDetermination: 'eur',
            hgbSizeClass: undefined,
          },
        };
      }
      return {
        ...current,
        businessReportingProfile: { ...profile, [field]: value },
      };
    });
  };

  const handleNext = () => {
    const stepErrors = validateStep(stepIndex, draft);
    setErrors(stepErrors);
    const firstError = Object.keys(stepErrors)[0] as FieldPath | undefined;
    if (firstError) {
      setPendingFocusId(FIELD_IDS[firstError]);
      return;
    }
    setStepIndex((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const handleSubmit = async () => {
    const identityErrors = validateIdentityStep(draft);
    const billingErrors = validateBillingStep(draft);
    const detailsErrors = validateDetailsStep(draft);
    const allErrors = { ...identityErrors, ...billingErrors, ...detailsErrors };
    if (Object.keys(allErrors).length > 0) {
      const firstInvalidStep = identityErrors && Object.keys(identityErrors).length > 0
        ? 0
        : billingErrors && Object.keys(billingErrors).length > 0
          ? 1
          : 2;
      const firstError = Object.keys(
        firstInvalidStep === 0 ? identityErrors : firstInvalidStep === 1 ? billingErrors : detailsErrors,
      )[0] as FieldPath | undefined;
      setErrors(allErrors);
      setStepIndex(firstInvalidStep);
      if (firstError) setPendingFocusId(FIELD_IDS[firstError]);
      return;
    }
    await onSubmit(withReportingProfile(draft));
  };

  // Intentionally stays in this tree: onboarding owns its shell-relative layout and mounts outside transformed shells.
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#f4f4ef] px-4 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto grid min-h-full w-full max-w-6xl overflow-hidden rounded-xl border border-black/5 bg-surface shadow-[0_28px_90px_rgba(15,23,42,0.14)] lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="relative overflow-hidden bg-[#121212] px-6 py-7 text-white sm:px-8 lg:px-7">
          <div className="absolute inset-x-0 top-0 h-1 bg-white/10">
            <div
              className="h-full bg-[var(--color-accent)] transition-[width] duration-300 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="flex h-full flex-col">
            <div>
              <p className="text-[0.72rem] font-semibold uppercase tracking-[0.24em] text-white/55">
                Ersteinrichtung
              </p>
              <h1 className="mt-3 max-w-[12rem] text-balance text-[2rem] font-semibold leading-tight">
                {productName} einrichten
              </h1>
              <p className="mt-4 max-w-[15rem] text-pretty text-sm leading-6 text-white/72">
                Trage die Daten ein, die auf deinen Angeboten und Rechnungen erscheinen sollen.
              </p>
            </div>

            <div className="mt-8 rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">
                Pflichtfelder
              </p>
              <div className="mt-3 flex items-end gap-3">
                <strong className="text-3xl font-semibold">{essentialsCompleted}/9</strong>
                <span className="pb-1 text-sm text-white/60">eingetragen</span>
              </div>
              <p className="mt-3 text-pretty text-sm leading-6 text-white/68">
                Sobald Firmenkopf, Steuerdaten und Dokumentvorgaben ausgefüllt sind, kannst du Dokumente erstellen.
              </p>
            </div>

            <ol className="mt-8 space-y-3">
              {STEPS.map((step, index) => {
                const state =
                  index < stepIndex ? 'done' : index === stepIndex ? 'current' : 'upcoming';

                return (
                  <li
                    key={step.id}
                    className={`rounded-lg border px-4 py-3 transition-colors ${
                      state === 'current'
                        ? 'border-white/20 bg-white/9'
                        : state === 'done'
                          ? 'border-white/12 bg-white/4'
                          : 'border-white/8 bg-transparent'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                          state === 'current'
                            ? 'bg-[var(--color-accent)] text-black'
                            : state === 'done'
                              ? 'bg-white/12 text-white'
                              : 'bg-white/6 text-white/60'
                        }`}
                      >
                        {state === 'done' ? 'OK' : index + 1}
                      </span>
                      <div>
                        <p className="text-sm font-semibold">{step.label}</p>
                        <p className="mt-1 text-pretty text-xs leading-5 text-white/58">{step.description}</p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="mt-auto hidden rounded-lg border border-white/10 bg-black/20 p-4 lg:block">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">
                Danach kannst du
              </p>
              <ul className="mt-4 space-y-2 text-sm text-white/72">
                <li>Angebote mit deinen Firmendaten erstellen</li>
                <li>Rechnungsnummern vergeben</li>
                <li>Zahlungsziele verwenden</li>
              </ul>
            </div>
          </div>
        </aside>

        <main className="flex min-h-full flex-col bg-[#fbfbf8]">
          <div className="border-b border-black/6 px-6 py-5 sm:px-8">
            <p className="text-[0.72rem] font-semibold uppercase tracking-[0.2em] text-muted">
              {currentStep.eyebrow}
            </p>
            <div className="mt-2 flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-balance text-[1.9rem] font-semibold tracking-[-0.02em] text-foreground">
                  {currentStep.title}
                </h2>
                <p className="mt-2 max-w-2xl text-pretty text-sm leading-6 text-muted">
                  {currentStep.description}
                </p>
              </div>
              <p className="text-sm text-muted">Schritt {stepIndex + 1} von {STEPS.length}</p>
            </div>
          </div>

          <div className="flex-1 px-6 py-6 sm:px-8 sm:py-8">
            <ValidationSummary errors={currentStepErrors} onJump={focusField} />
            {currentStep.id === 'identity' && (
              <div className="space-y-8">
                <section className="grid gap-4 md:grid-cols-2">
                  <Input
                    id={FIELD_IDS['company.name']}
                    label="Firmenname"
                    fullWidth
                    required
                    value={draft.company.name}
                    onChange={(event) => updateCompany('name', event.target.value)}
                    placeholder="Muster GmbH"
                    error={errors['company.name']}
                  />
                  <Input
                    id={FIELD_IDS['company.owner']}
                    label="Inhaber oder Geschäftsführung"
                    fullWidth
                    required
                    value={draft.company.owner}
                    onChange={(event) => updateCompany('owner', event.target.value)}
                    placeholder="Max Muster"
                    error={errors['company.owner']}
                  />
                  <div className="md:col-span-2">
                    <Input
                      id={FIELD_IDS['company.street']}
                      label="Strasse und Hausnummer"
                      fullWidth
                      required
                      value={draft.company.street}
                      onChange={(event) => updateCompany('street', event.target.value)}
                      placeholder="Musterstrasse 12"
                      error={errors['company.street']}
                    />
                  </div>
                  <Input
                    id={FIELD_IDS['company.zip']}
                    label="PLZ"
                    fullWidth
                    required
                    value={draft.company.zip}
                    onChange={(event) => updateCompany('zip', event.target.value)}
                    placeholder="10115"
                    error={errors['company.zip']}
                  />
                  <Input
                    id={FIELD_IDS['company.city']}
                    label="Stadt"
                    fullWidth
                    required
                    value={draft.company.city}
                    onChange={(event) => updateCompany('city', event.target.value)}
                    placeholder="Berlin"
                    error={errors['company.city']}
                  />
                  <div className="md:col-span-2">
                    <Input
                      id={FIELD_IDS['company.email']}
                      label="E-Mail für Angebote und Rechnungen"
                      fullWidth
                      required
                      type="email"
                      value={draft.company.email}
                      onChange={(event) => updateCompany('email', event.target.value)}
                      placeholder="kontakt@muster.de"
                      error={errors['company.email']}
                    />
                  </div>
                </section>

                <div className="rounded-lg border border-border bg-surface p-5">
                  <p className="text-sm font-semibold text-foreground">Warum wir das jetzt abfragen</p>
                  <p className="mt-2 max-w-2xl text-pretty text-sm leading-6 text-muted">
                    Diese Angaben bilden den Firmenkopf deiner Dokumente. Ohne sie fehlen wichtige Absenderdaten.
                  </p>
                </div>
              </div>
            )}

            {currentStep.id === 'billing' && (
              <div className="space-y-8">
                <section className="grid gap-4 md:grid-cols-2">
                  <Input
                    id={FIELD_IDS['finance.taxId']}
                    label="Steuernummer"
                    fullWidth
                    required
                    value={draft.finance.taxId}
                    onChange={(event) => updateFinance('taxId', event.target.value)}
                    placeholder="123/456/78900"
                    error={errors['finance.taxId']}
                  />
                  <Input
                    id={FIELD_IDS['legal.paymentTermsDays']}
                    label="Zahlungsziel in Tagen"
                    fullWidth
                    required
                    inputMode="numeric"
                    value={String(draft.legal.paymentTermsDays)}
                    onChange={(event) => updateLegal('paymentTermsDays', Number(event.target.value) || 0)}
                    placeholder="14"
                    error={errors['legal.paymentTermsDays']}
                  />
                  <Input
                    id={FIELD_IDS['numbers.invoicePrefix']}
                    label="Rechnungs-Praefix"
                    fullWidth
                    required
                    value={draft.numbers.invoicePrefix}
                    onChange={(event) => updateNumbers('invoicePrefix', event.target.value)}
                    placeholder="RE-2026-"
                    error={errors['numbers.invoicePrefix']}
                  />
                  <Input
                    id={FIELD_IDS['numbers.offerPrefix']}
                    label="Angebots-Praefix"
                    fullWidth
                    required
                    value={draft.numbers.offerPrefix}
                    onChange={(event) => updateNumbers('offerPrefix', event.target.value)}
                    placeholder="ANG-2026-"
                    error={errors['numbers.offerPrefix']}
                  />
                </section>

                <section className="rounded-lg border border-border bg-surface p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="max-w-xl">
                      <p className="text-sm font-semibold text-foreground">Steuerprofil</p>
                      <p className="mt-2 text-pretty text-sm leading-6 text-muted">
                        Wähle die Steuerlogik für deine Dokumente.
                      </p>
                    </div>
                    <label className="inline-flex min-h-11 items-center gap-3 rounded-full border border-border bg-surface-muted px-4 py-2 text-sm font-medium text-foreground">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--color-accent)]"
                        checked={draft.legal.smallBusinessRule}
                        onChange={(event) => updateLegal('smallBusinessRule', event.target.checked)}
                      />
                      Kleinunternehmerregelung §19 UStG
                    </label>
                  </div>

                  {!draft.legal.smallBusinessRule && (
                    <div className="mt-5 max-w-xs">
                      <Input
                        id={FIELD_IDS['legal.defaultVatRate']}
                        label="Standard-MwSt. in Prozent"
                        fullWidth
                        required
                        inputMode="numeric"
                        value={String(draft.legal.defaultVatRate)}
                        onChange={(event) => updateLegal('defaultVatRate', Number(event.target.value) || 0)}
                        placeholder="19"
                        error={errors['legal.defaultVatRate']}
                      />
                    </div>
                  )}
                </section>

                <section className="rounded-lg border border-border bg-surface p-5">
                  <div>
                    <p className="text-sm font-semibold text-foreground">Berichtsprofil</p>
                    <p className="mt-2 max-w-2xl text-pretty text-sm leading-6 text-muted">
                      Diese Auswahl legt fest, welche deutschen Berichte und Kontenlogik angeboten werden. Österreich und die Schweiz werden derzeit nicht unterstützt.
                    </p>
                  </div>

                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    <SelectField
                      id={FIELD_IDS['businessReportingProfile.jurisdiction']}
                      label="Rechtsraum"
                      value={reportingProfile.jurisdiction}
                      required
                      error={errors['businessReportingProfile.jurisdiction']}
                      hint="AT/CH-Berichte sind noch nicht verfügbar."
                      onChange={(event) => updateReportingProfile('jurisdiction', event.target.value as 'DE')}
                    >
                        <option value="DE">Deutschland</option>
                    </SelectField>

                    <SelectField
                      id={FIELD_IDS['businessReportingProfile.legalForm']}
                      label="Rechtsform"
                      value={reportingProfile.legalForm}
                      required
                      error={errors['businessReportingProfile.legalForm']}
                      onChange={(event) => updateReportingProfile('legalForm', event.target.value as BusinessReportingProfile['legalForm'])}
                    >
                        <option value="sole_proprietor">Einzelunternehmen</option>
                        <option value="gmbh">GmbH</option>
                    </SelectField>

                    <SelectField
                      id={FIELD_IDS['businessReportingProfile.profitDetermination']}
                      label="Gewinnermittlung"
                      value={reportingProfile.profitDetermination}
                      required
                      error={errors['businessReportingProfile.profitDetermination']}
                      hint={reportingProfile.legalForm === 'gmbh' ? 'GmbH ist hier nur mit doppelter Buchführung möglich.' : undefined}
                      onChange={(event) => updateReportingProfile('profitDetermination', event.target.value as BusinessReportingProfile['profitDetermination'])}
                    >
                        <option value="eur" disabled={reportingProfile.legalForm === 'gmbh'}>EÜR</option>
                        <option value="double_entry">Doppelte Buchführung</option>
                    </SelectField>

                    {reportingProfile.legalForm === 'gmbh' && (
                      <SelectField
                        id={FIELD_IDS['businessReportingProfile.hgbSizeClass']}
                        label="GmbH-Größenklasse"
                        value={reportingProfile.hgbSizeClass ?? ''}
                        required
                        error={errors['businessReportingProfile.hgbSizeClass']}
                        onChange={(event) => updateReportingProfile('hgbSizeClass', event.target.value as 'micro' | 'small')}
                      >
                          <option value="" disabled>Bitte auswählen</option>
                          <option value="micro">Kleinstgesellschaft (Micro)</option>
                          <option value="small">Kleine Gesellschaft (Small)</option>
                      </SelectField>
                    )}

                    {reportingProfile.profitDetermination === 'double_entry' && (
                      <SelectField
                        id={FIELD_IDS['businessReportingProfile.chart']}
                        label="Kontenrahmen"
                        value={reportingProfile.chart ?? ''}
                        required
                        error={errors['businessReportingProfile.chart']}
                        onChange={(event) => updateReportingProfile('chart', event.target.value as 'SKR03' | 'SKR04')}
                      >
                          <option value="" disabled>Bitte auswählen</option>
                          <option value="SKR03">SKR03</option>
                          <option value="SKR04">SKR04</option>
                      </SelectField>
                    )}

                    <Input
                      id={FIELD_IDS['businessReportingProfile.fiscalYearStart']}
                      label="Wirtschaftsjahresbeginn (MM-TT)"
                      fullWidth
                      required
                      value={reportingProfile.fiscalYearStart}
                      onChange={(event) => updateReportingProfile('fiscalYearStart', event.target.value)}
                      placeholder="01-01"
                      error={errors['businessReportingProfile.fiscalYearStart']}
                    />
                    <SelectField
                      id={FIELD_IDS['businessReportingProfile.vatMethod']}
                      label="Umsatzsteuer-Methode"
                      value={reportingProfile.vatMethod}
                      required
                      error={errors['businessReportingProfile.vatMethod']}
                      onChange={(event) => updateReportingProfile('vatMethod', event.target.value as BusinessReportingProfile['vatMethod'])}
                    >
                        <option value="soll">Soll-Versteuerung</option>
                        <option value="ist">Ist-Versteuerung</option>
                    </SelectField>
                  </div>
                </section>
              </div>
            )}

            {currentStep.id === 'details' && (
              <div className="space-y-8">
                <section className="grid gap-4 md:grid-cols-2">
                  <Input
                    id="onboarding-company-phone"
                    label="Telefon"
                    fullWidth
                    value={draft.company.phone}
                    onChange={(event) => updateCompany('phone', event.target.value)}
                    placeholder="+49 30 123456"
                  />
                  <Input
                    id="onboarding-company-website"
                    label="Website"
                    fullWidth
                    value={draft.company.website}
                    onChange={(event) => updateCompany('website', event.target.value)}
                    placeholder="www.muster.de"
                  />
                  <Input
                    id={FIELD_IDS['finance.bankName']}
                    label="Bankname"
                    fullWidth
                    required={Boolean(trim(draft.finance.iban))}
                    value={draft.finance.bankName}
                    onChange={(event) => updateFinance('bankName', event.target.value)}
                    placeholder="Musterbank"
                    error={errors['finance.bankName']}
                  />
                  <Input
                    id={FIELD_IDS['finance.iban']}
                    label="IBAN"
                    fullWidth
                    required={Boolean(trim(draft.finance.bankName))}
                    value={draft.finance.iban}
                    onChange={(event) => updateFinance('iban', event.target.value)}
                    placeholder="DE00 0000 0000 0000 0000 00"
                    error={errors['finance.iban']}
                  />
                  <Input
                    id="onboarding-finance-bic"
                    label="BIC"
                    fullWidth
                    value={draft.finance.bic}
                    onChange={(event) => updateFinance('bic', event.target.value)}
                    placeholder="GENODEF1XXX"
                  />
                  <Input
                    id="onboarding-finance-vat-id"
                    label="USt-IdNr."
                    fullWidth
                    value={draft.finance.vatId}
                    onChange={(event) => updateFinance('vatId', event.target.value)}
                    placeholder="DE123456789"
                  />
                  <div className="md:col-span-2">
                    <Input
                      id="onboarding-finance-register-court"
                      label="Registergericht"
                      fullWidth
                      value={draft.finance.registerCourt}
                      onChange={(event) => updateFinance('registerCourt', event.target.value)}
                      placeholder="Amtsgericht Berlin-Charlottenburg"
                    />
                  </div>
                </section>

                <section className="rounded-lg border border-border bg-surface p-5">
                  <p className="text-sm font-semibold text-foreground">Zusammenfassung</p>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className="rounded-md bg-surface-muted px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Firmenkopf</p>
                      <p className="mt-2 text-sm font-medium text-foreground">
                        {trim(draft.company.name) || 'Noch offen'}
                      </p>
                    </div>
                    <div className="rounded-md bg-surface-muted px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Steuer</p>
                      <p className="mt-2 text-sm font-medium text-foreground">
                        {draft.legal.smallBusinessRule
                          ? 'Kleinunternehmerregelung aktiv'
                          : `${draft.legal.defaultVatRate}% Standard-MwSt.`}
                      </p>
                    </div>
                    <div className="rounded-md bg-surface-muted px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Zahlungsziel</p>
                      <p className="mt-2 text-sm font-medium text-foreground">
                        {draft.legal.paymentTermsDays} Tage
                      </p>
                    </div>
                    <div className="rounded-md bg-surface-muted px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Nummernkreis</p>
                      <p className="mt-2 text-sm font-medium text-foreground">
                        {trim(draft.numbers.invoicePrefix) || 'RE-'} / {trim(draft.numbers.offerPrefix) || 'ANG-'}
                      </p>
                    </div>
                  </div>
                </section>
              </div>
            )}
          </div>

          <div className="border-t border-black/6 bg-white/70 px-6 py-4 backdrop-blur sm:px-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted">
                {stepIndex === STEPS.length - 1
                  ? 'Weitere Einstellungen findest du später im Bereich Einstellungen.'
                  : 'Die Pflichtfelder werden für deine Dokumente benötigt.'}
              </p>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {firstStepError && <p id="onboarding-action-error" className="max-w-sm text-xs text-error" role="status" aria-live="assertive">{firstStepError}</p>}
                {stepIndex > 0 && (
                  <Button
                    variant="secondary"
                    onClick={() => setStepIndex((current) => Math.max(current - 1, 0))}
                  >
                    Zurück
                  </Button>
                )}
                {stepIndex < STEPS.length - 1 ? (
                  <Button onClick={handleNext} aria-describedby={firstStepError ? 'onboarding-action-error' : undefined}>
                    Weiter zu {STEPS[stepIndex + 1]?.label}
                  </Button>
                ) : (
                  <Button onClick={() => void handleSubmit()} disabled={saving} aria-describedby={firstStepError ? 'onboarding-action-error' : undefined}>
                    {saving ? 'Einrichtung wird gespeichert ...' : submitLabel}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};
