import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { documentIdFromUrl, newToken, startPortal, type PortalHandle } from './offer-portal-fixtures.js';

/**
 * The offer portal service over real HTTP (apps/offer-portal createApp behind
 * @hono/node-server, once on the production SQLite + filesystem storage and
 * once on the in-memory store).
 *
 * How this can fail (each one has a test below):
 * - publish auth: a missing, wrong or near-miss API key accepted on any of the
 *   four publish routes, strict mode without a configured key serving anyway,
 *   a rejected publish still storing something
 * - publish payloads: unknown content types, short or missing tokens, JSON and
 *   multipart disagreeing, default expiry (30 days offers, 365 invoices) wrong
 * - token handling: raw tokens persisted (database file, PDF file names, document
 *   ids), a guessed or truncated token resolving, short tokens crashing a route
 * - snapshots: stored snapshot differs from the published one, customer HTML
 *   not escaping snapshot text, missing no-store / frame / CSP headers
 * - decisions: a second decision overwriting the first, an expired offer still
 *   decidable, invoices decidable, foreign Origin / Host / missing CSRF accepted,
 *   fields not normalised, a re-publish wiping a recorded decision
 * - PDFs: bytes changed in storage, served for the wrong document, listed
 *   although missing
 * - customer access links: expired or revoked links still listing documents,
 *   rotation leaving the old link alive or touching other customers, another
 *   customer's documents leaking, wrong paging / filtering, raw tokens in the
 *   listing URLs
 * - abuse limits: read and decision rate limits missing or shared between callers
 * - persistence: published data lost when the SQLite-backed portal restarts
 * - storage parity: memory and SQLite stores disagreeing on ids and decisions
 * - rendering: the portal colours drifting from the design tokens
 * - validation: malformed requests answered with 500 instead of a client error
 */
const here = dirname(fileURLToPath(import.meta.url));
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const DAY = 86_400_000;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

const offerSnapshot = (overrides: Record<string, unknown> = {}) => ({
  number: 'ANG-2026-001',
  client: 'Test Kunde GmbH',
  clientEmail: 'kunde@example.com',
  date: '2026-02-20',
  dueDate: '2026-03-20',
  amount: 1299.99,
  status: 'open',
  items: [{ description: 'Beratung Q1', quantity: 2, price: 546.215, total: 1092.43, taxRate: 19 }],
  taxSnapshot: { vatRateApplied: 19, netAmount: 1092.43, vatAmount: 207.56, grossAmount: 1299.99 },
  ...overrides,
});
const invoiceSnapshot = (overrides: Record<string, unknown> = {}) => offerSnapshot({ number: 'RE-2026-001', ...overrides });
const accepted = { decision: 'accepted', acceptedName: 'Alice Approver', acceptedEmail: 'Alice@Example.COM', decisionTextVersion: 'v1' };
const declined = { decision: 'declined', acceptedName: 'Bob Bedenken', acceptedEmail: 'bob@example.com', decisionTextVersion: 'v1' };

const designTokens = (css: string) => {
  const value = (name: string) => {
    const match = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
    assert.ok(match, `styles.css declares --${name}`);
    return match[1]!.trim().toLowerCase();
  };
  return {
    surface: value('color-surface'), surfaceSunken: value('color-surface-sunken'), foreground: value('color-foreground'),
    muted: value('color-muted'), border: value('color-border'), controlBorder: value('color-control-border'),
    accent: value('color-accent'), accentForeground: value('color-accent-foreground'), focusRing: value('color-focus-ring'),
    successText: value('color-success-text'), warningText: value('color-warning-text'), warningBg: value('color-warning-bg'),
    warningBorder: value('color-warning-border'), errorText: value('color-error-text'),
    radiusSm: value('radius-sm'), radiusMd: value('radius-md'), radiusLg: value('radius-lg'),
  };
};

