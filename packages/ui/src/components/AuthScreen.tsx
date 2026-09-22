import React from 'react';
import { AlertCircle, Info, Lock, WifiOff } from 'lucide-react';
import { cn } from '../utils/cn';
import { BillmeLogo } from './BillmeLogo';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';

export type AuthScreenMode = 'checking' | 'login' | 'setup' | 'unreachable';

export interface AuthScreenCredentials {
  fullName: string;
  email: string;
  password: string;
}

export interface AuthScreenProps {
  product: 'lite' | 'pro';
  /** `setup` creates the first account; `unreachable` replaces the form with a retry panel. */
  mode: AuthScreenMode;
  serverUrl: string;
  defaultServerUrl: string;
  /** Neutral hint such as "Du wurdest abgemeldet." shown above the form. */
  notice?: string | null;
  initialCredentials?: Partial<AuthScreenCredentials>;
  /** Rejects with the server error; the screen translates it for the user. */
  onSubmit: (credentials: AuthScreenCredentials) => Promise<void>;
  onRetry: () => void;
  /** Must reject when no Billme server answers at `url`, and only switch servers once it does. */
  onServerUrlChange: (url: string) => Promise<void>;
}

const MIN_SETUP_PASSWORD_LENGTH = 12;

const BRAND = {
  lite: {
    name: 'Billme Lite',
    headline: 'Rechnungen schreiben.',
    highlight: 'Zahlungen im Blick.',
    body: 'Angebote, Rechnungen und Kunden an einem Ort. Für Selbstständige und kleine Teams.',
  },
  pro: {
    name: 'Billme Pro',
    headline: 'Rechnungen, Belege und Buchhaltung.',
    highlight: 'An einem Ort.',
    body: 'Angebote schreiben, Zahlungen abgleichen, DATEV-Export vorbereiten. Gemeinsam im Team, mit Rollen und Freigaben.',
  },
} as const;

export const serverHost = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** Maps raw API/network errors to German copy; unknown errors never leak raw server text. */
export const describeAuthError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid email or password/i.test(message)) {
    return 'E-Mail oder Passwort stimmt nicht. Prüfe beides und versuche es noch einmal.';
  }
  if (/bootstrap already completed/i.test(message)) {
    return 'Billme ist bereits eingerichtet. Lade die Seite neu und melde dich mit deinem Konto an.';
  }
  if (/already exists/i.test(message)) {
    return 'Für diese E-Mail-Adresse gibt es schon ein Konto.';
  }
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Der Server antwortet nicht. Prüfe deine Internetverbindung und versuche es erneut.';
  }
  return 'Das hat nicht geklappt. Versuche es erneut. Hält das an, wende dich an deine Administration.';
};

const normalizeServerUrl = (value: string): string | null => {
  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
};

const InvoiceIllustration: React.FC<{ product: 'lite' | 'pro' }> = ({ product }) => (
  <div aria-hidden="true" className="relative h-44 max-w-sm">
    <div className="absolute left-0 top-0 grid w-full gap-2 rounded-md border border-dark-border bg-dark-1 px-4 py-3 opacity-60 -rotate-2">
      <div className="flex items-center justify-between gap-3 text-xs text-dark-muted">
        <span className="font-semibold text-background">RE-2026-0141</span>
        <span className="rounded-full border border-status-open-border px-2 py-0.5 font-bold">Offen</span>
      </div>
      <span className="text-xl font-bold tabular-nums text-background">2.380,00 €</span>
    </div>
    <div className="absolute left-4 top-10 grid w-full gap-2.5 rounded-md border border-dark-border bg-dark-2 px-4 py-3 rotate-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold text-background">RE-2026-0142 · Nordlicht GmbH</span>
        <span className="rounded-full bg-status-paid px-2 py-0.5 font-bold text-status-paid-text">Bezahlt</span>
      </div>
      <span className="text-xl font-bold tabular-nums text-background">1.248,50 €</span>
      <span className="h-1.5 rounded-full bg-accent" />
      <div className="flex justify-between gap-3 text-xs text-dark-muted">
        <span>Zahlung eingegangen</span>
        {product === 'pro' ? <span>SKR03 · 8400</span> : null}
      </div>
    </div>
  </div>
);

const PasswordField: React.FC<{
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  hint?: string;
  error?: string;
}> = ({ value, onChange, autoComplete, hint, error }) => {
  const id = React.useId();
  const [visible, setVisible] = React.useState(false);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-foreground">Passwort</label>
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-controls={id}
          className="rounded-sm text-xs font-semibold text-muted underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          {visible ? 'Passwort verbergen' : 'Passwort anzeigen'}
        </button>
      </div>
      <Input
        id={id}
        fullWidth
        type={visible ? 'text' : 'password'}
        autoComplete={autoComplete}
        placeholder="Passwort eingeben"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        hint={hint}
        error={error}
      />
    </div>
  );
};

