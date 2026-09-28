import { test, expect } from '@playwright/test';
import { MOCK_SETTINGS } from '../../../packages/desktop-services/src/mockData.ts';

for (const product of ['lite', 'pro']) {
  test(`${product}: delayed login, server switch, reload and logout`, async ({ page }) => {
    const user = { id: 'owner', email: 'owner@example.com', fullName: 'Owner', role: 'owner' };
    let releaseLogin;
    await page.route('http://server-*.test/**', async route => {
      const url = new URL(route.request().url());
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      expect(url.pathname).toContain(`/api/v1/${product}/auth/`);
      if (url.pathname.endsWith('/bootstrap/status')) return route.fulfill({ json: { bootstrapped: true, userCount: 1 }, headers });
      if (url.pathname.endsWith('/login')) {
        if (url.hostname === 'server-a.test') await new Promise(resolve => { releaseLogin = resolve; });
        return route.fulfill({ json: { token: 'test-session', user }, headers });
      }
      return route.fulfill({ json: { user, tenantId: 'tenant', product, role: 'owner' }, headers });
    });
    await page.goto(`/?product=${product}`);
    await page.getByLabel('E-Mail-Adresse', { exact: true }).fill(user.email);
    await page.getByLabel('Passwort', { exact: true }).fill('secret-password');
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect.poll(() => Boolean(releaseLogin)).toBe(true);
    await page.getByRole('button', { name: 'Server-Adresse ändern' }).click();
    await page.getByRole('dialog').getByRole('textbox').fill('http://server-b.test');
    await page.getByRole('dialog').getByRole('button', { name: /Speichern|Verbinden|Übernehmen/ }).click();
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), `${product}.url`)).toBe('http://server-b.test');
    releaseLogin();
    await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeEnabled();
    expect(await page.evaluate(key => localStorage.getItem(key), `${product}.session`)).toBeNull();
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByText(`${product} angemeldet: http://server-b.test`, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Abmelden', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`${product}-logout.png`), fullPage: true });
  });

  test(`${product}: real renderer uses the new session after logout`, async ({ page }) => {
    const user = { id: 'owner', email: 'owner@example.com', fullName: 'Owner', role: 'owner' };
    let login = 0;
    const requests = [];
    await page.addInitScript(({ product }) => {
      localStorage.setItem(product === 'pro' ? 'billme.web-pro.api-url.v1' : 'billme.web.lite.api-url.v1', 'http://server-a.test');
    }, { product });
    await page.route('http://server-a.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (path.endsWith('/bootstrap/status')) return route.fulfill({ json: { bootstrapped: true, userCount: 1 }, headers });
      if (path.endsWith('/login')) return route.fulfill({ json: { token: `session-${++login}`, user }, headers });
      if (path.endsWith('/auth/me')) return route.fulfill({ json: { user, tenantId: 'tenant', product, role: 'owner' }, headers });
      requests.push(route.request().headers().authorization);
      return route.fulfill({ json: path.endsWith('/settings') ? MOCK_SETTINGS : [], headers });
    });
    await page.goto(`/?real&product=${product}`);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Abmelden', exact: true })).toBeVisible({ timeout: 15000 });
    await expect.poll(() => requests.includes('Bearer session-1')).toBe(true);
    await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Abmelden', exact: true })).toBeVisible();
    await expect.poll(() => requests.includes('Bearer session-2')).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`${product}-real-renderer.png`), fullPage: true });
  });
}

test('workspace isolation survives delayed failure, unmount and seed refresh', async ({ page }) => {
  await page.goto('/?workspace');
  const a = page.getByRole('region', { name: 'Workspace A', exact: true });
  const b = page.getByRole('region', { name: 'Workspace B', exact: true });
  await a.getByRole('button', { name: 'A Software GmbH öffnen', exact: true }).click();
  await a.getByRole('button', { name: 'Erweitern', exact: true }).click();
  await a.getByRole('textbox', { name: 'Buchungstext *', exact: true }).fill('A pending');
  await a.getByRole('button', { name: 'Speichern', exact: true }).click();
  await b.getByRole('button', { name: 'B Software GmbH öffnen', exact: true }).click();
  await b.getByRole('button', { name: 'Erweitern', exact: true }).click();
  await expect(b.getByRole('textbox', { name: 'Buchungstext *', exact: true })).toHaveValue('B original');
  await b.getByRole('textbox', { name: 'Buchungstext *', exact: true }).fill('B ungespeichert');
  await page.getByRole('button', { name: 'B aktualisieren', exact: true }).click();
  await expect(b.getByRole('textbox', { name: 'Buchungstext *', exact: true })).toHaveValue('B ungespeichert');
  await page.getByRole('button', { name: 'A schließen', exact: true }).click();
  await page.getByRole('button', { name: 'A Fehler freigeben', exact: true }).click();
  await expect(b.getByRole('textbox', { name: 'Buchungstext *', exact: true })).toHaveValue('B ungespeichert');
  await b.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(b.getByText('Entwurf gespeichert', { exact: true }).first()).toBeVisible();
  await b.getByRole('button', { name: 'Zurück zur Inbox', exact: true }).click();
  await b.getByRole('button', { name: 'B Software GmbH öffnen', exact: true }).click();
  await b.getByRole('button', { name: 'Erweitern', exact: true }).click();
  await expect(b.getByRole('textbox', { name: 'Buchungstext *', exact: true })).toHaveValue('B ungespeichert');
  await page.screenshot({ path: test.info().outputPath('workspace-isolation.png'), fullPage: true });
});