const portalContract = (mode: 'sqlite' | 'memory') => describe(`${mode} store`, () => {
  // The rate limit table is process wide, so each store pins its own addresses.
  const pinnedAddress = (n: number) => `203.0.113.${mode === 'sqlite' ? n : n + 100}`;
  let portal: PortalHandle;
  before(async () => { portal = await startPortal({ suite: 'offer-portal', store: mode }); });
  after(async () => { await portal.close(); });

  const publishOffer = async (snapshot: Record<string, unknown> = offerSnapshot(), extra: { customerRef?: string; customerLabel?: string; expiresAt?: string; token?: string } = {}) => {
    const token = extra.token ?? newToken('offer');
    const response = await portal.publish('offers', { token, snapshot, ...extra });
    assert.equal(response.status, 200, response.text);
    return token;
  };
  const publishInvoice = async (snapshot: Record<string, unknown> = invoiceSnapshot(), extra: { customerRef?: string; customerLabel?: string; expiresAt?: string; token?: string } = {}) => {
    const token = extra.token ?? newToken('invoice');
    const response = await portal.publish('invoices', { token, snapshot, ...extra });
    assert.equal(response.status, 200, response.text);
    return token;
  };
  /** The opaque /d/:id the legacy token URL redirects a browser to. */
  const documentOf = async (token: string, kind: 'offers' | 'invoices' = 'offers') => {
    const response = await portal.request('GET', `/${kind}/${token}`, { headers: { accept: 'text/html' } });
    assert.equal(response.status, 302, response.text);
    return documentIdFromUrl(String(response.headers.location));
  };
  const decide = (token: string, body: Record<string, unknown> = accepted, headers: Record<string, string> = {}) =>
    portal.request('POST', `/offers/${token}/decision`, { json: body, headers: { origin: portal.baseUrl, ...headers } });
  const customerLink = async (customerRef: string, extra: { customerLabel?: string; expiresInDays?: number } = {}) => {
    const response = await portal.accessLink(customerRef, extra);
    assert.equal(response.status, 200, response.text);
    return response.json as { ok: true; token: string; publicUrl: string; expiresAt: string };
  };
  const listing = async (linkToken: string, query = '') => {
    const response = await portal.request('GET', `/customers/${linkToken}/documents${query}`);
    assert.equal(response.status, 200, response.text);
    return response.json as { ok: true; items: Array<{ kind: string; number: string; client: string; amount: number; status: string; hasPdf: boolean; url: string; publishedAt: string }>; nextCursor: string | null };
  };

  describe('service basics', () => {
    test('health, landing and setup pages answer, and the setup page never prints the publish key', async () => {
      const health = await portal.request('GET', '/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.ok(Number.isFinite(Date.parse(health.json.ts)));
      const home = await portal.request('GET', '/');
      assert.equal(home.status, 200);
      assert.match(home.text, /Angebotsportal/);
      assert.match(String(home.headers['cache-control']), /no-store/);
      const setup = await portal.request('GET', '/admin/setup');
      assert.equal(setup.status, 200);
      assert.match(setup.text, /PUBLISH_API_KEY<\/strong>: gesetzt/);
      assert.ok(!setup.text.includes(portal.apiKey!), 'the key itself must not be rendered');
    });

    test('unknown routes answer 404 as JSON for API callers and as a page for browsers', async () => {
      const api = await portal.request('GET', '/does-not-exist');
      assert.equal(api.status, 404);
      assert.deepEqual(api.json, { error: 'not found' });
      const browser = await portal.request('GET', '/does-not-exist', { headers: { accept: 'text/html' } });
      assert.equal(browser.status, 404);
      assert.match(browser.text, /Dieser Link gehört zu keinem Dokument/);
    });
  });

  describe('publish authentication', () => {
    const publishRoutes: Array<[string, unknown]> = [
      ['/offers', { token: newToken('auth'), snapshot: offerSnapshot() }],
      ['/invoices', { token: newToken('auth'), snapshot: invoiceSnapshot() }],
      ['/customers/access-links', { customerRef: 'client:auth' }],
      ['/customers/access-links/rotate', { customerRef: 'client:auth' }],
    ];

    test('every publish route refuses a missing key with 401 and the ApiKey challenge', async () => {
      for (const [path, body] of publishRoutes) {
        const response = await portal.request('POST', path, { json: body });
        assert.equal(response.status, 401, path);
        assert.equal(response.headers['www-authenticate'], 'ApiKey realm="publish"', path);
        assert.deepEqual(response.json, { error: 'unauthorized' }, path);
      }
    });

    test('a wrong key, a near miss and a differently cased key are refused', async () => {
      const key = portal.apiKey!;
      for (const wrong of ['wrong-key', key.toUpperCase(), key.slice(0, -1), `${key}x`, `x${key}`, '']) {
        const response = await portal.request('POST', '/offers', { json: publishRoutes[0]![1], headers: { 'x-api-key': wrong } });
        assert.equal(response.status, 401, `key "${wrong}"`);
      }
      const asBearer = await portal.request('POST', '/offers', { json: publishRoutes[0]![1], headers: { authorization: `Bearer ${key}` } });
      assert.equal(asBearer.status, 401, 'the key is only accepted in x-api-key');
    });

    test('a refused publish stores nothing, the right key does', async () => {
      const token = newToken('gate');
      const refused = await portal.request('POST', '/offers', { json: { token, snapshot: offerSnapshot() }, headers: { 'x-api-key': 'nope' } });
      assert.equal(refused.status, 401);
      assert.equal((await portal.request('GET', `/offers/${token}`)).status, 404, 'nothing was stored');
      const ok = await portal.publish('offers', { token, snapshot: offerSnapshot() });
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.json, { ok: true });
      assert.equal((await portal.request('GET', `/offers/${token}`)).status, 200);
    });
  });

  describe('offers', () => {
    test('the published snapshot is served unchanged with a 30 day default expiry', async () => {
      const snapshot = offerSnapshot({ number: 'ANG-2026-101' });
      const token = await publishOffer(snapshot);
      const response = await portal.request('GET', `/offers/${token}`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.json.snapshot, snapshot);
      assert.equal(response.json.expired, false);
      assert.equal(response.json.decision, null);
      assert.equal(response.json.hasPdf, false);
      const days = (Date.parse(response.json.expiresAt) - Date.parse(response.json.publishedAt)) / DAY;
      assert.ok(Math.abs(days - 30) < 0.01, `default expiry is 30 days, got ${days}`);
      assert.ok(Math.abs(Date.parse(response.json.publishedAt) - Date.now()) < 60_000);
    });

    test('an explicit expiry wins over the default', async () => {
      const expiresAt = new Date(Date.now() + 3 * DAY).toISOString();
      const token = await publishOffer(offerSnapshot(), { expiresAt });
      const response = await portal.request('GET', `/offers/${token}`);
      assert.equal(response.json.expiresAt, expiresAt);
    });

    test('an unknown or truncated token is a 404 for JSON and a friendly page for browsers', async () => {
      const token = await publishOffer();
      assert.equal((await portal.request('GET', `/offers/${token.slice(0, -1)}`)).status, 404, 'truncated by a mail client');
      assert.equal((await portal.request('GET', `/offers/${token.toUpperCase()}`)).status, 404, 'tokens are case sensitive');
      assert.equal((await portal.request('GET', '/offers/short')).status, 404);
      const page = await portal.request('GET', `/offers/${newToken('missing')}`, { headers: { accept: 'text/html' } });
      assert.equal(page.status, 404);
      assert.match(page.text, /Dieser Link gehört zu keinem Dokument/);
    });

    test('a browser is redirected to an opaque document page that shows number, customer, items and totals', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-102' }));
      const id = await documentOf(token);
      assert.ok(!id.includes(token), 'the document id must not expose the token');
      assert.match(id, /^[0-9a-f]{32}$|^d[0-9a-f]{31}$/);
      const page = await portal.request('GET', `/d/${id}`, { headers: { accept: 'text/html' } });
      assert.equal(page.status, 200);
      for (const text of ['Angebot ANG-2026-102', 'Test Kunde GmbH', 'Beratung Q1', '1.299,99', '1.092,43', '207,56', 'Offen']) {
        assert.ok(page.text.includes(text), `page shows ${text}`);
      }
      assert.ok(page.text.includes('<form'), 'an open offer carries the decision form');
    });

    test('customer pages carry no-store, frame and CSP protection and escape snapshot text', async () => {
      const token = await publishOffer(offerSnapshot({ client: '<script>alert(1)</script> & Co', items: [{ description: '<img src=x onerror=alert(2)>', quantity: 1, price: 1, total: 1 }] }));
      const page = await portal.request('GET', `/d/${await documentOf(token)}`, { headers: { accept: 'text/html' } });
      assert.equal(page.status, 200);
      assert.ok(!page.text.includes('<script>alert(1)'), 'client name is escaped');
      assert.ok(!page.text.includes('<img src=x'), 'item description is escaped');
      assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co'));
      assert.match(String(page.headers['cache-control']), /no-store/);
      assert.equal(page.headers['x-frame-options'], 'DENY');
      assert.equal(page.headers['x-content-type-options'], 'nosniff');
      assert.equal(page.headers['referrer-policy'], 'same-origin');
      assert.match(page.text, /frame-ancestors 'none'/);
      assert.match(page.text, /default-src 'self'/);
    });

    test('the document JSON mirrors the offer and hides nothing the customer needs', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-103' }));
      const id = await documentOf(token);
      const json = await portal.request('GET', `/d/${id}`);
      assert.equal(json.status, 200);
      assert.equal(json.json.kind, 'offer');
      assert.equal(json.json.snapshot.number, 'ANG-2026-103');
      assert.equal(json.json.decision, null);
      assert.equal(json.json.expired, false);
      assert.equal((await portal.request('GET', '/d/doesnotexistdoc')).status, 404);
      assert.equal((await portal.request('GET', '/d/short')).status, 404);
    });

    test('a snapshot-less publish does not crash the document page', async () => {
      const token = newToken('empty');
      const response = await portal.request('POST', '/offers', { json: { token }, headers: portal.publishHeaders() });
      assert.equal(response.status, 200);
      const page = await portal.request('GET', `/d/${await documentOf(token)}`, { headers: { accept: 'text/html' } });
      assert.equal(page.status, 200);
      assert.match(page.text, /Angebot/);
    });

    test('re-publishing the same token keeps the document id and replaces the snapshot', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-104', amount: 100 }));
      const before = await documentOf(token);
      await publishOffer(offerSnapshot({ number: 'ANG-2026-104', amount: 250 }), { token });
      assert.equal(await documentOf(token), before, 'the customer link stays stable');
      assert.equal((await portal.request('GET', `/offers/${token}`)).json.snapshot.amount, 250);
    });

    test('a recorded decision survives a re-publish of the same offer', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-105' }));
      assert.equal((await decide(token)).status, 200);
      await publishOffer(offerSnapshot({ number: 'ANG-2026-105' }), { token });
      const status = await portal.request('GET', `/offers/${token}/status`);
      assert.equal(status.json.decision?.decision, 'accepted', 'the acceptance must not disappear');
    });
  });

  describe('decisions', () => {
    test('accepting stores the normalised decision and every view shows it', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-201' }));
      const response = await decide(token, { ...accepted, acceptedName: '  Alice Approver  ' });
      assert.equal(response.status, 200, response.text);
      const { decision } = response.json;
      assert.equal(decision.decision, 'accepted');
      assert.equal(decision.acceptedName, 'Alice Approver', 'name is trimmed');
      assert.equal(decision.acceptedEmail, 'alice@example.com', 'email is lower-cased');
      assert.equal(decision.decisionTextVersion, 'v1');
      assert.ok(Math.abs(Date.parse(decision.decidedAt) - Date.now()) < 60_000);

      const status = await portal.request('GET', `/offers/${token}/status`);
      assert.deepEqual(status.json, { decision });
      assert.deepEqual((await portal.request('GET', `/offers/${token}`)).json.decision, decision);
      const id = await documentOf(token);
      assert.deepEqual((await portal.request('GET', `/d/${id}`)).json.decision, decision);
      const page = await portal.request('GET', `/d/${id}`, { headers: { accept: 'text/html' } });
      assert.match(page.text, /Angenommen/);
      assert.match(page.text, /Bestätigt von Alice Approver/);
      assert.ok(!page.text.includes('<form'), 'a decided offer offers no form');
      assert.ok(!page.cookies.some((cookie) => cookie.startsWith('csrfToken=')), 'no CSRF token is handed out once decided');
    });

    test('declining is recorded the same way', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-202' }));
      const response = await decide(token, declined);
      assert.equal(response.status, 200);
      assert.equal(response.json.decision.decision, 'declined');
      const page = await portal.request('GET', `/d/${await documentOf(token)}`, { headers: { accept: 'text/html' } });
      assert.match(page.text, /Abgelehnt/);
    });

    test('the first decision wins on both decision routes', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-203' }));
      const id = await documentOf(token);
      assert.equal((await decide(token, accepted)).status, 200);
      const viaLegacy = await decide(token, { ...declined, acceptedName: 'Mallory' });
      assert.equal(viaLegacy.status, 200);
      assert.equal(viaLegacy.json.decision.decision, 'accepted');
      assert.equal(viaLegacy.json.decision.acceptedName, 'Alice Approver');
      const viaDocument = await portal.request('POST', `/d/${id}/decision`, { json: { ...declined, acceptedName: 'Mallory' }, headers: { origin: portal.baseUrl } });
      assert.equal(viaDocument.status, 200);
      assert.equal(viaDocument.json.decision.acceptedName, 'Alice Approver');
      const stored = await portal.request('GET', `/offers/${token}/status`);
      assert.equal(stored.json.decision.decision, 'accepted');
      assert.equal(stored.json.decision.acceptedName, 'Alice Approver');
    });

    test('concurrent decisions settle on exactly one winner', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-204' }));
      const responses = await Promise.all(Array.from({ length: 6 }, (_, index) =>
        decide(token, { ...(index % 2 ? accepted : declined), acceptedName: `Caller ${index}` })));
      assert.ok(responses.every((response) => response.status === 200));
      const names = new Set(responses.map((response) => response.json.decision.acceptedName));
      assert.equal(names.size, 1, `every caller sees the same winner: ${[...names]}`);
      assert.equal((await portal.request('GET', `/offers/${token}/status`)).json.decision.acceptedName, [...names][0]);
    });

    test('an expired offer cannot be decided and shows as expired', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-205' }), { expiresAt: '2000-01-01T00:00:00.000Z' });
      const id = await documentOf(token);
      const legacy = await decide(token);
      assert.equal(legacy.status, 410);
      assert.deepEqual(legacy.json, { error: 'expired' });
      const viaDocument = await portal.request('POST', `/d/${id}/decision`, { json: accepted, headers: { origin: portal.baseUrl } });
      assert.equal(viaDocument.status, 410);
      assert.equal((await portal.request('GET', `/offers/${token}/status`)).json.decision, null);
      assert.equal((await portal.request('GET', `/offers/${token}`)).json.expired, true);
      const page = await portal.request('GET', `/d/${id}`, { headers: { accept: 'text/html' } });
      assert.match(page.text, /Abgelaufen/);
      assert.match(page.text, /Dieser Link ist abgelaufen/);
      assert.ok(!page.text.includes('<form'));
    });

    test('an invoice cannot be decided on either route', async () => {
      const token = await publishInvoice(invoiceSnapshot({ number: 'RE-2026-201' }));
      assert.equal((await decide(token)).status, 404);
      const id = await documentOf(token, 'invoices');
      const response = await portal.request('POST', `/d/${id}/decision`, { json: accepted, headers: { origin: portal.baseUrl } });
      assert.equal(response.status, 404);
      assert.equal((await portal.request('GET', `/offers/${token}/status`)).status, 404);
    });

    test('an unknown offer token cannot be decided', async () => {
      assert.equal((await decide(newToken('ghost'))).status, 404);
      assert.equal((await portal.request('POST', '/d/doesnotexistdoc/decision', { json: accepted, headers: { origin: portal.baseUrl } })).status, 404);
    });

    test('the browser form posts with a matching CSRF cookie and is redirected to the document', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-206' }));
      const id = await documentOf(token);
      const page = await portal.request('GET', `/d/${id}`, { headers: { accept: 'text/html' } });
      const cookie = page.cookies.find((entry) => entry.startsWith('csrfToken='));
      assert.ok(cookie, 'the document page sets a CSRF cookie');
      assert.match(cookie!, /HttpOnly/);
      assert.match(cookie!, /SameSite=Strict/);
      assert.ok(!/;\s*Secure/i.test(cookie!), 'a plain-http portal must not set Secure');
      const csrf = decodeURIComponent(/csrfToken=([^;]+)/.exec(cookie!)![1]!);
      assert.ok(page.text.includes(`name="csrfToken" value="${csrf}"`), 'the form embeds the same token');

      const response = await portal.request('POST', `/d/${id}/decision`, {
        form: { ...accepted, csrfToken: csrf },
        headers: { origin: portal.baseUrl, cookie: `csrfToken=${encodeURIComponent(csrf)}`, accept: 'text/html' },
      });
      assert.equal(response.status, 302, response.text);
      assert.equal(response.headers.location, `/d/${id}`);
      assert.equal((await portal.request('GET', `/offers/${token}/status`)).json.decision.decision, 'accepted');
    });

    test('a form post without or with a mismatching CSRF token is refused and stores nothing', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-207' }));
      const id = await documentOf(token);
      const post = (form: Record<string, string>, cookie?: string) =>
        portal.request('POST', `/d/${id}/decision`, { form, headers: { origin: portal.baseUrl, ...(cookie ? { cookie } : {}) } });
      const noCookie = await post({ ...accepted, csrfToken: 'abc' });
      assert.equal(noCookie.status, 403);
      assert.deepEqual(noCookie.json, { error: 'csrf_invalid' });
      assert.equal((await post({ ...accepted })).status, 403, 'no token at all');
      assert.equal((await post({ ...accepted, csrfToken: 'abc' }, 'csrfToken=different')).status, 403, 'mismatch');
      assert.equal((await post({ ...accepted, csrfToken: '' }, 'csrfToken=')).status, 403, 'empty token and cookie');
      assert.equal((await portal.request('GET', `/offers/${token}/status`)).json.decision, null);
      const html = await portal.request('POST', `/d/${id}/decision`, { form: { ...accepted }, headers: { origin: portal.baseUrl, accept: 'text/html' } });
      assert.equal(html.status, 403);
      assert.match(html.text, /Diese Entscheidung konnte nicht gespeichert werden/);
    });

    test('foreign origins, hosts and a suppressed Origin on non-form posts are refused', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-208' }));
      const id = await documentOf(token);
      const evilOrigin = await portal.request('POST', `/d/${id}/decision`, { json: accepted, headers: { origin: 'https://evil.example' } });
      assert.equal(evilOrigin.status, 403);
      assert.deepEqual(evilOrigin.json, { error: 'origin_invalid' });
      const nullOriginJson = await portal.request('POST', `/d/${id}/decision`, { json: accepted, headers: { origin: 'null' } });
      assert.equal(nullOriginJson.status, 403, 'Origin: null is only tolerated for form posts');
      const noOriginJson = await portal.request('POST', `/d/${id}/decision`, { json: accepted });
      assert.equal(noOriginJson.status, 403, 'a JSON post must name its origin');
      const csrf = 'token-value';
      const evilHost = await portal.request('POST', `/d/${id}/decision`, {
        form: { ...accepted, csrfToken: csrf }, headers: { origin: 'null', host: 'evil.example', cookie: `csrfToken=${csrf}` },
      });
      assert.equal(evilHost.status, 403, 'a suppressed Origin from a foreign host');
      const legacyEvil = await decide(token, accepted, { origin: 'https://evil.example' });
      assert.equal(legacyEvil.status, 403);
      assert.equal((await portal.request('GET', `/offers/${token}/status`)).json.decision, null);
    });

    test('a suppressed Origin is accepted for a form post addressed to the portal host', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-209' }));
      const id = await documentOf(token);
      const csrf = 'token-value-2';
      const response = await portal.request('POST', `/d/${id}/decision`, {
        form: { ...accepted, csrfToken: csrf },
        headers: { origin: 'null', host: new URL(portal.baseUrl).host, cookie: `csrfToken=${csrf}` },
      });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.decision.decision, 'accepted');
      assert.equal(response.headers['referrer-policy'], 'same-origin', 'the decision response keeps the policy that makes the browser send an Origin');
      const noCsrf = await portal.request('POST', `/d/${id}/decision`, {
        form: { ...accepted }, headers: { origin: 'null', host: new URL(portal.baseUrl).host },
      });
      assert.equal(noCsrf.status, 403, 'tolerating a suppressed Origin must not drop the CSRF requirement');
      assert.deepEqual(noCsrf.json, { error: 'csrf_invalid' });
    });

    test('decisions are rate limited per caller address', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-210' }));
      const caller = { 'x-forwarded-for': pinnedAddress(7) };
      for (let attempt = 1; attempt <= 30; attempt += 1) {
        const response = await decide(token, accepted, caller);
        assert.equal(response.status, 200, `attempt ${attempt}`);
      }
      const limited = await decide(token, accepted, caller);
      assert.equal(limited.status, 429);
      assert.deepEqual(limited.json, { error: 'rate_limited' });
      assert.ok(Number(limited.headers['retry-after']) >= 1);
      const other = await decide(token, accepted, { 'x-forwarded-for': pinnedAddress(8) });
      assert.equal(other.status, 200, 'another caller is not affected');
    });

    test('reads are rate limited per caller address and the browser gets a friendly page', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-2026-211' }));
      const caller = { 'x-forwarded-for': pinnedAddress(20) };
      for (let attempt = 1; attempt <= 180; attempt += 1) {
        const response = await portal.request('GET', `/offers/${token}/status`, { headers: caller });
        assert.equal(response.status, 200, `read ${attempt}`);
      }
      const limited = await portal.request('GET', `/offers/${token}/status`, { headers: caller });
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers['retry-after']) >= 1);
      const page = await portal.request('GET', `/offers/${token}`, { headers: { ...caller, accept: 'text/html' } });
      assert.equal(page.status, 429);
      assert.match(page.text, /Zu viele Aufrufe/);
      assert.equal((await portal.request('GET', `/offers/${token}/status`, { headers: { 'x-forwarded-for': pinnedAddress(21) } })).status, 200);
    });
  });

  describe('invoices', () => {
    test('a published invoice is readable, has a 365 day default expiry and no decision field', async () => {
      const snapshot = invoiceSnapshot({ number: 'RE-2026-301', status: 'paid' });
      const token = await publishInvoice(snapshot);
      const response = await portal.request('GET', `/invoices/${token}`);
      assert.equal(response.status, 200);
      assert.deepEqual(response.json.snapshot, snapshot);
      assert.ok(!('decision' in response.json));
      const days = (Date.parse(response.json.expiresAt) - Date.parse(response.json.publishedAt)) / DAY;
      assert.ok(Math.abs(days - 365) < 0.01, `default expiry is 365 days, got ${days}`);
      const id = await documentOf(token, 'invoices');
      const page = await portal.request('GET', `/d/${id}`, { headers: { accept: 'text/html' } });
      assert.match(page.text, /Rechnung RE-2026-301/);
      assert.match(page.text, /Bezahlt/);
      assert.ok(!page.text.includes('<form'), 'invoices never show a decision form');
      assert.ok(!page.cookies.some((cookie) => cookie.startsWith('csrfToken=')));
      assert.equal((await portal.request('GET', `/d/${id}`)).json.decision, undefined);
    });

    test('an offer token is not an invoice token and the other way round', async () => {
      const offerToken = await publishOffer();
      const invoiceToken = await publishInvoice();
      assert.equal((await portal.request('GET', `/invoices/${offerToken}`)).status, 404);
      assert.equal((await portal.request('GET', `/offers/${invoiceToken}`)).status, 404);
      assert.equal((await portal.request('GET', `/invoices/${offerToken}/pdf`)).status, 404);
    });

    test('the customer is inferred from the client id, then from the e-mail address', async () => {
      const byId = await publishInvoice(invoiceSnapshot({ clientId: 'infer-1', number: 'RE-2026-302' }));
      const byEmail = await publishInvoice(invoiceSnapshot({ clientEmail: 'Infer.Me@Example.com', number: 'RE-2026-303' }));
      assert.ok(byId && byEmail);
      const idLink = await customerLink('client:infer-1');
      assert.deepEqual((await listing(idLink.token)).items.map((item) => item.number), ['RE-2026-302']);
      const emailLink = await customerLink(`email:${sha256('infer.me@example.com')}`);
      assert.deepEqual((await listing(emailLink.token)).items.map((item) => item.number), ['RE-2026-303']);
    });

    test('an invoice that changes status shows the new status after a re-publish', async () => {
      const token = await publishInvoice(invoiceSnapshot({ number: 'RE-2026-304', status: 'open' }), { customerRef: 'client:status-flip' });
      const link = await customerLink('client:status-flip');
      assert.equal((await listing(link.token)).items[0]!.status, 'Offen');
      await publishInvoice(invoiceSnapshot({ number: 'RE-2026-304', status: 'paid' }), { token, customerRef: 'client:status-flip' });
      assert.equal((await listing(link.token)).items[0]!.status, 'Bezahlt');
    });
  });

  describe('PDF storage', () => {
    const pdfBytes = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 254, 1, 2, 3]);
    const multipart = (kind: 'offer' | 'invoice', token: string, extra: Record<string, string> = {}, bytes: Uint8Array = pdfBytes) => {
      const form = new FormData();
      form.set('token', token);
      form.set('snapshot', JSON.stringify(kind === 'offer' ? offerSnapshot({ number: 'ANG-2026-PDF' }) : invoiceSnapshot({ number: 'RE-2026-PDF' })));
      form.set('customerRef', 'client:pdf');
      for (const [key, value] of Object.entries(extra)) form.set(key, value);
      form.set('pdf', new Blob([bytes], { type: 'application/pdf' }), `${kind}.pdf`);
      return form;
    };

    test('an offer PDF is stored byte for byte and served on both URLs with frame-safe headers', async () => {
      const token = newToken('pdfoffer');
      const response = await portal.request('POST', '/offers', { multipart: multipart('offer', token), headers: portal.publishHeaders() });
      assert.equal(response.status, 200, response.text);
      assert.equal((await portal.request('GET', `/offers/${token}`)).json.hasPdf, true);
      const id = await documentOf(token);
      for (const path of [`/d/${id}/pdf`, `/offers/${token}/pdf`]) {
        const pdf = await portal.request('GET', path);
        assert.equal(pdf.status, 200, path);
        assert.equal(pdf.headers['content-type'], 'application/pdf');
        assert.equal(pdf.headers['x-frame-options'], 'SAMEORIGIN', 'the document page embeds the PDF in a same-origin frame');
        assert.match(String(pdf.headers['cache-control']), /no-store/);
        assert.deepEqual([...pdf.body], [...pdfBytes], path);
      }
      const page = await portal.request('GET', `/d/${id}`, { headers: { accept: 'text/html' } });
      assert.ok(page.text.includes(`src="/d/${id}/pdf"`), 'the page embeds the PDF');
    });

    test('an invoice PDF is stored and served, and a large file survives unchanged', async () => {
      const token = newToken('pdfinvoice');
      const big = new Uint8Array(2_000_000).map((_, index) => (index * 31) % 256);
      const response = await portal.request('POST', '/invoices', { multipart: multipart('invoice', token, {}, big), headers: portal.publishHeaders() });
      assert.equal(response.status, 200, response.text);
      const id = await documentOf(token, 'invoices');
      for (const path of [`/d/${id}/pdf`, `/invoices/${token}/pdf`]) {
        const pdf = await portal.request('GET', path);
        assert.equal(pdf.status, 200, path);
        assert.ok(pdf.body.equals(Buffer.from(big)), `${path} returns the uploaded bytes`);
      }
    });

    test('a document without a PDF and an unknown document answer 404, and PDFs do not cross documents', async () => {
      const withPdf = newToken('pdfa');
      const without = await publishOffer(offerSnapshot({ number: 'ANG-2026-NOPDF' }));
      assert.equal((await portal.request('POST', '/offers', { multipart: multipart('offer', withPdf), headers: portal.publishHeaders() })).status, 200);
      assert.equal((await portal.request('GET', `/d/${await documentOf(without)}/pdf`)).status, 404);
      assert.equal((await portal.request('GET', `/offers/${without}/pdf`)).status, 404);
      assert.equal((await portal.request('GET', '/d/doesnotexistdoc/pdf')).status, 404);
      assert.equal((await portal.request('GET', `/offers/${newToken('ghost')}/pdf`)).status, 404);
      assert.equal((await portal.request('GET', `/invoices/${withPdf}/pdf`)).status, 404, 'an offer PDF is not reachable through the invoice route');
    });

    test('multipart publishes need a real token and a supported content type', async () => {
      const short = new FormData();
      short.set('token', 'short');
      short.set('snapshot', '{}');
      const response = await portal.request('POST', '/offers', { multipart: short, headers: portal.publishHeaders() });
      assert.equal(response.status, 400);
      assert.deepEqual(response.json, { error: 'token required' });
      const invoice = await portal.request('POST', '/invoices', { multipart: short, headers: portal.publishHeaders() });
      assert.equal(invoice.status, 400);
      for (const path of ['/offers', '/invoices']) {
        const unsupported = await portal.request('POST', path, { raw: { body: 'token=x', contentType: 'text/plain' }, headers: portal.publishHeaders() });
        assert.equal(unsupported.status, 415, path);
      }
    });

    test('the multipart expiry, customer and label are honoured', async () => {
      const token = newToken('pdfmeta');
      const expiresAt = new Date(Date.now() + 5 * DAY).toISOString();
      const form = multipart('offer', token, { expiresAt, customerRef: 'client:pdf-meta', customerLabel: 'PDF Meta Kunde' });
      assert.equal((await portal.request('POST', '/offers', { multipart: form, headers: portal.publishHeaders() })).status, 200);
      assert.equal((await portal.request('GET', `/offers/${token}`)).json.expiresAt, expiresAt);
      const link = await customerLink('client:pdf-meta');
      const items = (await listing(link.token)).items;
      assert.equal(items.length, 1);
      assert.equal(items[0]!.hasPdf, true);
    });
  });

  describe('customer access links', () => {
    test('a link has an unguessable token, the public URL and a 90 day default expiry', async () => {
      const link = await customerLink('client:link-1', { customerLabel: 'Link Kunde' });
      assert.ok(link.token.length >= 32, 'at least 24 random bytes');
      assert.equal(link.publicUrl, `${portal.baseUrl}/customers/${link.token}`);
      const days = (Date.parse(link.expiresAt) - Date.now()) / DAY;
      assert.ok(Math.abs(days - 90) < 0.01, `default expiry is 90 days, got ${days}`);
      const custom = await customerLink('client:link-1', { expiresInDays: 7 });
      assert.notEqual(custom.token, link.token);
      assert.ok(Math.abs((Date.parse(custom.expiresAt) - Date.now()) / DAY - 7) < 0.01);
      const max = await portal.accessLink('client:link-1', { expiresInDays: 365 });
      assert.equal(max.status, 200, 'one year is the upper bound');
    });

    test('the listing contains only that customer\'s documents, newest first, without raw tokens', async () => {
      const refA = `client:iso-a-${Math.random().toString(36).slice(2)}`;
      const refB = `client:iso-b-${Math.random().toString(36).slice(2)}`;
      const offerToken = await publishOffer(offerSnapshot({ number: 'ANG-A-1' }), { customerRef: refA });
      await pause(5);
      const invoiceToken = await publishInvoice(invoiceSnapshot({ number: 'RE-A-1', status: 'overdue' }), { customerRef: refA });
      await publishOffer(offerSnapshot({ number: 'ANG-B-1' }), { customerRef: refB });
      const linkA = await customerLink(refA, { customerLabel: 'Kunde A' });
      const result = await listing(linkA.token);
      assert.deepEqual(result.items.map((item) => item.number), ['RE-A-1', 'ANG-A-1'], 'newest first, customer B excluded');
      assert.deepEqual(result.items.map((item) => item.kind), ['invoice', 'offer']);
      assert.deepEqual(result.items.map((item) => item.status), ['Überfällig', 'Offen']);
      assert.equal(result.items[0]!.amount, 1299.99);
      for (const item of result.items) {
        assert.match(item.url, /^\/d\/[0-9a-zA-Z]+$/);
        assert.ok(!item.url.includes(offerToken) && !item.url.includes(invoiceToken), 'the listing never exposes a document token');
      }
      assert.ok(!JSON.stringify(result).includes(offerToken));
      const linkB = await customerLink(refB);
      assert.deepEqual((await listing(linkB.token)).items.map((item) => item.number), ['ANG-B-1']);
    });

    test('the listing maps decisions and expiry to the customer-facing status', async () => {
      const ref = `client:status-${Math.random().toString(36).slice(2)}`;
      const acceptedToken = await publishOffer(offerSnapshot({ number: 'ANG-S-1' }), { customerRef: ref });
      const declinedToken = await publishOffer(offerSnapshot({ number: 'ANG-S-2' }), { customerRef: ref });
      await publishOffer(offerSnapshot({ number: 'ANG-S-3' }), { customerRef: ref, expiresAt: '2000-01-01T00:00:00.000Z' });
      await publishOffer(offerSnapshot({ number: 'ANG-S-4' }), { customerRef: ref });
      assert.equal((await decide(acceptedToken, accepted)).status, 200);
      assert.equal((await decide(declinedToken, declined)).status, 200);
      const link = await customerLink(ref);
      const byNumber = Object.fromEntries((await listing(link.token)).items.map((item) => [item.number, item.status]));
      assert.deepEqual(byNumber, { 'ANG-S-1': 'Angenommen', 'ANG-S-2': 'Abgelehnt', 'ANG-S-3': 'Abgelaufen', 'ANG-S-4': 'Offen' });
    });

    test('kind filter, limit and cursor page through every document exactly once', async () => {
      const ref = `client:paging-${Math.random().toString(36).slice(2)}`;
      for (let index = 1; index <= 5; index += 1) {
        await publishOffer(offerSnapshot({ number: `ANG-P-${index}` }), { customerRef: ref });
        await pause(4);
        await publishInvoice(invoiceSnapshot({ number: `RE-P-${index}` }), { customerRef: ref });
        await pause(4);
      }
      const link = await customerLink(ref);
      assert.equal((await listing(link.token)).items.length, 10);
      assert.deepEqual((await listing(link.token, '?kind=offer')).items.map((item) => item.kind), ['offer', 'offer', 'offer', 'offer', 'offer']);
      assert.ok((await listing(link.token, '?kind=invoice')).items.every((item) => item.kind === 'invoice'));
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const result = await listing(link.token, `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        seen.push(...result.items.map((item) => item.number));
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      assert.equal(seen.length, 10, `paging lost or repeated documents: ${seen}`);
      assert.equal(new Set(seen).size, 10);
      assert.equal(seen[0], 'RE-P-5', 'newest first');
      assert.equal(seen.at(-1), 'ANG-P-1');
    });

    test('an unknown token is 404, a rotated link is 403 revoked and a new link works', async () => {
      const ref = `client:rotate-${Math.random().toString(36).slice(2)}`;
      const other = `client:rotate-other-${Math.random().toString(36).slice(2)}`;
      await publishOffer(offerSnapshot({ number: 'ANG-R-1' }), { customerRef: ref });
      const first = await customerLink(ref);
      const bystander = await customerLink(other);
      assert.equal((await portal.request('GET', `/customers/${newToken('nolink')}/documents`)).status, 404);
      assert.equal((await listing(first.token)).items.length, 1);

      const rotated = await portal.accessLink(ref, { customerLabel: 'Neu', expiresInDays: 30 }, true);
      assert.equal(rotated.status, 200);
      assert.notEqual(rotated.json.token, first.token);
      const old = await portal.request('GET', `/customers/${first.token}/documents`);
      assert.equal(old.status, 403);
      assert.deepEqual(old.json, { error: 'revoked' });
      const oldPage = await portal.request('GET', `/customers/${first.token}`, { headers: { accept: 'text/html' } });
      assert.equal(oldPage.status, 403);
      assert.match(oldPage.text, /Dieser Link wurde zurückgezogen/);
      assert.equal((await listing(rotated.json.token)).items.length, 1);
      assert.equal((await portal.request('GET', `/customers/${bystander.token}/documents`)).status, 200, 'another customer\'s link is untouched');
      const again = await portal.accessLink(ref, {}, true);
      assert.equal((await portal.request('GET', `/customers/${rotated.json.token}/documents`)).status, 403, 'rotating twice revokes the previous rotation too');
      assert.equal((await listing(again.json.token)).items.length, 1);
    });

    test('rotating a customer without an earlier link simply creates one', async () => {
      const rotated = await portal.accessLink(`client:fresh-${Math.random().toString(36).slice(2)}`, {}, true);
      assert.equal(rotated.status, 200);
      assert.equal((await listing(rotated.json.token)).items.length, 0);
    });

    test('revoking the link does not retract documents the customer already holds a direct link to', async () => {
      const ref = `client:direct-${Math.random().toString(36).slice(2)}`;
      const token = await publishOffer(offerSnapshot({ number: 'ANG-D-1' }), { customerRef: ref });
      const link = await customerLink(ref);
      await portal.accessLink(ref, {}, true);
      assert.equal((await portal.request('GET', `/customers/${link.token}/documents`)).status, 403);
      assert.equal((await portal.request('GET', `/offers/${token}`)).status, 200, 'the offer link itself is a separate bearer secret');
    });

    test('an expired customer link answers 410 as JSON and as a page', async () => {
      const token = newToken('expired-link');
      await portal.store.createCustomerAccessToken({
        tokenHash: sha256(token), customerRef: 'client:expired-link', customerLabel: null,
        createdAt: new Date(Date.now() - 100 * DAY).toISOString(), expiresAt: new Date(Date.now() - DAY).toISOString(), revokedAt: null,
      });
      const json = await portal.request('GET', `/customers/${token}/documents`);
      assert.equal(json.status, 410);
      assert.deepEqual(json.json, { error: 'expired' });
      const page = await portal.request('GET', `/customers/${token}`, { headers: { accept: 'text/html' } });
      assert.equal(page.status, 410);
      assert.match(page.text, /Dieser Link ist abgelaufen/);
    });

    test('the customer page lists the documents and explains empty states', async () => {
      const ref = `client:page-${Math.random().toString(36).slice(2)}`;
      await publishOffer(offerSnapshot({ number: 'ANG-H-1' }), { customerRef: ref, customerLabel: 'Seitenkunde' });
      await publishInvoice(invoiceSnapshot({ number: 'RE-H-1', status: 'paid' }), { customerRef: ref });
      const link = await customerLink(ref, { customerLabel: 'Seitenkunde' });
      const page = await portal.request('GET', `/customers/${link.token}`, { headers: { accept: 'text/html' } });
      assert.equal(page.status, 200);
      for (const text of ['Bisherige Dokumente', 'Seitenkunde', 'ANG-H-1', 'RE-H-1', 'Bezahlt', 'Offen', '1.299,99']) assert.ok(page.text.includes(text), text);
      assert.match(String(page.headers['cache-control']), /no-store/);
      const empty = await customerLink(`client:empty-${Math.random().toString(36).slice(2)}`);
      assert.match((await portal.request('GET', `/customers/${empty.token}`)).text, /Noch keine Dokumente freigegeben/);
      const filtered = await portal.request('GET', `/customers/${link.token}?kind=offer&limit=1`);
      assert.equal(filtered.status, 200);
      const noInvoices = await customerLink(`client:only-offers-${Math.random().toString(36).slice(2)}`);
      assert.match((await portal.request('GET', `/customers/${noInvoices.token}?kind=invoice`)).text, /Keine Rechnungen in dieser Ansicht/);
      assert.equal((await portal.request('GET', `/customers/${newToken('nopage')}`, { headers: { accept: 'text/html' } })).status, 404);
      assert.equal((await portal.request('GET', '/customers/short', { headers: { accept: 'text/html' } })).status, 404);
    });

    test('a link without a label falls back to the document owner label', async () => {
      const ref = `client:label-${Math.random().toString(36).slice(2)}`;
      await publishOffer({ number: 'ANG-L-1' }, { customerRef: ref });
      const link = await customerLink(ref, { customerLabel: 'Label vom Link' });
      assert.equal((await listing(link.token)).items[0]!.client, 'Label vom Link');
    });
  });

  describe('request validation', () => {
    test('malformed requests are client errors, never 500', async () => {
      const token = await publishOffer(offerSnapshot({ number: 'ANG-V-1' }));
      const link = await customerLink(`client:validation-${Math.random().toString(36).slice(2)}`);
      const key = portal.publishHeaders();
      const cases: Array<[string, Promise<{ status: number }>]> = [
        ['publish without token', portal.request('POST', '/offers', { json: { snapshot: {} }, headers: key })],
        ['publish with a short token', portal.request('POST', '/offers', { json: { token: 'short', snapshot: {} }, headers: key })],
        ['publish with broken JSON', portal.request('POST', '/offers', { raw: { body: '{nope', contentType: 'application/json' }, headers: key })],
        ['invoice publish without token', portal.request('POST', '/invoices', { json: {}, headers: key })],
        ['access link without customer', portal.request('POST', '/customers/access-links', { json: {}, headers: key })],
        ['access link beyond 365 days', portal.request('POST', '/customers/access-links', { json: { customerRef: 'x', expiresInDays: 366 }, headers: key })],
        ['access link with zero days', portal.request('POST', '/customers/access-links', { json: { customerRef: 'x', expiresInDays: 0 }, headers: key })],
        ['status with a short token', portal.request('GET', '/offers/short/status')],
        ['offer pdf with a short token', portal.request('GET', '/offers/short/pdf')],
        ['invoice pdf with a short token', portal.request('GET', '/invoices/short/pdf')],
        ['document pdf with a short id', portal.request('GET', '/d/short/pdf')],
        ['listing with a short token', portal.request('GET', '/customers/short/documents')],
        ['listing with an unknown kind', portal.request('GET', `/customers/${link.token}/documents?kind=bogus`)],
        ['listing with limit 0', portal.request('GET', `/customers/${link.token}/documents?limit=0`)],
        ['decision without a name', decide(token, { decision: 'accepted', acceptedEmail: 'a@b.de', decisionTextVersion: 'v1' })],
        ['decision with an unknown verdict', decide(token, { ...accepted, decision: 'maybe' })],
        ['decision with broken JSON', portal.request('POST', `/offers/${token}/decision`, { raw: { body: '{', contentType: 'application/json' }, headers: { origin: portal.baseUrl } })],
      ];
      const failures: string[] = [];
      for (const [label, pending] of cases) {
        const { status } = await pending;
        if (status < 400 || status >= 500) failures.push(`${label} -> ${status}`);
      }
      assert.deepEqual(failures, []);
      assert.equal((await portal.request('GET', `/offers/${token}/status`)).json.decision, null, 'no rejected decision was stored');
    });
  });

  describe('store contract', () => {
    const base = { publishedAt: '2026-02-01T00:00:00.000Z', expiresAt: '2099-12-31T00:00:00.000Z' };

    test('the document id stays stable across upserts of the same token, for offers and invoices', async () => {
      const offerHash = sha256(newToken('store-offer'));
      await portal.store.upsertOffer({ ...base, tokenHash: offerHash, snapshotJson: { number: 'A' } });
      const first = await portal.store.getDocumentByTokenHash(offerHash);
      assert.ok(first?.documentId);
      await portal.store.upsertOffer({ ...base, tokenHash: offerHash, snapshotJson: { number: 'B' } });
      const second = await portal.store.getDocumentByTokenHash(offerHash);
      assert.equal(second?.documentId, first.documentId);
      assert.deepEqual(second?.snapshotJson, { number: 'B' });
      assert.equal((await portal.store.getDocumentById(first.documentId))?.tokenHash, offerHash);

      const invoiceHash = sha256(newToken('store-invoice'));
      await portal.store.upsertInvoice({ ...base, tokenHash: invoiceHash, customerRef: 'client:store', snapshotJson: { number: 'R1' } });
      const invoice = await portal.store.getDocumentByTokenHash(invoiceHash);
      await portal.store.upsertInvoice({ ...base, tokenHash: invoiceHash, customerRef: 'client:store', snapshotJson: { number: 'R2' } });
      assert.equal((await portal.store.getDocumentByTokenHash(invoiceHash))?.documentId, invoice?.documentId);
    });

    test('moving a document to an explicit id releases the old id', async () => {
      const tokenHash = sha256(newToken('store-move'));
      await portal.store.upsertOffer({ ...base, tokenHash, documentId: 'd-old-id-1', snapshotJson: { number: 'M1' } });
      await portal.store.upsertOffer({ ...base, tokenHash, documentId: 'd-new-id-1', snapshotJson: { number: 'M2' } });
      assert.equal(await portal.store.getDocumentById('d-old-id-1'), null);
      assert.equal((await portal.store.getDocumentById('d-new-id-1'))?.documentId, 'd-new-id-1');
    });

    test('a decision is stored once whichever way it is addressed', async () => {
      const tokenHash = sha256(newToken('store-decision'));
      await portal.store.upsertOffer({ ...base, tokenHash, snapshotJson: {} });
      const documentId = (await portal.store.getDocumentByTokenHash(tokenHash))!.documentId;
      const first = await portal.store.setDecisionOnce(tokenHash, { decidedAt: '2026-03-01T00:00:00.000Z', decision: 'accepted', acceptedName: 'First', acceptedEmail: 'first@example.com', decisionTextVersion: 'v1' });
      const second = await portal.store.setDecisionOnceByDocumentId(documentId, { decidedAt: '2026-03-02T00:00:00.000Z', decision: 'declined', acceptedName: 'Second', acceptedEmail: 'second@example.com', decisionTextVersion: 'v2' });
      assert.deepEqual(second, first);
      assert.equal((await portal.store.getOfferByTokenHash(tokenHash))?.decision?.acceptedName, 'First');
      assert.equal((await portal.store.getDocumentByTokenHash(tokenHash))?.decision?.acceptedName, 'First');
      await assert.rejects(portal.store.setDecisionOnce(sha256('unknown'), first), /not found/);
    });
  });
});

describe('offer portal', () => {
  portalContract('sqlite');
  portalContract('memory');

  describe('strict and open publish modes', () => {
    test('strict mode without a configured key fails closed with 503 on every publish route', async (t) => {
      const portal = await startPortal({ suite: 'offer-portal', apiKey: null, requirePublishApiKey: true });
      t.after(() => portal.close());
      for (const [path, body] of [
        ['/offers', { token: newToken('strict'), snapshot: {} }],
        ['/invoices', { token: newToken('strict'), snapshot: {} }],
        ['/customers/access-links', { customerRef: 'client:strict' }],
        ['/customers/access-links/rotate', { customerRef: 'client:strict' }],
      ] as const) {
        const response = await portal.request('POST', path, { json: body, headers: { 'x-api-key': 'anything' } });
        assert.equal(response.status, 503, path);
        assert.deepEqual(response.json, { error: 'publish_api_key_required' }, path);
      }
      const setup = await portal.request('GET', '/admin/setup');
      assert.match(setup.text, /Fehlkonfiguration/);
    });

    test('a portal that is not strict and has no key accepts anonymous publishes (development mode)', async (t) => {
      const portal = await startPortal({ suite: 'offer-portal', apiKey: null, requirePublishApiKey: false });
      t.after(() => portal.close());
      const token = newToken('open');
      const response = await portal.request('POST', '/offers', { json: { token, snapshot: offerSnapshot() } });
      assert.equal(response.status, 200);
      assert.equal((await portal.request('GET', `/offers/${token}`)).status, 200);
      const setup = await portal.request('GET', '/admin/setup');
      assert.match(setup.text, /PUBLISH_API_KEY<\/strong>: nicht gesetzt/);
    });

    test('a configured public base URL is used in links; the origin the request arrived on is still accepted behind a proxy, foreign ones are not', async (t) => {
      const portal = await startPortal({ suite: 'offer-portal', publicBaseUrl: 'https://offers.example.test' });
      t.after(() => portal.close());
      const token = newToken('origin');
      await portal.publish('offers', { token, snapshot: offerSnapshot(), customerRef: 'client:origin' });
      const link = await portal.accessLink('client:origin');
      assert.equal(link.json.publicUrl, `https://offers.example.test/customers/${link.json.token}`, 'public URLs use the configured base');
      const foreign = await portal.request('POST', `/offers/${token}/decision`, { json: accepted, headers: { origin: 'https://evil.example' } });
      assert.equal(foreign.status, 403);
      const publicOrigin = await portal.request('POST', `/offers/${token}/decision`, { json: accepted, headers: { origin: 'https://offers.example.test' } });
      assert.equal(publicOrigin.status, 200);
    });

    test('without a public base URL the portal checks no origin (development mode)', async (t) => {
      const portal = await startPortal({ suite: 'offer-portal', publicBaseUrl: '' });
      t.after(() => portal.close());
      const token = newToken('norigin');
      await portal.publish('offers', { token, snapshot: offerSnapshot() });
      const response = await portal.request('POST', `/offers/${token}/decision`, { json: accepted, headers: { origin: 'https://anywhere.example' } });
      assert.equal(response.status, 200);
      const link = await portal.accessLink('client:norigin');
      assert.equal(link.json.publicUrl, `/customers/${link.json.token}`, 'links are relative without a base URL');
    });
  });
});

