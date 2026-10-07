import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { PASSWORD, startHostedServer, uniqueEmail, type HostedServer } from './server-fixtures.js';
import { newClient } from './fixtures.js';

/**
 * Hosted server mode as a multi-workspace service: sign-up with the setup code,
 * several workspaces per person, switching, members, invitations and password
 * reset, through real HTTP against the Postgres auth store (PGlite behind the
 * wire front). Platform mail is captured instead of sent.
 *
 * How this can fail (each one has a test below):
 * - sign-up: a workspace created without or with a wrong setup code, an existing
 *   email signing up again (account takeover), a short password, a new workspace
 *   without settings (no onboarding), unthrottled attempts
 * - workspaces: one person's second workspace reading the first one's data, a
 *   switch into a workspace the person does not (or no longer) belong to, a Lite
 *   token switched into a Pro workspace, someone else's workspaces listed
 * - roles: a viewer, sales or accountant seeing or managing the team, an admin
 *   making someone owner or removing an owner, the last owner demoted or removed,
 *   a removed member's session still working, team changes missing from the audit log
 * - invitations: a link used twice, after expiry or after it was revoked, an
 *   existing account joined with the wrong password, a new account created without
 *   a name or with a short password, an invitation for someone who already is a
 *   member, the mail not carrying a working link
 * - password reset: known and unknown addresses told apart, a link used twice or
 *   after expiry, the old password still working, a lockout surviving the reset
 */

type Mail = { to: string; subject: string; text: string; html: string; idempotencyKey: string };

const SETUP = 'setup-code-workspaces-0123456789';

