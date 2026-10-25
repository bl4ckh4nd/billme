import React from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '../Button';
import { Input } from '../Input';
import { PasswordField } from './PasswordField';

/** Invitation, password reset and dead links: the auth screen's secondary flows. */

export interface InvitationPreview {
  email: string;
  role: 'owner' | 'admin' | 'accountant' | 'sales' | 'viewer';
  workspaceName: string;
  product: 'lite' | 'pro';
  userExists: boolean;
}

const ROLE_LABELS: Record<InvitationPreview['role'], string> = {
  owner: 'Inhaber', admin: 'Admin', accountant: 'Buchhaltung', sales: 'Vertrieb', viewer: 'Lesezugriff',
};

const MIN_PASSWORD_LENGTH = 12;

export const FormAlert: React.FC<{ message: string | null }> = ({ message }) => message ? (
  <div role="alert" className="flex gap-2.5 rounded-md border border-error-border bg-error-bg px-4 py-3 text-sm text-error-text">
    <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
    <p>{message}</p>
  </div>
) : null;

const FormNotice: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div role="status" className="flex gap-2.5 rounded-md border border-border bg-surface-muted px-4 py-3 text-sm text-foreground">
    <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
    <p>{children}</p>
  </div>
);

const LinkButton: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className="rounded-sm text-sm font-semibold text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
  >
    {children}
  </button>
);

const useSubmit = (describeError: (error: unknown) => string) => {
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const run = async (work: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run, setError };
};

export const InviteForm: React.FC<{
  invitation: InvitationPreview;
  onAccept: (input: { password: string; fullName?: string }) => Promise<void>;
  describeError: (error: unknown) => string;
}> = ({ invitation, onAccept, describeError }) => {
  const [fullName, setFullName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [nameError, setNameError] = React.useState<string>();
  const [passwordError, setPasswordError] = React.useState<string>();
  const { error, busy, run } = useSubmit(describeError);
  const isNew = !invitation.userExists;
  return (
    <form
      noValidate
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        const nextName = isNew && !fullName.trim() ? 'Bitte gib deinen Namen ein.' : undefined;
        const nextPassword = !password
          ? 'Bitte gib ein Passwort ein.'
          : isNew && password.length < MIN_PASSWORD_LENGTH ? `Das Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.` : undefined;
        setNameError(nextName);
        setPasswordError(nextPassword);
        if (nextName || nextPassword) return;
        void run(() => onAccept({ password, ...(isNew ? { fullName: fullName.trim() } : {}) }));
      }}
    >
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Einladung zu {invitation.workspaceName}</h1>
        <p className="text-sm text-muted">
          Du trittst als <span className="font-semibold text-foreground">{ROLE_LABELS[invitation.role]}</span> bei.
          {isNew ? ' Lege dafür dein Konto an.' : ' Melde dich mit deinem bestehenden Konto an.'}
        </p>
      </div>
      <FormAlert message={error} />
      <Input label="E-Mail-Adresse" fullWidth type="email" value={invitation.email} readOnly disabled />
      {isNew ? (
        <Input label="Dein Name" fullWidth autoComplete="name" placeholder="Vor- und Nachname" value={fullName}
          onChange={(event) => setFullName(event.target.value)} error={nameError} />
      ) : null}
      <PasswordField value={password} onChange={setPassword} autoComplete={isNew ? 'new-password' : 'current-password'}
        hint={isNew ? `Mindestens ${MIN_PASSWORD_LENGTH} Zeichen.` : undefined} error={passwordError} />
      <Button type="submit" fullWidth loading={busy}>{isNew ? 'Konto anlegen und beitreten' : 'Anmelden und beitreten'}</Button>
    </form>
  );
};

