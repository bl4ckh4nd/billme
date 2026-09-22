import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthScreen, type AuthScreenProps } from '@billme/ui';
import { describe, expect, it, vi } from 'vitest';

const renderScreen = (overrides: Partial<AuthScreenProps> = {}) => {
  const props: AuthScreenProps = {
    product: 'pro',
    mode: 'login',
    serverUrl: 'https://billme.example.de',
    defaultServerUrl: 'https://billme.example.de',
    onSubmit: vi.fn().mockResolvedValue(undefined),
    onRetry: vi.fn(),
    onServerUrlChange: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(<AuthScreen {...props} />);
  return props;
};

const fillLogin = (email: string, password: string) => {
  fireEvent.change(screen.getByLabelText('E-Mail-Adresse'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Passwort'), { target: { value: password } });
};

describe('AuthScreen', () => {
  it('submits the login form and translates a rejected login into German', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Invalid email or password'));
    renderScreen({ onSubmit });

    expect(screen.queryByLabelText('Dein Name')).not.toBeInTheDocument();
    fillLogin(' jana@firma.de ', 'geheim');
    fireEvent.submit(screen.getByRole('button', { name: 'Anmelden' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ fullName: '', email: 'jana@firma.de', password: 'geheim' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('E-Mail oder Passwort stimmt nicht.');
    expect(screen.queryByText(/Invalid email/)).not.toBeInTheDocument();
  });

  it('asks for a name and a 12-character password before creating the first account', () => {
    const onSubmit = vi.fn();
    renderScreen({ mode: 'setup', onSubmit });

    fireEvent.change(screen.getByLabelText('Dein Name'), { target: { value: 'Jana Weber' } });
    fillLogin('jana@firma.de', 'zu-kurz');
    fireEvent.submit(screen.getByRole('button', { name: 'Konto anlegen und loslegen' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Das Passwort braucht mindestens 12 Zeichen.')).toBeInTheDocument();
  });

  it('keeps the server address out of the form and only switches after the new server answers', async () => {
    const onServerUrlChange = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    renderScreen({ onServerUrlChange });

    expect(screen.queryByLabelText('Adresse')).not.toBeInTheDocument();
    expect(screen.getByText('Verbunden mit billme.example.de')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Server-Adresse ändern' }));
    const address = screen.getByLabelText('Adresse');

    fireEvent.change(address, { target: { value: 'kein-server' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText(/vollständige Adresse/)).toBeInTheDocument();
    expect(onServerUrlChange).not.toHaveBeenCalled();

    fireEvent.change(address, { target: { value: 'https://andere.example.de/' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(onServerUrlChange).toHaveBeenCalledWith('https://andere.example.de'));
    expect(await screen.findByText(/antwortet kein Billme-Server/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Server-Adresse' })).toBeInTheDocument();
  });

  it('replaces the form with a retry panel when the server is unreachable', () => {
    const onRetry = vi.fn();
    renderScreen({ mode: 'unreachable', onRetry });

    expect(screen.queryByLabelText('E-Mail-Adresse')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
