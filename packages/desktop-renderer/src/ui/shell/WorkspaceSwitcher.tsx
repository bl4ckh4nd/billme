import React from 'react';
import { ChevronsUpDown, Plus } from 'lucide-react';
import { Button, Input, Menu, Modal, cn } from '@billme/ui';
import { READ_ONLY_HINT, canMutate, type RendererProduct, type RendererWorkspaces } from '../../runtime-api';

const PRODUCT_NAME: Record<RendererProduct, string> = { lite: 'Billme Lite', pro: 'Billme Pro' };

/**
 * The company block at the top of the sidebar, as a menu of the person's
 * workspaces on a hosted server. A workspace of the other product opens in the
 * other web app.
 */
export const WorkspaceSwitcher: React.FC<{
  workspaces: RendererWorkspaces;
  product: RendererProduct;
  companyName: string;
  detail: string;
}> = ({ workspaces, product, companyName, detail }) => {
  const [creating, setCreating] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const switchTo = (tenantId: string) => {
    setError(null);
    workspaces.switchTo(tenantId).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };
  const items = [
    ...workspaces.list.map((workspace) => ({
      id: workspace.tenantId,
      textValue: workspace.name,
      label: (
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{workspace.name}</span>
          {workspace.product !== product ? <span className="text-micro text-muted">{PRODUCT_NAME[workspace.product]} · öffnet die andere App</span> : null}
        </span>
      ),
      checked: workspace.tenantId === workspaces.currentTenantId,
      onSelect: () => { if (workspace.tenantId !== workspaces.currentTenantId) switchTo(workspace.tenantId); },
    })),
    { id: 'create', label: 'Neuen Workspace anlegen', icon: <Plus size={14} aria-hidden="true" />, separated: true, onSelect: () => setCreating(true) },
  ];
  return (
    <>
      <Menu
        aria-label="Workspace wechseln"
        items={items}
        trigger={(props) => (
          <button
            type="button"
            {...props}
            className="flex w-full items-center gap-2 rounded-card border border-border bg-surface-sunken px-2.5 py-2 text-left hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-label font-semibold text-foreground">{companyName}</span>
              <span className="block truncate text-micro text-muted">{detail}</span>
            </span>
            <ChevronsUpDown size={14} aria-hidden="true" className="shrink-0 text-muted" />
          </button>
        )}
      />
      {canMutate() ? null : <p className="px-1 text-micro text-muted">{READ_ONLY_HINT}</p>}
      {error ? <p role="alert" className="text-micro text-error-text">{error}</p> : null}
      <CreateWorkspaceDialog open={creating} onClose={() => setCreating(false)} workspaces={workspaces} product={product} />
    </>
  );
};

const CreateWorkspaceDialog: React.FC<{ open: boolean; onClose: () => void; workspaces: RendererWorkspaces; product: RendererProduct }> = ({
  open, onClose, workspaces, product,
}) => {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const [name, setName] = React.useState('');
  const [target, setTarget] = React.useState<RendererProduct>(product);
  const [setupToken, setSetupToken] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) { setError('Bitte gib einen Namen ein.'); return; }
    setBusy(true);
    setError(null);
    try {
      await workspaces.create({ name: name.trim(), product: target, ...(setupToken.trim() ? { setupToken: setupToken.trim() } : {}) });
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(/invalid setup token/i.test(message) ? 'Der Einrichtungscode stimmt nicht.' : message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} titleId={titleId} descriptionId={descriptionId} ariaBusy={busy} className="max-w-md p-6">
      <form noValidate className="grid gap-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="grid gap-1">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">Neuen Workspace anlegen</h2>
          <p id={descriptionId} className="text-sm text-muted">Für ein weiteres Unternehmen. Du wirst Inhaber, der Workspace startet leer mit der Einrichtung.</p>
        </div>
        {workspaces.setupTokenRequired ? (
          <Input label="Einrichtungscode" fullWidth autoComplete="off" spellCheck={false} value={setupToken} onChange={(event) => setSetupToken(event.target.value)} />
        ) : null}
        <Input label="Name des Workspace" fullWidth placeholder="z. B. Muster GmbH" value={name} onChange={(event) => setName(event.target.value)} />
        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-label text-foreground">Produkt</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['lite', 'pro'] as const).map((option) => (
              <label key={option} className={cn('flex cursor-pointer rounded-md border px-3 py-2 text-sm has-focus-visible:outline-2 has-focus-visible:outline-focus-ring', target === option ? 'border-foreground bg-surface-muted' : 'border-border')}>
                <input type="radio" name="workspace-product" value={option} checked={target === option} onChange={() => setTarget(option)} className="sr-only" />
                <span className="font-semibold text-foreground">{PRODUCT_NAME[option]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error ? <p role="alert" className="text-sm text-error-text">{error}</p> : null}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" disabled={busy} onClick={onClose}>Abbrechen</Button>
          <Button type="submit" loading={busy}>Anlegen</Button>
        </div>
      </form>
    </Modal>
  );
};