describe('offer portal persistence', () => {
  test('a SQLite-backed portal keeps documents, decisions, PDFs and access links across a restart, and stores no raw token', async (t) => {
    const first = await startPortal({ suite: 'offer-portal-restart', store: 'sqlite' });
    t.after(() => first.close());
    const token = newToken('persist-offer');
    const pdf = Uint8Array.from([37, 80, 68, 70, 1, 2, 3, 4]);
    const form = new FormData();
    form.set('token', token);
    form.set('snapshot', JSON.stringify(offerSnapshot({ number: 'ANG-X-1' })));
    form.set('customerRef', 'client:persist');
    form.set('pdf', new Blob([pdf], { type: 'application/pdf' }), 'offer.pdf');
    assert.equal((await first.request('POST', '/offers', { multipart: form, headers: first.publishHeaders() })).status, 200);
    const redirect = await first.request('GET', `/offers/${token}`, { headers: { accept: 'text/html' } });
    const id = documentIdFromUrl(String(redirect.headers.location));
    const decided = await first.request('POST', `/offers/${token}/decision`, { json: accepted, headers: { origin: first.baseUrl } });
    assert.equal(decided.status, 200);
    const link = (await first.accessLink('client:persist', { customerLabel: 'Persist' })).json;
    await first.close({ keepData: true });

    const second = await startPortal({ suite: 'offer-portal-restart', store: 'sqlite', dir: first.dir, apiKey: first.apiKey });
    t.after(() => second.close());
    const status = await second.request('GET', `/offers/${token}/status`);
    assert.equal(status.json.decision.acceptedName, 'Alice Approver');
    assert.equal((await second.request('GET', `/d/${id}`)).json.snapshot.number, 'ANG-X-1', 'the document id is stable across restarts');
    assert.deepEqual([...(await second.request('GET', `/d/${id}/pdf`)).body], [...pdf]);
    const listing = await second.request('GET', `/customers/${link.token}/documents`);
    assert.equal(listing.status, 200);
    assert.equal(listing.json.items[0].status, 'Angenommen');
    const again = await second.request('POST', `/offers/${token}/decision`, { json: declined, headers: { origin: second.baseUrl } });
    assert.equal(again.json.decision.decision, 'accepted', 'the decision is still final after the restart');

    const database = await readFile(join(second.dir, 'portal.sqlite'));
    assert.ok(!database.includes(token), 'the offer token is stored hashed');
    assert.ok(!database.includes(link.token), 'the customer link token is stored hashed');
    assert.ok(database.includes(sha256(token)), 'the hash is what identifies the document');
    const files = await readdir(join(second.dir, 'pdfs'));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^offer-\d+-[0-9a-f]{10}\.pdf$/, 'PDF files are named from the token hash, not the token');
  });
});

