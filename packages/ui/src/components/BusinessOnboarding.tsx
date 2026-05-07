import React from 'react';
import { Button } from './Button';
import { Input } from './Input';

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
};

type OnboardingVisibilitySettings = {
  company: {
    name: string;
  };
  onboardingCompleted?: boolean;
};

export type BusinessOnboardingSettings = {
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
  | 'finance.iban';

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
    description: 'Steuer, Zahlungsziel und Nummernkreise sorgen dafuer, dass deine Dokumente direkt einsatzbereit sind.',
    eyebrow: 'Schritt 2',
  },
  {
    id: 'details',
    label: 'Feinschliff',
    title: 'Ergaenze Zahlungs- und Kontaktdaten',
    description: 'Diese Felder sind optional, machen deine Unterlagen aber sofort professioneller.',
    eyebrow: 'Schritt 3',
  },
];

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const trim = (value: string) => value.trim();

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

export const buildBusinessOnboardingDraft = (
  settings: BusinessOnboardingSettings,
): BusinessOnboardingDraft => ({
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
    bankName: settings.finance.bankName,
    iban: settings.finance.iban,
    bic: settings.finance.bic,
    taxId: settings.finance.taxId,
    vatId: settings.finance.vatId,
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
});

export const applyBusinessOnboardingDraft = <T extends BusinessOnboardingSettings>(
  settings: T,
  draft: BusinessOnboardingDraft,
): T => ({
  ...settings,
  company: { ...settings.company, ...draft.company },
  finance: { ...settings.finance, ...draft.finance },
  legal: { ...settings.legal, ...draft.legal },
  numbers: { ...settings.numbers, ...draft.numbers },
  onboardingCompleted: true,
});

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
  submitLabel = 'Einrichtung abschliessen',
}) => {
  const [draft, setDraft] = React.useState(initialData);
  const [stepIndex, setStepIndex] = React.useState(() => getInitialStepIndex(initialData));
  const [errors, setErrors] = React.useState<Partial<Record<FieldPath, string>>>({});

  React.useEffect(() => {
    setDraft(initialData);
    setStepIndex(getInitialStepIndex(initialData));
    setErrors({});
  }, [initialData]);

  const currentStep = STEPS[stepIndex];
  const progress = ((stepIndex + 1) / STEPS.length) * 100;
  const essentialsCompleted = countEssentials(draft);

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

  const handleNext = () => {
    const stepErrors = validateStep(stepIndex, draft);
    setErrors(stepErrors);
    if (Object.keys(stepErrors).length > 0) return;
    setStepIndex((current) => Math.min(current + 1, STEPS.length - 1));
  };

  const handleSubmit = async () => {
    const allErrors = {
      ...validateIdentityStep(draft),
      ...validateBillingStep(draft),
      ...validateDetailsStep(draft),
    };
    if (Object.keys(allErrors).length > 0) {
      setErrors(allErrors);
      if (Object.keys(validateIdentityStep(draft)).length > 0) setStepIndex(0);
      else if (Object.keys(validateBillingStep(draft)).length > 0) setStepIndex(1);
      else setStepIndex(2);
      return;
    }
    await onSubmit(draft);
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#f4f4ef] px-4 py-4 sm:px-6 sm:py-6">
      <div className="mx-auto grid min-h-full w-full max-w-6xl overflow-hidden rounded-[2rem] border border-black/5 bg-surface shadow-[0_28px_90px_rgba(15,23,42,0.14)] lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="relative overflow-hidden bg-[#121212] px-6 py-7 text-white sm:px-8 lg:px-7">
          <div className="absolute inset-x-0 top-0 h-1 bg-white/10">
            <div
              className="h-full bg-[var(--color-accent)] transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="flex h-full flex-col">
            <div>
              <p className="text-[0.72rem] font-semibold uppercase tracking-[0.24em] text-white/55">
                Ersteinrichtung
              </p>
              <h1 className="mt-3 max-w-[12rem] text-[2rem] font-semibold leading-tight">
                {productName} startklar machen
              </h1>
              <p className="mt-4 max-w-[15rem] text-sm leading-6 text-white/72">
                In wenigen Schritten ist dein Workspace bereit fuer gebrandete Angebote und Rechnungen.
              </p>
            </div>

            <div className="mt-8 rounded-[1.5rem] border border-white/10 bg-white/5 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">
                Pflichtfelder
              </p>
              <div className="mt-3 flex items-end gap-3">
                <strong className="text-3xl font-semibold">{essentialsCompleted}/9</strong>
                <span className="pb-1 text-sm text-white/60">eingetragen</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-white/68">
                Sobald Firmenkopf, Steuerdaten und Dokumentdefaults stehen, kannst du direkt loslegen.
              </p>
            </div>

            <ol className="mt-8 space-y-3">
              {STEPS.map((step, index) => {
                const state =
                  index < stepIndex ? 'done' : index === stepIndex ? 'current' : 'upcoming';

                return (
                  <li
                    key={step.id}
                    className={`rounded-[1.35rem] border px-4 py-3 transition-colors ${
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
                        <p className="mt-1 text-xs leading-5 text-white/58">{step.description}</p>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>

            <div className="mt-auto hidden rounded-[1.5rem] border border-white/10 bg-black/20 p-4 lg:block">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/50">
                Danach bist du bereit fuer
              </p>
              <ul className="mt-4 space-y-2 text-sm text-white/72">
                <li>- gebrandete Angebote</li>
                <li>- saubere Rechnungsnummern</li>
                <li>- klare Zahlungsziele</li>
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
                <h2 className="text-[1.9rem] font-semibold tracking-[-0.02em] text-foreground">
                  {currentStep.title}
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                  {currentStep.description}
                </p>
              </div>
              <p className="text-sm text-muted">Schritt {stepIndex + 1} von {STEPS.length}</p>
            </div>
          </div>

          <div className="flex-1 px-6 py-6 sm:px-8 sm:py-8">
            {currentStep.id === 'identity' && (
              <div className="space-y-8">
                <section className="grid gap-4 md:grid-cols-2">
                  <Input
                    label="Firmenname"
                    fullWidth
                    value={draft.company.name}
                    onChange={(event) => updateCompany('name', event.target.value)}
                    placeholder="Muster GmbH"
                    error={errors['company.name']}
                  />
                  <Input
                    label="Inhaber oder Geschaeftsfuehrung"
                    fullWidth
                    value={draft.company.owner}
                    onChange={(event) => updateCompany('owner', event.target.value)}
                    placeholder="Max Muster"
                    error={errors['company.owner']}
                  />
                  <div className="md:col-span-2">
                    <Input
                      label="Strasse und Hausnummer"
                      fullWidth
                      value={draft.company.street}
                      onChange={(event) => updateCompany('street', event.target.value)}
                      placeholder="Musterstrasse 12"
                      error={errors['company.street']}
                    />
                  </div>
                  <Input
                    label="PLZ"
                    fullWidth
                    value={draft.company.zip}
                    onChange={(event) => updateCompany('zip', event.target.value)}
                    placeholder="10115"
                    error={errors['company.zip']}
                  />
                  <Input
                    label="Stadt"
                    fullWidth
                    value={draft.company.city}
                    onChange={(event) => updateCompany('city', event.target.value)}
                    placeholder="Berlin"
                    error={errors['company.city']}
                  />
                  <div className="md:col-span-2">
                    <Input
                      label="E-Mail fuer Angebote und Rechnungen"
                      fullWidth
                      type="email"
                      value={draft.company.email}
                      onChange={(event) => updateCompany('email', event.target.value)}
                      placeholder="kontakt@muster.de"
                      error={errors['company.email']}
                    />
                  </div>
                </section>

                <div className="rounded-[1.5rem] border border-border bg-surface p-5">
                  <p className="text-sm font-semibold text-foreground">Warum wir das jetzt abfragen</p>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                    Diese Angaben bilden deinen Firmenkopf. Ohne sie sehen Dokumente schnell unfertig aus oder muessen spaeter nachbearbeitet werden.
                  </p>
                </div>
              </div>
            )}

            {currentStep.id === 'billing' && (
              <div className="space-y-8">
                <section className="grid gap-4 md:grid-cols-2">
                  <Input
                    label="Steuernummer"
                    fullWidth
                    value={draft.finance.taxId}
                    onChange={(event) => updateFinance('taxId', event.target.value)}
                    placeholder="123/456/78900"
                    error={errors['finance.taxId']}
                  />
                  <Input
                    label="Zahlungsziel in Tagen"
                    fullWidth
                    inputMode="numeric"
                    value={String(draft.legal.paymentTermsDays)}
                    onChange={(event) => updateLegal('paymentTermsDays', Number(event.target.value) || 0)}
                    placeholder="14"
                    error={errors['legal.paymentTermsDays']}
                  />
                  <Input
                    label="Rechnungs-Praefix"
                    fullWidth
                    value={draft.numbers.invoicePrefix}
                    onChange={(event) => updateNumbers('invoicePrefix', event.target.value)}
                    placeholder="RE-2026-"
                    error={errors['numbers.invoicePrefix']}
                  />
                  <Input
                    label="Angebots-Praefix"
                    fullWidth
                    value={draft.numbers.offerPrefix}
                    onChange={(event) => updateNumbers('offerPrefix', event.target.value)}
                    placeholder="ANG-2026-"
                    error={errors['numbers.offerPrefix']}
                  />
                </section>

                <section className="rounded-[1.7rem] border border-border bg-surface p-5">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="max-w-xl">
                      <p className="text-sm font-semibold text-foreground">Steuerprofil</p>
                      <p className="mt-2 text-sm leading-6 text-muted">
                        Waehle direkt die passende Steuerlogik, damit deine ersten Dokumente korrekt vorbereitet sind.
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
                        label="Standard-MwSt. in Prozent"
                        fullWidth
                        inputMode="numeric"
                        value={String(draft.legal.defaultVatRate)}
                        onChange={(event) => updateLegal('defaultVatRate', Number(event.target.value) || 0)}
                        placeholder="19"
                        error={errors['legal.defaultVatRate']}
                      />
                    </div>
                  )}
                </section>
              </div>
            )}

            {currentStep.id === 'details' && (
              <div className="space-y-8">
                <section className="grid gap-4 md:grid-cols-2">
                  <Input
                    label="Telefon"
                    fullWidth
                    value={draft.company.phone}
                    onChange={(event) => updateCompany('phone', event.target.value)}
                    placeholder="+49 30 123456"
                  />
                  <Input
                    label="Website"
                    fullWidth
                    value={draft.company.website}
                    onChange={(event) => updateCompany('website', event.target.value)}
                    placeholder="www.muster.de"
                  />
                  <Input
                    label="Bankname"
                    fullWidth
                    value={draft.finance.bankName}
                    onChange={(event) => updateFinance('bankName', event.target.value)}
                    placeholder="Musterbank"
                    error={errors['finance.bankName']}
                  />
                  <Input
                    label="IBAN"
                    fullWidth
                    value={draft.finance.iban}
                    onChange={(event) => updateFinance('iban', event.target.value)}
                    placeholder="DE00 0000 0000 0000 0000 00"
                    error={errors['finance.iban']}
                  />
                  <Input
                    label="BIC"
                    fullWidth
                    value={draft.finance.bic}
                    onChange={(event) => updateFinance('bic', event.target.value)}
                    placeholder="GENODEF1XXX"
                  />
                  <Input
                    label="USt-IdNr."
                    fullWidth
                    value={draft.finance.vatId}
                    onChange={(event) => updateFinance('vatId', event.target.value)}
                    placeholder="DE123456789"
                  />
                  <div className="md:col-span-2">
                    <Input
                      label="Registergericht"
                      fullWidth
                      value={draft.finance.registerCourt}
                      onChange={(event) => updateFinance('registerCourt', event.target.value)}
                      placeholder="Amtsgericht Berlin-Charlottenburg"
                    />
                  </div>
                </section>

                <section className="rounded-[1.7rem] border border-border bg-surface p-5">
                  <p className="text-sm font-semibold text-foreground">Was nach dem Setup steht</p>
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className="rounded-[1.2rem] bg-surface-muted px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Firmenkopf</p>
                      <p className="mt-2 text-sm font-medium text-foreground">
                        {trim(draft.company.name) || 'Noch offen'}
                      </p>
                    </div>
                    <div className="rounded-[1.2rem] bg-surface-muted px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Steuer</p>
                      <p className="mt-2 text-sm font-medium text-foreground">
                        {draft.legal.smallBusinessRule
                          ? 'Kleinunternehmerregelung aktiv'
                          : `${draft.legal.defaultVatRate}% Standard-MwSt.`}
                      </p>
                    </div>
                    <div className="rounded-[1.2rem] bg-surface-muted px-4 py-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Zahlungsziel</p>
                      <p className="mt-2 text-sm font-medium text-foreground">
                        {draft.legal.paymentTermsDays} Tage
                      </p>
                    </div>
                    <div className="rounded-[1.2rem] bg-surface-muted px-4 py-3">
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
                  ? 'Du kannst spaeter weitere Einstellungen im Bereich Einstellungen ergaenzen.'
                  : 'Pflichtfelder helfen dir, direkt professionelle Dokumente zu erstellen.'}
              </p>
              <div className="flex flex-col gap-3 sm:flex-row">
                {stepIndex > 0 && (
                  <Button
                    variant="secondary"
                    onClick={() => setStepIndex((current) => Math.max(current - 1, 0))}
                  >
                    Zurueck
                  </Button>
                )}
                {stepIndex < STEPS.length - 1 ? (
                  <Button onClick={handleNext}>
                    Weiter zu {STEPS[stepIndex + 1]?.label}
                  </Button>
                ) : (
                  <Button onClick={() => void handleSubmit()} disabled={saving}>
                    {saving ? 'Speichere Einrichtung...' : submitLabel}
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
