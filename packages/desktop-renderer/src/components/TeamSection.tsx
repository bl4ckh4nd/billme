import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, ConfirmDialog, Input, Select } from '@billme/ui';
import { getRendererRuntime, ipc } from '../runtime-api';

type Team = Awaited<ReturnType<typeof ipc.team.list>>;
type Member = Team['members'][number];
type Role = Member['role'];

const teamKey = ['team'] as const;

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Inhaber', admin: 'Admin', accountant: 'Buchhaltung', sales: 'Vertrieb', viewer: 'Lesezugriff',
};
const ROLE_HINT: Record<Role, string> = {
  owner: 'Alles, auch Team und Inhaber',
  admin: 'Alles außer Inhaber ändern',
  accountant: 'Belege und Buchhaltung bearbeiten',
  sales: 'Nur lesen',
  viewer: 'Nur lesen',
};
const ROLES: Role[] = ['owner', 'admin', 'accountant', 'sales', 'viewer'];

const formatDate = (value: string): string => new Date(value).toLocaleDateString('de-DE', { dateStyle: 'medium' });
const messageOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/at least one owner/i.test(message)) return 'Ein Workspace braucht mindestens einen Inhaber.';
  if (/already a member/i.test(message)) return 'Diese Person ist schon im Team.';
  if (/Only an owner/i.test(message)) return 'Nur ein Inhaber kann Inhaber ernennen oder ändern.';
  if (/Only owners and admins/i.test(message)) return 'Das Team verwalten nur Inhaber und Admins.';
  return message;
};

/**
 * The workspace's people on a hosted server: invite by email with a role, change
 * roles, remove members. The server enforces the rules (last owner, who may
 * grant ownership); this view explains them.
 */