export const AuthScreen: React.FC<AuthScreenProps> = ({
  product,
  mode,
  serverUrl,
  defaultServerUrl,
  notice,
  initialCredentials,
  onSubmit,
  onRetry,
  onServerUrlChange,
}) => {
  const brand = BRAND[product];
  const host = serverHost(serverUrl);
  const [fullName, setFullName] = React.useState(initialCredentials?.fullName ?? '');
  const [email, setEmail] = React.useState(initialCredentials?.email ?? '');
  const [password, setPassword] = React.useState(initialCredentials?.password ?? '');
  const [fieldErrors, setFieldErrors] = React.useState<Partial<Record<keyof AuthScreenCredentials, string>>>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const [serverDialogOpen, setServerDialogOpen] = React.useState(false);
  const [serverDraft, setServerDraft] = React.useState(serverUrl);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [serverSaving, setServerSaving] = React.useState(false);
  const serverTitleId = React.useId();
  const serverDescriptionId = React.useId();

  const isSetup = mode === 'setup';

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: typeof fieldErrors = {};
    if (isSetup && !fullName.trim()) nextErrors.fullName = 'Bitte gib deinen Namen ein.';
    if (!email.trim()) nextErrors.email = 'Bitte gib deine E-Mail-Adresse ein.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) nextErrors.email = 'Das sieht nicht nach einer E-Mail-Adresse aus.';
    if (!password) nextErrors.password = 'Bitte gib dein Passwort ein.';
    else if (isSetup && password.length < MIN_SETUP_PASSWORD_LENGTH) {
      nextErrors.password = `Das Passwort braucht mindestens ${MIN_SETUP_PASSWORD_LENGTH} Zeichen.`;
    }
    setFieldErrors(nextErrors);
    setSubmitError(null);
    if (Object.keys(nextErrors).length > 0) return;

    setSubmitting(true);
    try {
      await onSubmit({ fullName: fullName.trim(), email: email.trim(), password });
    } catch (error) {
      setSubmitError(describeAuthError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const openServerDialog = () => {
    setServerDraft(serverUrl);
    setServerError(null);
    setServerDialogOpen(true);
  };

  const saveServerUrl = async (candidate: string) => {
    const normalized = normalizeServerUrl(candidate);
    if (!normalized) {
      setServerError('Bitte gib eine vollständige Adresse ein, zum Beispiel https://billme.firma.de');
      return;
    }
    setServerSaving(true);
    setServerError(null);
    try {
      await onServerUrlChange(normalized);
      setServerDialogOpen(false);
    } catch {
      setServerError('Unter dieser Adresse antwortet kein Billme-Server. Prüfe die Schreibweise.');
    } finally {
      setServerSaving(false);
    }
  };

  const connection = {
    checking: { dot: 'bg-muted', text: `Verbindung zu ${host} wird geprüft` },
    unreachable: { dot: 'bg-error', text: `Keine Verbindung zu ${host}` },
    login: { dot: 'bg-success', text: `Verbunden mit ${host}` },
    setup: { dot: 'bg-success', text: `Verbunden mit ${host}` },
  }[mode];

  return (
    <div className="grid min-h-screen bg-background text-foreground [color-scheme:light] lg:grid-cols-2">
      <aside className="hidden flex-col justify-between gap-10 overflow-hidden bg-dark-base px-12 py-10 text-background lg:flex">
        <BillmeLogo className="h-10 w-auto self-start text-background" />
        <div className="grid gap-10">
          <div className="grid gap-4">
            <p className="max-w-md text-4xl font-extrabold leading-tight tracking-tight text-balance">
              {brand.headline} <span className="text-accent">{brand.highlight}</span>
            </p>
            <p className="max-w-sm text-sm leading-relaxed text-dark-muted">{brand.body}</p>
          </div>
          <InvoiceIllustration product={product} />
        </div>
        <p className="flex items-center gap-2 text-xs text-dark-muted">
          <Lock aria-hidden="true" className="size-3.5 text-accent" strokeWidth={2.4} />
          Eure Daten bleiben auf eurem Server.
        </p>
      </aside>

      <main className="flex min-w-0 flex-col">
        <header className="border-b border-border-subtle px-5 py-4 lg:hidden">
          <BillmeLogo className="h-8 w-auto text-foreground" />
        </header>

        <div className="flex flex-1 items-start justify-center px-5 py-10 sm:items-center">
          <div className="w-full max-w-sm">
            {mode === 'checking' ? (
              <div role="status" className="flex items-center justify-center gap-3 text-sm text-muted">
                <span aria-hidden="true" className="size-4 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin motion-reduce:animate-none" />
                Verbindung wird geprüft …
              </div>
            ) : mode === 'unreachable' ? (
              <div className="grid gap-6">
                <WifiOff aria-hidden="true" className="size-10 text-foreground" strokeWidth={1.8} />
                <div className="grid gap-2">
                  <h1 className="text-2xl font-bold tracking-tight">Billme ist gerade nicht erreichbar</h1>
                  <p className="text-sm text-muted">
                    Wir erreichen <span className="font-semibold text-foreground">{host}</span> nicht. Prüfe deine
                    Internetverbindung. Hält das an, sag deiner Administration Bescheid.
                  </p>
                </div>
                <div className="grid gap-3">
                  <Button variant="dark" fullWidth onClick={onRetry}>Erneut versuchen</Button>
                  <Button variant="secondary" fullWidth onClick={openServerDialog}>Server-Adresse ändern</Button>
                </div>
              </div>
            ) : (
              <form noValidate onSubmit={(event) => void handleSubmit(event)} className="grid gap-5">
                <div className="grid gap-1.5">
                  <h1 className="text-2xl font-bold tracking-tight">{isSetup ? 'Billme einrichten' : 'Willkommen zurück'}</h1>
                  <p className="text-sm text-muted">
                    {isSetup
                      ? 'Lege das erste Konto an. Es erhält alle Rechte und kann danach weitere Personen einladen.'
                      : `Melde dich bei ${brand.name} an.`}
                  </p>
                </div>

                {submitError ? (
                  <div role="alert" className="flex gap-2.5 rounded-md border border-error-border bg-error-bg px-4 py-3 text-sm text-error-text">
                    <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <p>{submitError}</p>
                  </div>
                ) : notice ? (
                  <div role="status" className="flex gap-2.5 rounded-md border border-border bg-surface-muted px-4 py-3 text-sm text-foreground">
                    <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
                    <p>{notice}</p>
                  </div>
                ) : null}

                {isSetup ? (
                  <Input
                    label="Dein Name"
                    fullWidth
                    autoComplete="name"
                    placeholder="Vor- und Nachname"
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    error={fieldErrors.fullName}
                  />
                ) : null}
                <Input
                  label="E-Mail-Adresse"
                  fullWidth
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="name@firma.de"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  error={fieldErrors.email}
                />
                <PasswordField
                  value={password}
                  onChange={setPassword}
                  autoComplete={isSetup ? 'new-password' : 'current-password'}
                  hint={isSetup ? `Mindestens ${MIN_SETUP_PASSWORD_LENGTH} Zeichen.` : undefined}
                  error={fieldErrors.password}
                />

                <Button type="submit" fullWidth loading={submitting}>
                  {isSetup ? 'Konto anlegen und loslegen' : 'Anmelden'}
                </Button>

                {/* ponytail: the server has no password-reset endpoint; replace this hint with a reset link once one exists. */}
                {!isSetup ? (
                  <p className="text-xs text-muted">
                    Passwort vergessen? <span className="font-semibold text-foreground">Frag die Person, die Billme bei euch eingerichtet hat.</span>
                  </p>
                ) : null}
              </form>
            )}
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-t border-border-subtle px-6 py-4 text-xs text-muted">
          <span aria-hidden="true" className={cn('size-2 rounded-full', connection.dot)} />
          <span>{connection.text}</span>
          {mode !== 'unreachable' ? (
            <button
              type="button"
              onClick={openServerDialog}
              aria-label="Server-Adresse ändern"
              className="rounded-sm font-semibold text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              Ändern
            </button>
          ) : null}
        </footer>
      </main>

      <Modal
        open={serverDialogOpen}
        onClose={() => setServerDialogOpen(false)}
        titleId={serverTitleId}
        descriptionId={serverDescriptionId}
        ariaBusy={serverSaving}
        className="max-w-md p-6"
      >
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void saveServerUrl(serverDraft);
          }}
          className="grid gap-5"
        >
          <div className="grid gap-1">
            <h2 id={serverTitleId} className="text-lg font-bold tracking-tight">Server-Adresse</h2>
            <p id={serverDescriptionId} className="text-sm text-muted">
              Nur ändern, wenn deine Administration dir eine andere Adresse genannt hat.
            </p>
          </div>
          <Input
            label="Adresse"
            fullWidth
            type="url"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            value={serverDraft}
            onChange={(event) => setServerDraft(event.target.value)}
            error={serverError ?? undefined}
          />
          <div className="flex flex-wrap justify-end gap-3">
            {serverUrl !== defaultServerUrl ? (
              <Button variant="secondary" disabled={serverSaving} onClick={() => void saveServerUrl(defaultServerUrl)}>
                Standard wiederherstellen
              </Button>
            ) : (
              <Button variant="secondary" disabled={serverSaving} onClick={() => setServerDialogOpen(false)}>
                Abbrechen
              </Button>
            )}
            <Button type="submit" loading={serverSaving}>Speichern</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
