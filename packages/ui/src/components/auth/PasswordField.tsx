import React from 'react';
import { Input } from '../Input';

export const PasswordField: React.FC<{
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  hint?: string;
  error?: string;
  label?: string;
}> = ({ value, onChange, autoComplete, hint, error, label = 'Passwort' }) => {
  const id = React.useId();
  const [visible, setVisible] = React.useState(false);
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-label text-foreground">{label}</label>
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