export const TeamSection: React.FC = () => {
  const queryClient = useQueryClient();
  const workspaces = getRendererRuntime().workspaces;
  const current = workspaces?.list.find((workspace) => workspace.tenantId === workspaces.currentTenantId);
  const isOwner = current?.role === 'owner';
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [status, setStatus] = useState<{ tone: 'info' | 'error'; text: string; link?: string } | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);

  const team = useQuery({ queryKey: teamKey, queryFn: () => ipc.team.list() });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: teamKey });
  const fail = (prefix: string) => (error: unknown) => setStatus({ tone: 'error', text: `${prefix}: ${messageOf(error)}` });

  const invite = useMutation({
    mutationFn: () => ipc.team.invite({ email: email.trim(), role }),
    onSuccess: (result) => {
      setEmail('');
      setStatus(result.mailSent
        ? { tone: 'info', text: `Einladung an ${result.invitation.email} verschickt.` }
        : { tone: 'info', text: `Die Mail konnte nicht verschickt werden. Gib ${result.invitation.email} diesen Link:`, link: result.inviteUrl });
      refresh();
    },
    onError: fail('Einladung fehlgeschlagen'),
  });
  const revoke = useMutation({ mutationFn: (id: string) => ipc.team.revokeInvitation({ id }), onSuccess: refresh, onError: fail('Zurückziehen fehlgeschlagen') });
  const changeRole = useMutation({
    mutationFn: (args: { userId: string; role: Role }) => ipc.team.changeRole(args),
    onSuccess: () => { setStatus(null); refresh(); },
    onError: (error) => { fail('Rolle nicht geändert')(error); refresh(); },
  });
  const remove = useMutation({
    mutationFn: (member: Member) => ipc.team.remove({ userId: member.userId }),
    onSuccess: () => { setRemoving(null); refresh(); },
    onError: (error) => { setRemoving(null); fail('Entfernen fehlgeschlagen')(error); },
  });

  const assignable = ROLES.filter((option) => isOwner || option !== 'owner');
  const ownerCount = (team.data?.members ?? []).filter((member) => member.role === 'owner').length;
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <Card padding="none">
      <CardHeader
        className="border-b border-border px-3.5 py-3"
        title="Team"
        subtitle={`Wer in ${current?.name ?? 'diesem Workspace'} arbeitet. Eingeladene Personen bekommen einen Link per E-Mail, der sieben Tage gilt.`}
      />
      <div className="grid gap-5 px-3.5 py-3.5">
        {team.isError ? <p role="alert" className="text-control text-error-text">{messageOf(team.error)}</p> : null}

        <form
          className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_auto] md:items-end"
          onSubmit={(event) => { event.preventDefault(); if (emailValid) invite.mutate(); }}
        >
          <Input label="E-Mail-Adresse" type="email" fullWidth placeholder="name@firma.de" value={email} onChange={(event) => setEmail(event.target.value)} />
          <Select label="Rolle" fullWidth value={role} onChange={(event) => setRole(event.target.value as Role)}>
            {assignable.map((option) => <option key={option} value={option}>{ROLE_LABEL[option]}</option>)}
          </Select>
          <Button type="submit" disabled={!emailValid} loading={invite.isPending}>Einladen</Button>
        </form>
        <p className="-mt-2 text-micro text-muted">{ROLE_LABEL[role]}: {ROLE_HINT[role]}</p>

        {status ? (
          <div role={status.tone === 'error' ? 'alert' : 'status'} className={status.tone === 'error' ? 'text-control text-error-text' : 'text-control text-foreground'}>
            {status.text}
            {status.link ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-control bg-surface-sunken px-2 py-1 text-micro">{status.link}</code>
                <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(status.link!)}>Kopieren</Button>
              </div>
            ) : null}
          </div>
        ) : null}

        <section aria-label="Mitglieder" className="grid gap-1">
          <h3 className="text-label font-semibold text-foreground">Mitglieder</h3>
          <ul className="divide-y divide-border-subtle">
            {(team.data?.members ?? []).map((member) => {
              const self = member.userId === workspaces?.currentUserId;
              return (
                <li key={member.userId} className="flex flex-wrap items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-control font-semibold text-foreground">{member.fullName || member.email}</div>
                    <div className="truncate text-micro text-muted">{member.email} · seit {formatDate(member.joinedAt)}</div>
                  </div>
                  <Select
                    aria-label={`Rolle von ${member.fullName || member.email}`}
                    value={member.role}
                    disabled={changeRole.isPending || (member.role === 'owner' && !isOwner)}
                    onChange={(event) => changeRole.mutate({ userId: member.userId, role: event.target.value as Role })}
                  >
                    {ROLES.filter((option) => isOwner || option !== 'owner' || member.role === 'owner').map((option) => (
                      <option key={option} value={option} disabled={!isOwner && option === 'owner'}>{ROLE_LABEL[option]}</option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={member.role === 'owner' && (!isOwner || ownerCount <= 1)}
                    title={member.role === 'owner' && ownerCount <= 1 ? 'Ein Workspace braucht mindestens einen Inhaber.' : undefined}
                    onClick={() => setRemoving(member)}
                  >
                    {self ? 'Verlassen' : 'Entfernen'}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>

        {(team.data?.invitations.length ?? 0) > 0 ? (
          <section aria-label="Offene Einladungen" className="grid gap-1">
            <h3 className="text-label font-semibold text-foreground">Offene Einladungen</h3>
            <ul className="divide-y divide-border-subtle">
              {team.data!.invitations.map((invitation) => (
                <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-control text-foreground">{invitation.email}</div>
                    <div className="truncate text-micro text-muted">gilt bis {formatDate(invitation.expiresAt)}</div>
                  </div>
                  <Badge tone="neutral">{ROLE_LABEL[invitation.role]}</Badge>
                  <Button size="sm" variant="secondary" loading={revoke.isPending && revoke.variables === invitation.id} onClick={() => revoke.mutate(invitation.id)}>
                    Zurückziehen
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <ConfirmDialog
        open={removing !== null}
        title={`${removing?.fullName || removing?.email} entfernen?`}
        description="Die Person verliert sofort den Zugriff auf diesen Workspace. Ihre Belege und der Audit-Verlauf bleiben."
        confirmLabel="Entfernen"
        destructive
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
        onCancel={() => setRemoving(null)}
      />
    </Card>
  );
};