export const ResetRequestForm: React.FC<{
  initialEmail?: string;
  /** Resolves `mailConfigured: false` when the server cannot send mail at all. */
  onRequest: (email: string) => Promise<void | { mailConfigured?: boolean }>;
  onBack: () => void;
  describeError: (error: unknown) => string;
}> = ({ initialEmail = '', onRequest, onBack, describeError }) => {
  const [email, setEmail] = React.useState(initialEmail);
  const [emailError, setEmailError] = React.useState<string>();
  const [sent, setSent] = React.useState(false);
  const [noMail, setNoMail] = React.useState(false);
  const { error, busy, run } = useSubmit(describeError);
  return (
    <form
      noValidate
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        const next = !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? 'Bitte gib deine E-Mail-Adresse ein.' : undefined;
        setEmailError(next);
        if (next) return;
        void run(async () => { const result = await onRequest(email.trim()); setNoMail(result?.mailConfigured === false); setSent(true); });
      }}
    >
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Passwort zurücksetzen</h1>
        <p className="text-sm text-muted">Wir schicken dir einen Link, mit dem du ein neues Passwort festlegst. Er gilt eine Stunde.</p>
      </div>
      <FormAlert message={error} />
      {sent ? (
        noMail ? (
          <FormNotice>Auf diesem Server ist kein Mailversand eingerichtet, deshalb kommt keine Mail an. Wende dich an die Person, die Billme bei euch betreibt: Sie richtet den Mailversand ein (USESEND_API_KEY und BILLME_MAIL_FROM am Server).</FormNotice>
        ) : (
          <FormNotice>Wenn es zu {email.trim()} ein Konto gibt, ist der Link unterwegs. Schau auch im Spam-Ordner nach.</FormNotice>
        )
      ) : (
        <>
          <Input label="E-Mail-Adresse" fullWidth type="email" autoComplete="email" inputMode="email" placeholder="name@firma.de"
            value={email} onChange={(event) => setEmail(event.target.value)} error={emailError} />
          <Button type="submit" fullWidth loading={busy}>Link schicken</Button>
        </>
      )}
      <p className="text-sm text-muted"><LinkButton onClick={onBack}>Zurück zur Anmeldung</LinkButton></p>
    </form>
  );
};

export const ResetConfirmForm: React.FC<{
  onConfirm: (password: string) => Promise<void>;
  onBack: () => void;
  describeError: (error: unknown) => string;
}> = ({ onConfirm, onBack, describeError }) => {
  const [password, setPassword] = React.useState('');
  const [passwordError, setPasswordError] = React.useState<string>();
  const [done, setDone] = React.useState(false);
  const { error, busy, run } = useSubmit(describeError);
  return (
    <form
      noValidate
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        const next = password.length < MIN_PASSWORD_LENGTH ? `Das Passwort braucht mindestens ${MIN_PASSWORD_LENGTH} Zeichen.` : undefined;
        setPasswordError(next);
        if (next) return;
        void run(async () => { await onConfirm(password); setDone(true); });
      }}
    >
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Neues Passwort festlegen</h1>
      </div>
      <FormAlert message={error} />
      {done ? (
        <FormNotice>Dein Passwort ist geändert. Melde dich jetzt damit an.</FormNotice>
      ) : (
        <>
          <PasswordField label="Neues Passwort" value={password} onChange={setPassword} autoComplete="new-password"
            hint={`Mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`} error={passwordError} />
          <Button type="submit" fullWidth loading={busy}>Passwort speichern</Button>
        </>
      )}
      <p className="text-sm text-muted"><LinkButton onClick={onBack}>Zur Anmeldung</LinkButton></p>
    </form>
  );
};

export const InvalidLinkNotice: React.FC<{ message: string; onBack: () => void }> = ({ message, onBack }) => (
  <div className="grid gap-5">
    <div className="grid gap-1.5">
      <h1 className="text-2xl font-semibold tracking-tight">Dieser Link gilt nicht mehr</h1>
      <p className="text-sm text-muted">{message}</p>
    </div>
    <Button variant="secondary" fullWidth onClick={onBack}>Zur Anmeldung</Button>
  </div>
);

export { LinkButton };
