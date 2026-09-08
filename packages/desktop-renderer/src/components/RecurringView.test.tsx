import React from 'react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackProvider } from '@billme/ui';
import type { Client, RecurringProfile } from '@billme/desktop-core/types';

const mocks = vi.hoisted(() => ({
    profiles: [] as RecurringProfile[],
    upsert: vi.fn(),
    toggle: vi.fn(),
    manualRun: vi.fn(),
}));

const client = {
    id: 'client-1',
    company: 'Nord GmbH',
} as Client;

const savedProfile: RecurringProfile = {
    id: 'recurring-1',
    clientId: client.id,
    active: true,
    name: 'Wartungsvertrag',
    interval: 'monthly',
    nextRun: '2026-09-10',
    amount: 10,
    items: [{ description: 'Wartung', quantity: 1, price: 10, total: 10 }],
};

vi.mock('../hooks/useClients', () => ({
    useClientsQuery: () => ({ data: [client] }),
}));
vi.mock('../hooks/useRecurring', () => ({
    useRecurringProfilesQuery: () => ({ data: mocks.profiles }),
    useUpsertRecurringProfileMutation: () => ({ mutate: mocks.toggle, mutateAsync: mocks.upsert, isPending: false }),
    useDeleteRecurringProfileMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock('../hooks/useDeferredDelete', () => ({
    useDeferredDelete: () => ({ pendingIds: new Set<string>(), requestDelete: vi.fn() }),
}));
vi.mock('../runtime-api', () => ({
    ipc: { recurring: { manualRun: mocks.manualRun } },
}));

import { RecurringView } from './RecurringView';

const renderView = () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <FeedbackProvider>
                <RecurringView />
            </FeedbackProvider>
        </QueryClientProvider>,
    );
};

describe('RecurringView', () => {
    beforeEach(() => {
        mocks.profiles.length = 0;
        mocks.upsert.mockReset();
        mocks.toggle.mockReset();
        mocks.manualRun.mockReset();
        mocks.upsert.mockResolvedValue(savedProfile);
        mocks.manualRun.mockResolvedValue({ success: true, result: { generated: 0, deactivated: 0, errors: [] } });
    });

    it('rejects an empty profile after all positions are removed and focuses the position block', async () => {
        const user = userEvent.setup();
        renderView();

        await user.click(screen.getByRole('button', { name: /Neues Abo/ }));
        await user.click(screen.getByRole('button', { name: 'Position entfernen' }));
        await user.click(screen.getByRole('button', { name: 'Speichern' }));

        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(screen.getAllByRole('alert').find((alert) => /abrechenbare Position/i.test(alert.textContent ?? ''))).toBeTruthy();
        expect(screen.getByRole('button', { name: /\+ Position/ })).toHaveFocus();
        expect(screen.getByRole('heading', { name: 'Neues Abo' })).toBeInTheDocument();
    });

    it('rejects a zero total without calling upsert and keeps the modal open', async () => {
        const user = userEvent.setup();
        renderView();

        await user.click(screen.getByRole('button', { name: /Neues Abo/ }));
        await user.clear(screen.getByLabelText('Preis (€)'));
        await user.type(screen.getByLabelText('Preis (€)'), '0');
        await user.click(screen.getByRole('button', { name: 'Speichern' }));

        expect(mocks.upsert).not.toHaveBeenCalled();
        expect(screen.getAllByRole('alert').find((alert) => /Gesamtsumme.*größer als 0/i.test(alert.textContent ?? ''))).toBeTruthy();
        expect(screen.getByLabelText('Preis (€)')).toHaveFocus();
        expect(screen.getByRole('heading', { name: 'Neues Abo' })).toBeInTheDocument();
    });

    it('waits for a successful upsert before closing and translates partial run results', async () => {
        const user = userEvent.setup();
        let resolveSave: (profile: RecurringProfile) => void = () => undefined;
        mocks.upsert.mockImplementation(() => new Promise<RecurringProfile>((resolve) => {
            resolveSave = resolve;
        }));
        renderView();

        await user.click(screen.getByRole('button', { name: /Neues Abo/ }));
        await user.type(screen.getByPlaceholderText('z.B. Wartungsvertrag 2024'), 'Wartung');
        await user.clear(screen.getByLabelText('Preis (€)'));
        await user.type(screen.getByLabelText('Preis (€)'), '10');
        await user.click(screen.getByRole('button', { name: 'Speichern' }));

        expect(mocks.upsert).toHaveBeenCalledOnce();
        expect(screen.getByRole('heading', { name: 'Neues Abo' })).toBeInTheDocument();

        resolveSave(savedProfile);
        await waitFor(() => expect(screen.queryByRole('heading', { name: 'Neues Abo' })).not.toBeInTheDocument());

        mocks.profiles.push(savedProfile);
        mocks.manualRun.mockResolvedValue({
            success: true,
            result: {
                generated: 2,
                deactivated: 0,
                errors: [{ profileName: 'Fehlerprofil', error: 'CLIENT_NOT_FOUND' }],
            },
        });
        renderView();
        await user.click(screen.getByRole('button', { name: 'Jetzt ausführen' }));

        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('2 erstellt, 1 Profil übersprungen'));
        expect(screen.queryByText('CLIENT_NOT_FOUND')).not.toBeInTheDocument();

        mocks.manualRun.mockResolvedValue({
            success: true,
            result: {
                generated: 3,
                deactivated: 0,
                errors: [
                    { profileName: 'Fehlerprofil 1', error: 'CLIENT_NOT_FOUND' },
                    { profileName: 'Fehlerprofil 2', error: 'CLIENT_NOT_FOUND' },
                ],
            },
        });
        await user.click(screen.getByRole('button', { name: 'Jetzt ausführen' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('3 erstellt, 2 Profile übersprungen'));
    });

    it('keeps the modal open and shows a German error when saving fails', async () => {
        const user = userEvent.setup();
        mocks.upsert.mockRejectedValue(new Error('CLIENT_NOT_FOUND'));
        renderView();

        await user.click(screen.getByRole('button', { name: /Neues Abo/ }));
        await user.type(screen.getByPlaceholderText('z.B. Wartungsvertrag 2024'), 'Wartung');
        await user.clear(screen.getByLabelText('Preis (€)'));
        await user.type(screen.getByLabelText('Preis (€)'), '10');
        await user.click(screen.getByRole('button', { name: 'Speichern' }));

        await waitFor(() => expect(screen.getAllByRole('alert').find((alert) => /Abo konnte nicht gespeichert werden/.test(alert.textContent ?? ''))).toBeTruthy());
        expect(screen.getByRole('heading', { name: 'Neues Abo' })).toBeInTheDocument();
        expect(screen.queryByText('CLIENT_NOT_FOUND')).not.toBeInTheDocument();
    });

    it('shows a German error when pausing an existing profile fails', async () => {
        const user = userEvent.setup();
        mocks.profiles.push(savedProfile);
        mocks.upsert.mockRejectedValue(new Error('RECURRING_PROFILE_INVALID'));
        renderView();

        await user.click(screen.getByRole('button', { name: 'Aktiv' }));

        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Abo konnte nicht pausiert werden.'));
        expect(screen.queryByText('RECURRING_PROFILE_INVALID')).not.toBeInTheDocument();
    });
});
