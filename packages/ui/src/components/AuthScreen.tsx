import React from 'react';
import { Info, Lock, WifiOff } from 'lucide-react';
import { cn } from '../utils/cn';
import { BillmeLogo } from './BillmeLogo';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';
import { FormAlert, InvalidLinkNotice, InviteForm, LinkButton, ResetConfirmForm, ResetRequestForm, type InvitationPreview } from './auth/AuthFlows';
import { PasswordField } from './auth/PasswordField';

export type AuthScreenMode =
  | 'checking' | 'login' | 'setup' | 'unreachable'
  /** Another workspace with the setup code, from the login screen. */
  | 'signup'
  | 'invite' | 'reset-request' | 'reset-confirm' | 'invalid-link';
export type { InvitationPreview };

export interface AuthScreenCredentials {
  fullName: string;
  email: string;
  password: string;
  /** Only sent while setting up a server that requires a setup code. */
  setupToken?: string;
  /** Set up and sign-up: the new workspace's name and product. */
  workspaceName?: string;
  product?: 'lite' | 'pro';
}

export interface AuthScreenProps {
  product: 'lite' | 'pro';
  /** `setup` creates the first account; `unreachable` replaces the form with a retry panel. */
  mode: AuthScreenMode;
  serverUrl: string;
  defaultServerUrl: string;
  /** Neutral hint such as "Du wurdest abgemeldet." shown above the form. */
  notice?: string | null;
  /** The server only accepts the first account together with its setup code (BILLME_SETUP_TOKEN). */
  setupTokenRequired?: boolean;
  /** Offers "Neuen Workspace anlegen" on the login screen. */
  signupAvailable?: boolean;
  /** The invitation behind an `?invite=` link (mode `invite`). */
  invitation?: InvitationPreview;
  /** Why a link is dead (mode `invalid-link`). */
  invalidLinkMessage?: string;
  onAcceptInvitation?: (input: { password: string; fullName?: string }) => Promise<void>;
  onRequestReset?: (email: string) => Promise<void>;
  onConfirmReset?: (password: string) => Promise<void>;
  onModeChange?: (mode: AuthScreenMode) => void;
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
  if (/no longer valid/i.test(message)) {
    return 'Dieser Link gilt nicht mehr. Bitte lass dir einen neuen schicken.';
  }
  if (/too many|zu viele/i.test(message)) {
    return 'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.';
  }
  if (/invalid setup token/i.test(message)) {
    return 'Der Einrichtungscode stimmt nicht. Du findest ihn in der Server-Konfiguration unter BILLME_SETUP_TOKEN.';
  }
  if (/bootstrap already completed/i.test(message)) {
    return 'Billme ist bereits eingerichtet. Lade die Seite neu und melde dich mit deinem Konto an.';
  }
  if (/already exists/i.test(message)) {
    return 'Für diese E-Mail-Adresse gibt es schon ein Konto. Melde dich an und lege den Workspace über den Workspace-Wechsler an.';
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
        <span className="rounded-full border border-status-open-border px-2 py-0.5 font-semibold">Offen</span>
      </div>
      <span className="text-xl font-semibold tabular-nums text-background">2.380,00 €</span>
    </div>
    <div className="absolute left-4 top-10 grid w-full gap-2.5 rounded-md border border-dark-border bg-dark-2 px-4 py-3 rotate-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-semibold text-background">RE-2026-0142 · Nordlicht GmbH</span>
        <span className="rounded-full bg-status-paid px-2 py-0.5 font-semibold text-status-paid-text">Bezahlt</span>
      </div>
      <span className="text-xl font-semibold tabular-nums text-background">1.248,50 €</span>
      <span className="h-1.5 rounded-full bg-accent" />
      <div className="flex justify-between gap-3 text-xs text-dark-muted">
        <span>Zahlung eingegangen</span>
        {product === 'pro' ? <span>SKR03 · 8400</span> : null}
      </div>
    </div>
  </div>
);

export const AuthScreen: React.FC<AuthScreenProps> = ({
  product,
  mode,
  serverUrl,
  defaultServerUrl,
  notice,
  setupTokenRequired = false,
  signupAvailable = false,
  invitation,
  invalidLinkMessage,
  onAcceptInvitation,
  onRequestReset,
  onConfirmReset,
  onModeChange,
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
  const [setupToken, setSetupToken] = React.useState('');
  const [workspaceName, setWorkspaceName] = React.useState('');
  const [signupProduct, setSignupProduct] = React.useState<'lite' | 'pro'>(product);
  const [fieldErrors, setFieldErrors] = React.useState<Partial<Record<keyof AuthScreenCredentials, string>>>({});
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const [serverDialogOpen, setServerDialogOpen] = React.useState(false);
  const [serverDraft, setServerDraft] = React.useState(serverUrl);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [serverSaving, setServerSaving] = React.useState(false);
  const serverTitleId = React.useId();
  const serverDescriptionId = React.useId();

  const isSignup = mode === 'signup';
  const isSetup = mode === 'setup' || isSignup;
  const needsSetupToken = isSetup && setupTokenRequired;
  const backToLogin = () => onModeChange?.('login');

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: typeof fieldErrors = {};
    if (needsSetupToken && !setupToken.trim()) nextErrors.setupToken = 'Bitte gib den Einrichtungscode ein.';
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
      await onSubmit({
        fullName: fullName.trim(),
        email: email.trim(),
        password,
        ...(needsSetupToken ? { setupToken: setupToken.trim() } : {}),
        ...(isSetup ? { workspaceName: workspaceName.trim() || fullName.trim(), product: isSignup ? signupProduct : product } : {}),
      });
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
  }[mode === 'checking' || mode === 'unreachable' || mode === 'setup' ? mode : 'login'];

  return (
    <div className="grid min-h-screen bg-background text-foreground [color-scheme:light] lg:grid-cols-2">
      <aside className="hidden flex-col justify-between gap-10 overflow-hidden bg-dark-base px-12 py-10 text-inverse-foreground lg:flex">
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
                  <h1 className="text-2xl font-semibold tracking-tight">Billme ist gerade nicht erreichbar</h1>
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
            ) : mode === 'invite' && invitation && onAcceptInvitation ? (
              <InviteForm invitation={invitation} onAccept={onAcceptInvitation} describeError={describeAuthError} />
            ) : mode === 'reset-request' && onRequestReset ? (
              <ResetRequestForm initialEmail={email} onRequest={onRequestReset} onBack={backToLogin} describeError={describeAuthError} />
            ) : mode === 'reset-confirm' && onConfirmReset ? (
              <ResetConfirmForm onConfirm={onConfirmReset} onBack={backToLogin} describeError={describeAuthError} />
            ) : mode === 'invalid-link' ? (
              <InvalidLinkNotice message={invalidLinkMessage ?? 'Bitte lass dir einen neuen Link schicken.'} onBack={backToLogin} />
            ) : (
              <form noValidate onSubmit={(event) => void handleSubmit(event)} className="grid gap-5">
                <div className="grid gap-1.5">
                  <h1 className="text-2xl font-semibold tracking-tight">{isSignup ? 'Neuen Workspace anlegen' : isSetup ? 'Billme einrichten' : 'Willkommen zurück'}</h1>
                  <p className="text-sm text-muted">
                    {isSignup
                      ? 'Für ein neues Unternehmen: Du wirst Inhaber des Workspace und lädst danach dein Team ein.'
                      : isSetup
                        ? 'Lege das erste Konto an. Es erhält alle Rechte.'
                        : `Melde dich bei ${brand.name} an.`}
                  </p>
                </div>

                {submitError ? (
                  <FormAlert message={submitError} />
                ) : notice ? (
                  <div role="status" className="flex gap-2.5 rounded-md border border-border bg-surface-muted px-4 py-3 text-sm text-foreground">
                    <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
                    <p>{notice}</p>
                  </div>
                ) : null}

                {needsSetupToken ? (
                  <Input
                    label="Einrichtungscode"
                    fullWidth
                    autoComplete="off"
                    spellCheck={false}
                    hint="Steht in der Server-Konfiguration unter BILLME_SETUP_TOKEN."
                    value={setupToken}
                    onChange={(event) => setSetupToken(event.target.value)}
                    error={fieldErrors.setupToken}
                  />
                ) : null}
                {isSetup ? (
                  <Input
                    label="Name des Workspace"
                    fullWidth
                    autoComplete="organization"
                    placeholder="z. B. Muster GmbH"
                    hint="Meist der Firmenname. Leer lassen übernimmt deinen Namen."
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                  />
                ) : null}
                {isSignup ? (
                  <fieldset className="grid gap-2">
                    <legend className="mb-1.5 text-label text-foreground">Produkt</legend>
                    <div className="grid grid-cols-2 gap-2">
                      {(['lite', 'pro'] as const).map((option) => (
                        <label
                          key={option}
                          className={cn(
                            'flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2.5 text-sm has-focus-visible:outline-2 has-focus-visible:outline-focus-ring',
                            signupProduct === option ? 'border-foreground bg-surface-muted' : 'border-border',
                          )}
                        >
                          <input type="radio" name="signup-product" value={option} checked={signupProduct === option}
                            onChange={() => setSignupProduct(option)} className="sr-only" />
                          <span className="font-semibold text-foreground">{BRAND[option].name}</span>
                          <span className="text-xs text-muted">{option === 'lite' ? 'Rechnungen und Angebote' : 'Mit Buchhaltung und DATEV'}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
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
                  {isSignup ? 'Workspace anlegen' : isSetup ? 'Konto anlegen und loslegen' : 'Anmelden'}
                </Button>

                {!isSetup ? (
                  <div className="flex flex-wrap justify-between gap-3 text-sm text-muted">
                    {onRequestReset ? (
                      <LinkButton onClick={() => onModeChange?.('reset-request')}>Passwort vergessen?</LinkButton>
                    ) : (
                      <span className="text-xs">Passwort vergessen? Frag die Person, die Billme bei euch eingerichtet hat.</span>
                    )}
                    {signupAvailable ? <LinkButton onClick={() => onModeChange?.('signup')}>Neuen Workspace anlegen</LinkButton> : null}
                  </div>
                ) : isSignup ? (
                  <p className="text-sm text-muted">Schon ein Konto? <LinkButton onClick={backToLogin}>Anmelden</LinkButton></p>
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
            <h2 id={serverTitleId} className="text-lg font-semibold tracking-tight">Server-Adresse</h2>
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