describe('offer portal rendering', () => {
  test('the pages use exactly the design tokens of packages/ui/styles.css', async (t) => {
    const css = await readFile(resolve(here, '..', '..', 'ui', 'styles.css'), 'utf8');
    const tokens = designTokens(css);
    const portal = await startPortal({ suite: 'offer-portal', store: 'memory' });
    t.after(() => portal.close());
    const html: string[] = [];
    const page = async (path: string) => {
      const response = await portal.request('GET', path, { headers: { accept: 'text/html' } });
      html.push(response.text);
      return response;
    };
    const publish = async (number: string, extra: Record<string, unknown> = {}) => {
      const token = newToken('tokens');
      await portal.publish('offers', { token, snapshot: offerSnapshot({ number }), customerRef: 'client:tokens', ...extra });
      return token;
    };
    const documentPage = async (token: string) => {
      const redirect = await portal.request('GET', `/offers/${token}`, { headers: { accept: 'text/html' } });
      return page(String(redirect.headers.location));
    };
    const open = await publish('ANG-T-1');
    await documentPage(open);
    const acceptedToken = await publish('ANG-T-2');
    await portal.request('POST', `/offers/${acceptedToken}/decision`, { json: accepted, headers: { origin: portal.baseUrl } });
    await documentPage(acceptedToken);
    const declinedToken = await publish('ANG-T-3');
    await portal.request('POST', `/offers/${declinedToken}/decision`, { json: declined, headers: { origin: portal.baseUrl } });
    await documentPage(declinedToken);
    await documentPage(await publish('ANG-T-4', { expiresAt: '2000-01-01T00:00:00.000Z' }));
    await page('/');
    await page('/does-not-exist');
    const link = (await portal.accessLink('client:tokens')).json;
    await page(`/customers/${link.token}`);
    const combined = html.join('\n').toLowerCase();
    for (const [name, value] of Object.entries(tokens)) {
      assert.ok(combined.includes(value), `the rendered portal uses ${name} = ${value}`);
    }
  });
});
