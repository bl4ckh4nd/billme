import { useEffect, useRef } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';

export type CreateIntent = 'invoice' | 'offer' | 'client' | 'project' | 'article';

/**
 * Starts a page's create flow when the URL carries `?create=<intent>` (the
 * command palette links there), then drops the parameter so a reload or the
 * back button does not create a second record. Runs once per link even under
 * StrictMode's double effects, which matters because creating an invoice
 * reserves a number.
 */
export const useCreateIntent = <T extends CreateIntent>(
  path: string,
  intents: readonly T[],
  onCreate: (intent: T) => void,
  ready = true,
): void => {
  const navigate = useNavigate();
  const search = useRouterState({ select: (state) => state.location.search }) as Record<string, unknown>;
  const intent = intents.find((candidate) => candidate === search.create);
  const onCreateRef = useRef(onCreate);
  onCreateRef.current = onCreate;
  const handledRef = useRef(false);

  useEffect(() => {
    if (!intent) {
      handledRef.current = false;
      return;
    }
    if (!ready || handledRef.current) return;
    handledRef.current = true;
    const { create: _create, ...rest } = search;
    void navigate({ to: path, search: rest, replace: true });
    onCreateRef.current(intent);
  }, [intent, navigate, path, ready, search]);
};
