import React from 'react';
import { Button } from './Button';
import type { ButtonProps } from './Button';

export interface AuthScreenStat {
  label: string;
  value: string;
  hint?: string;
}

export interface AuthScreenProps {
  /** Small brand label shown above the hero title, e.g. "Billme Lite Web". */
  productLabel: string;
  /** Hero headline, e.g. "Sign in to Billme Lite". */
  title: string;
  description?: string;
  stats?: AuthScreenStat[];
  roles?: string[];
  formEyebrow?: string;
  formTitle: string;
  formDescription?: string;
  message?: string | null;
  messageTone?: 'neutral' | 'danger';
  onSubmit: (event: React.FormEvent) => void;
  submitLabel: string;
  submitLoading?: boolean;
  submitButtonProps?: Partial<ButtonProps>;
  footer?: React.ReactNode;
  children: React.ReactNode;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  productLabel,
  title,
  description,
  stats = [],
  roles = [],
  formEyebrow,
  formTitle,
  formDescription,
  message,
  messageTone = 'neutral',
  onSubmit,
  submitLabel,
  submitLoading = false,
  submitButtonProps,
  footer,
  children,
}) => {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-8 sm:px-6">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-3xl border border-black/5 bg-surface shadow-[0_28px_90px_rgba(15,23,42,0.14)] lg:grid-cols-[1.05fr_1fr]">
        <aside className="relative overflow-hidden bg-dark-base px-8 py-10 text-white sm:px-10 lg:px-12">
          <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-accent/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 -left-16 h-72 w-72 rounded-full bg-accent/5 blur-3xl" />

          <div className="relative flex h-full flex-col">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-accent">
              {productLabel}
            </p>
            <h1 className="mt-4 max-w-md text-4xl font-semibold leading-tight tracking-[-0.02em] sm:text-[2.75rem]">
              {title}
            </h1>
            {description ? (
              <p className="mt-4 max-w-md text-sm leading-6 text-dark-muted">
                {description}
              </p>
            ) : null}

            {stats.length > 0 ? (
              <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2">
                {stats.map((stat) => (
                  <div
                    key={stat.label}
                    className="rounded-2xl border border-dark-border bg-white/5 p-4"
                  >
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-dark-muted">
                      {stat.label}
                    </p>
                    <p className="mt-2 truncate text-lg font-semibold tabular-nums">
                      {stat.value}
                    </p>
                    {stat.hint ? (
                      <p className="mt-1 truncate text-xs text-dark-muted">{stat.hint}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {roles.length > 0 ? (
              <div className="mt-6 flex flex-wrap gap-2">
                {roles.map((role) => (
                  <span
                    key={role}
                    className="rounded-full border border-dark-border bg-white/5 px-3 py-1 text-xs font-medium text-white/80"
                  >
                    {role}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="mt-auto hidden pt-10 lg:block">
              <div className="h-px w-full bg-dark-border" />
              <p className="mt-6 text-xs text-dark-muted">
                Powered by Billme &middot; secure, server-backed workspaces
              </p>
            </div>
          </div>
        </aside>

        <main className="flex flex-col justify-center bg-surface px-8 py-10 sm:px-10 lg:px-12">
          {formEyebrow ? (
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
              {formEyebrow}
            </p>
          ) : null}
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.01em] text-foreground">
            {formTitle}
          </h2>
          {formDescription ? (
            <p className="mt-2 text-sm leading-6 text-muted">{formDescription}</p>
          ) : null}

          {message ? (
            <div
              className={
                messageTone === 'danger'
                  ? 'mt-5 rounded-xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error'
                  : 'mt-5 rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm text-foreground'
              }
            >
              {message}
            </div>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit(event);
            }}
            className="mt-6 grid gap-4"
          >
            {children}

            <Button
              type="submit"
              fullWidth
              loading={submitLoading}
              {...submitButtonProps}
            >
              {submitLabel}
            </Button>
          </form>

          {footer ? <div className="mt-6 text-sm text-muted">{footer}</div> : null}
        </main>
      </div>
    </div>
  );
};