describe('workspaces, team and password reset', () => {
  let h: HostedServer;
  const mails: Mail[] = [];
  const previousWebUrl = process.env.BILLME_PUBLIC_WEB_URL;

  before(async () => {
    process.env.BILLME_PUBLIC_WEB_URL = 'https://billme.example';
    h = await startHostedServer('workspaces', {
      setupToken: SETUP,
      platformMailer: async (mail) => { mails.push(mail); return { sent: true }; },
    });
  });
  after(async () => {
    await h.close();
    if (previousWebUrl === undefined) delete process.env.BILLME_PUBLIC_WEB_URL; else process.env.BILLME_PUBLIC_WEB_URL = previousWebUrl;
  });

  const signUp = async (label: string, overrides: Record<string, unknown> = {}, product: 'lite' | 'pro' = 'lite') => {
    const email = uniqueEmail(label);
    const response = await h.http('POST', `/api/v1/auth/signup?product=${product}`, {
      body: { email, password: PASSWORD, fullName: `${label} Person`, workspaceName: `${label} GmbH`, setupToken: SETUP, ...overrides },
    });
    return { response, email, token: response.body?.token as string, tenantId: response.body?.tenantId as string, userId: response.body?.user?.id as string };
  };
  const linkToken = (mail: Mail | undefined, param: 'invite' | 'reset') => {
    const match = mail?.text.match(new RegExp(`[?&]${param}=([^\\s&]+)`));
    assert.ok(match, `no ${param} link in ${mail?.text}`);
    return decodeURIComponent(match[1]!);
  };
  const lastMailTo = (email: string) => [...mails].reverse().find((mail) => mail.to === email);
  const invite = (token: string, email: string, role: string) =>
    h.http('POST', '/api/v1/lite/team/invitations', { token, body: { email, role } });

  describe('sign-up', () => {
    test('only the setup code creates a workspace; the new workspace starts with settings for onboarding', async () => {
      for (const setupToken of [undefined, '', 'wrong-code']) {
        const refused = await signUp('signup-refused', { setupToken });
        assert.equal(refused.response.status, 403, refused.response.text);
      }
      const created = await signUp('signup');
      assert.equal(created.response.status, 200, created.response.text);
      assert.equal(created.response.body.product, 'lite');
      assert.equal(created.response.body.user.role, 'owner');
      const settings = await h.http('GET', '/api/v1/lite/settings', { token: created.token });
      assert.equal(settings.body.company.name, '', 'default settings, so the wizard opens');
      const workspaces = await h.http('GET', '/api/v1/auth/workspaces', { token: created.token });
      assert.deepEqual(workspaces.body.map((w: { name: string; role: string }) => [w.name, w.role]), [['signup GmbH', 'owner']]);
    });

    test('an existing email cannot sign up again, malformed sign-ups are rejected', async () => {
      const first = await signUp('signup-dup');
      const again = await h.http('POST', '/api/v1/auth/signup?product=lite', {
        body: { email: first.email.toUpperCase(), password: 'another-password-123', fullName: 'Mallory', workspaceName: 'Takeover', setupToken: SETUP },
      });
      assert.equal(again.status, 409, again.text);
      assert.equal((await h.http('POST', '/api/v1/lite/auth/login', { body: { email: first.email, password: 'another-password-123' } })).status, 401, 'the original password still rules');
      assert.equal((await signUp('signup-short', { password: 'short' })).response.status, 400);
      assert.equal((await signUp('signup-noname', { workspaceName: '   ' })).response.status, 400);
    });

    test('sign-up attempts are throttled per address', async () => {
      const throttled = await startHostedServer('workspaces-throttle', { setupToken: SETUP, platformMailer: async () => ({ sent: false }) });
      try {
        const statuses: number[] = [];
        for (let attempt = 0; attempt < 22; attempt += 1) {
          statuses.push((await throttled.http('POST', '/api/v1/auth/signup?product=lite', {
            body: { email: uniqueEmail('flood'), password: PASSWORD, fullName: 'F', workspaceName: 'F', setupToken: 'wrong' },
          })).status);
        }
        assert.ok(statuses.slice(0, 20).every((status) => status === 403));
        assert.deepEqual(statuses.slice(20), [429, 429]);
      } finally {
        await throttled.close();
      }
    });
  });

  describe('several workspaces per person', () => {
    test('a second workspace is separate, switching needs a membership and the right product', async () => {
      const owner = await signUp('multi');
      assert.equal((await h.http('POST', '/api/v1/auth/workspaces', { token: owner.token, body: { name: 'Zweitfirma', product: 'lite', setupToken: 'wrong' } })).status, 403);
      const second = await h.http('POST', '/api/v1/auth/workspaces', { token: owner.token, body: { name: 'Zweitfirma', product: 'lite', setupToken: SETUP } });
      assert.equal(second.status, 200, second.text);
      assert.notEqual(second.body.tenantId, owner.tenantId);

      const { id: clientId } = await h.liteApi(owner.token).clients.upsert({ client: newClient({ company: 'Nur in Firma A' }) as never });
      const inB = await h.http('GET', '/api/v1/lite/clients', { token: second.body.token });
      assert.deepEqual(inB.body, [], 'the second workspace starts empty');
      const foreign = await h.http('GET', `/api/v1/lite/clients/${clientId}`, { token: second.body.token });
      assert.ok(foreign.status === 404 || (foreign.status === 200 && foreign.body === null), `A's client leaked into B: ${foreign.status} ${foreign.text}`);

      const listed = await h.http('GET', '/api/v1/auth/workspaces', { token: second.body.token });
      assert.deepEqual(listed.body.map((w: { tenantId: string }) => w.tenantId).sort(), [owner.tenantId, second.body.tenantId].sort());

      const back = await h.http('POST', '/api/v1/auth/switch?product=lite', { token: second.body.token, body: { tenantId: owner.tenantId } });
      assert.equal(back.status, 200, back.text);
      assert.equal((await h.http('GET', `/api/v1/lite/clients/${clientId}`, { token: back.body.token })).body?.company, 'Nur in Firma A');

      const stranger = await signUp('multi-stranger');
      assert.equal((await h.http('POST', '/api/v1/auth/switch?product=lite', { token: stranger.token, body: { tenantId: owner.tenantId } })).status, 403);
      assert.equal((await h.http('GET', '/api/v1/auth/workspaces', { token: stranger.token })).body.length, 1, 'only their own workspaces are listed');
      assert.equal((await h.http('GET', '/api/v1/auth/workspaces')).status, 401);
    });

    test('the same person owns a Lite and a Pro workspace and signs into Pro with the same password', async () => {
      const owner = await signUp('both');
      const pro = await h.http('POST', '/api/v1/auth/workspaces', { token: owner.token, body: { name: 'Pro Firma', product: 'pro', setupToken: SETUP } });
      assert.equal(pro.status, 200, pro.text);
      assert.equal(pro.body.product, 'pro');
      assert.deepEqual((await h.http('GET', '/api/v1/auth/apps')).body, { lite: 'https://billme.example' }, 'only configured apps are named');
      assert.equal((await h.http('POST', '/api/v1/auth/switch?product=lite', { token: owner.token, body: { tenantId: pro.body.tenantId } })).status, 400, 'a Lite session does not switch into Pro');
      const login = await h.http('POST', '/api/v1/pro/auth/login', { body: { email: owner.email, password: PASSWORD } });
      assert.equal(login.status, 200, login.text);
      assert.equal((await h.http('GET', '/api/v1/pro/auth/me', { token: login.body.token })).body.tenantId, pro.body.tenantId);
      assert.equal((await h.http('GET', '/api/v1/lite/clients', { token: pro.body.token })).status, 403, 'the Pro token does not open Lite');

      // The Pro workspace has its own team.
      const proToken = login.body.token as string;
      const email = uniqueEmail('pro-member');
      const invited = await h.http('POST', '/api/v1/pro/team/invitations', { token: proToken, body: { email, role: 'viewer' } });
      assert.equal(invited.status, 200, invited.text);
      assert.match(lastMailTo(email)!.text, /invite=/);
      const accepted = await h.http('POST', `/api/v1/auth/invitations/${encodeURIComponent(linkToken(lastMailTo(email), 'invite'))}/accept`, { body: { password: PASSWORD, fullName: 'Pro Mitglied' } });
      assert.deepEqual([accepted.status, accepted.body.product, accepted.body.tenantId], [200, 'pro', pro.body.tenantId]);
      assert.equal((await h.http('PUT', `/api/v1/pro/team/members/${accepted.body.user.id}`, { token: proToken, body: { role: 'accountant' } })).status, 200);
      const again = await h.http('POST', '/api/v1/pro/team/invitations', { token: proToken, body: { email: uniqueEmail('pro-later'), role: 'sales' } });
      assert.equal((await h.http('DELETE', `/api/v1/pro/team/invitations/${again.body.invitation.id}`, { token: proToken })).status, 200);
      assert.equal((await h.http('DELETE', `/api/v1/pro/team/members/${accepted.body.user.id}`, { token: proToken })).status, 200);
      const proTeam = await h.http('GET', '/api/v1/pro/team', { token: proToken });
      assert.deepEqual([proTeam.body.members.length, proTeam.body.invitations.length], [1, 0]);
      assert.equal((await h.http('GET', '/api/v1/lite/team', { token: owner.token })).body.members.length, 1, 'the Lite team is untouched');
    });
  });

  describe('team and invitations', () => {
    test('an invited newcomer joins with the role from the invitation; the link works once', async () => {
      const owner = await signUp('team');
      const email = uniqueEmail('newcomer');
      const created = await invite(owner.token, email, 'accountant');
      assert.equal(created.status, 200, created.text);
      assert.equal(created.body.mailSent, true);
      const mail = lastMailTo(email);
      assert.match(mail!.subject, /Einladung zu team GmbH/);
      assert.match(mail!.text, /https:\/\/billme\.example\/\?invite=/);
      const token = linkToken(mail, 'invite');
      assert.equal(created.body.inviteUrl, `https://billme.example/?invite=${encodeURIComponent(token)}`);

      const described = await h.http('GET', `/api/v1/auth/invitations/${encodeURIComponent(token)}`);
      assert.deepEqual(described.body, { email, role: 'accountant', workspaceName: 'team GmbH', product: 'lite', userExists: false });
      assert.equal((await h.http('POST', `/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`, { body: { password: PASSWORD } })).status, 400, 'a new account needs a name');
      assert.equal((await h.http('POST', `/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`, { body: { password: 'short', fullName: 'Neu' } })).status, 400);
      const accepted = await h.http('POST', `/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`, { body: { password: PASSWORD, fullName: 'Nora Neu' } });
      assert.equal(accepted.status, 200, accepted.text);
      assert.deepEqual([accepted.body.tenantId, accepted.body.user.role], [owner.tenantId, 'accountant']);
      assert.equal((await h.http('POST', `/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`, { body: { password: PASSWORD, fullName: 'Again' } })).status, 410);
      assert.equal((await h.http('GET', `/api/v1/auth/invitations/${encodeURIComponent(token)}`)).status, 410);

      const team = await h.http('GET', '/api/v1/lite/team', { token: owner.token });
      assert.deepEqual(team.body.members.map((m: { email: string; role: string }) => [m.email, m.role]).sort(), [[owner.email, 'owner'], [email, 'accountant']].sort());
      assert.deepEqual(team.body.invitations, []);
      assert.equal((await invite(owner.token, email, 'viewer')).status, 409, 'already a member');
      const audit = await h.wire.sql<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'team.%'`, [owner.tenantId]);
      assert.deepEqual(audit.rows.map((row) => row.action), ['team.invite']);
    });

    test('an existing account joins with its own password; a wrong one adds no membership', async () => {
      const owner = await signUp('team-existing');
      const other = await signUp('team-other');
      const created = await invite(owner.token, other.email, 'sales');
      const token = linkToken(lastMailTo(other.email), 'invite');
      assert.equal((await h.http('GET', `/api/v1/auth/invitations/${encodeURIComponent(token)}`)).body.userExists, true);
      const wrong = await h.http('POST', `/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`, { body: { password: 'definitely-wrong-1' } });
      assert.equal(wrong.status, 401);
      assert.equal((await h.http('GET', '/api/v1/auth/workspaces', { token: other.token })).body.length, 1);
      const joined = await h.http('POST', `/api/v1/auth/invitations/${encodeURIComponent(token)}/accept`, { body: { password: PASSWORD } });
      assert.equal(joined.status, 200, joined.text);
      assert.equal(joined.body.user.role, 'sales');
      assert.ok(created.body.invitation.id);
      assert.equal((await h.http('GET', '/api/v1/auth/workspaces', { token: other.token })).body.length, 2, 'their own workspace plus the new one');
    });

    test('revoked and expired invitations are dead; a new invitation replaces the open one', async () => {
      const owner = await signUp('team-revoke');
      const email = uniqueEmail('revoked');
      const first = await invite(owner.token, email, 'viewer');
      const firstToken = linkToken(lastMailTo(email), 'invite');
      await invite(owner.token, email, 'sales');
      const secondToken = linkToken(lastMailTo(email), 'invite');
      assert.equal((await h.http('GET', `/api/v1/auth/invitations/${encodeURIComponent(firstToken)}`)).status, 410, 'replaced');
      const open = (await h.http('GET', '/api/v1/lite/team', { token: owner.token })).body.invitations;
      assert.deepEqual(open.map((i: { role: string }) => i.role), ['sales']);
      assert.equal((await h.http('DELETE', `/api/v1/lite/team/invitations/${open[0].id}`, { token: owner.token })).status, 200);
      assert.equal((await h.http('POST', `/api/v1/auth/invitations/${encodeURIComponent(secondToken)}/accept`, { body: { password: PASSWORD, fullName: 'Late' } })).status, 410);
      assert.equal((await h.http('DELETE', `/api/v1/lite/team/invitations/${first.body.invitation.id}`, { token: owner.token })).status, 404, 'already replaced');

      await invite(owner.token, email, 'viewer');
      const expiring = linkToken(lastMailTo(email), 'invite');
      await h.wire.sql(`UPDATE workspace_invitations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE tenant_id = $1 AND revoked_at IS NULL`, [owner.tenantId]);
      assert.equal((await h.http('POST', `/api/v1/auth/invitations/${encodeURIComponent(expiring)}/accept`, { body: { password: PASSWORD, fullName: 'Late' } })).status, 410);
      assert.equal((await h.http('GET', '/api/v1/auth/invitations/not-a-real-token-at-all')).status, 404);
    });

    test('only owners and admins manage the team; admins cannot touch ownership', async () => {
      const owner = await signUp('team-roles');
      const join = async (role: string) => {
        const email = uniqueEmail(`member-${role}`);
        await invite(owner.token, email, role);
        const accepted = await h.http('POST', `/api/v1/auth/invitations/${encodeURIComponent(linkToken(lastMailTo(email), 'invite'))}/accept`, { body: { password: PASSWORD, fullName: role } });
        assert.equal(accepted.status, 200, accepted.text);
        return { email, token: accepted.body.token as string, userId: accepted.body.user.id as string };
      };
      const admin = await join('admin');
      const accountant = await join('accountant');
      const viewer = await join('viewer');
      for (const member of [accountant, viewer]) {
        assert.equal((await h.http('GET', '/api/v1/lite/team', { token: member.token })).status, 403);
        assert.equal((await invite(member.token, uniqueEmail('x'), 'viewer')).status, 403);
        assert.equal((await h.http('PUT', `/api/v1/lite/team/members/${viewer.userId}`, { token: member.token, body: { role: 'admin' } })).status, 403, 'no self-escalation');
      }
      assert.equal((await invite(admin.token, uniqueEmail('owner-by-admin'), 'owner')).status, 403);
      assert.equal((await h.http('PUT', `/api/v1/lite/team/members/${viewer.userId}`, { token: admin.token, body: { role: 'owner' } })).status, 403);
      assert.equal((await h.http('PUT', `/api/v1/lite/team/members/${owner.userId}`, { token: admin.token, body: { role: 'viewer' } })).status, 403, 'admins do not demote owners');
      assert.equal((await h.http('DELETE', `/api/v1/lite/team/members/${owner.userId}`, { token: admin.token })).status, 403);
      assert.equal((await h.http('PUT', `/api/v1/lite/team/members/${viewer.userId}`, { token: admin.token, body: { role: 'sales' } })).status, 200);

      assert.equal((await h.http('PUT', `/api/v1/lite/team/members/${owner.userId}`, { token: owner.token, body: { role: 'admin' } })).status, 409, 'the last owner stays');
      assert.equal((await h.http('DELETE', `/api/v1/lite/team/members/${owner.userId}`, { token: owner.token })).status, 409);

      assert.equal((await h.http('GET', '/api/v1/lite/clients', { token: accountant.token })).status, 200);
      assert.equal((await h.http('DELETE', `/api/v1/lite/team/members/${accountant.userId}`, { token: admin.token })).status, 200);
      assert.ok([401, 403].includes((await h.http('GET', '/api/v1/lite/clients', { token: accountant.token })).status), 'a removed member loses access at once');
      assert.equal((await h.http('POST', '/api/v1/auth/switch?product=lite', { token: accountant.token, body: { tenantId: owner.tenantId } })).status, 403);

      assert.equal((await h.http('DELETE', `/api/v1/lite/team/members/${viewer.userId}`, { token: viewer.token })).status, 200, 'anyone may leave');
      const audit = await h.wire.sql<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'team.%' ORDER BY sequence`, [owner.tenantId]);
      assert.deepEqual(audit.rows.map((row) => row.action).filter((action) => action !== 'team.invite'), ['team.role_changed', 'team.member_removed', 'team.member_removed']);
    });
  });

  describe('password reset', () => {
    test('known and unknown addresses get the same answer; only the known one gets a link', async () => {
      const owner = await signUp('reset-known');
      const before = mails.length;
      const known = await h.http('POST', '/api/v1/auth/password-reset?product=lite', { body: { email: owner.email } });
      const unknown = await h.http('POST', '/api/v1/auth/password-reset?product=lite', { body: { email: uniqueEmail('nobody') } });
      assert.deepEqual([known.status, known.text], [unknown.status, unknown.text]);
      assert.equal(known.status, 202);
      assert.equal(mails.length, before + 1);
      assert.equal(mails.at(-1)!.to, owner.email);
    });

    test('the link sets a new password once, voids the old one and lifts a lockout', async () => {
      const owner = await signUp('reset-use');
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await h.http('POST', '/api/v1/lite/auth/login', { body: { email: owner.email, password: 'wrong-password-12' } });
      }
      assert.equal((await h.http('POST', '/api/v1/lite/auth/login', { body: { email: owner.email, password: PASSWORD } })).status, 429, 'precondition: locked out');
      await h.http('POST', '/api/v1/auth/password-reset?product=lite', { body: { email: owner.email } });
      const token = linkToken(lastMailTo(owner.email), 'reset');
      assert.equal((await h.http('POST', '/api/v1/auth/password-reset/confirm', { body: { token, password: 'short' } })).status, 400);
      const reset = await h.http('POST', '/api/v1/auth/password-reset/confirm', { body: { token, password: 'a-brand-new-password' } });
      assert.equal(reset.status, 200, reset.text);
      assert.equal((await h.http('POST', '/api/v1/lite/auth/login', { body: { email: owner.email, password: PASSWORD } })).status, 401, 'the old password is gone');
      assert.equal((await h.http('POST', '/api/v1/lite/auth/login', { body: { email: owner.email, password: 'a-brand-new-password' } })).status, 200);
      assert.equal((await h.http('POST', '/api/v1/auth/password-reset/confirm', { body: { token, password: 'yet-another-password' } })).status, 410, 'the link works once');

      await h.http('POST', '/api/v1/auth/password-reset?product=lite', { body: { email: owner.email } });
      const expired = linkToken(lastMailTo(owner.email), 'reset');
      await h.wire.sql(`UPDATE password_reset_tokens SET expires_at = '2000-01-01T00:00:00.000Z' WHERE used_at IS NULL`);
      assert.equal((await h.http('POST', '/api/v1/auth/password-reset/confirm', { body: { token: expired, password: 'yet-another-password' } })).status, 410);
    });
  });
});
