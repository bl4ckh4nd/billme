import { test, expect } from '@playwright/test';

// Both servers are real hosted APIs on PGlite (servers.mts), with an owner per product.
const SERVER_A = 'http://127.0.0.1:4191';
const SERVER_B = 'http://127.0.0.1:4192';
const PASSWORD = 'billme-server-123';

const fillLogin = async (page, product) => {
  await page.getByLabel('E-Mail-Adresse', { exact: true }).fill(`owner-${product}@example.com`);
  await page.getByLabel('Passwort', { exact: true }).fill(PASSWORD);
};

for (const product of ['lite', 'pro']) {
  test(`${product}: a login still in flight on the old server is dropped after a server switch; reload keeps, logout ends the session`, async ({ page }) => {
    // Hold the real login request to server A until the user has switched to server B.
    let releaseLogin;
    await page.route(`${SERVER_A}/api/v1/${product}/auth/login`, async (route) => {
      await new Promise((resolve) => { releaseLogin = resolve; });
      await route.continue();
    });
    await page.goto(`/?product=${product}`);
    await fillLogin(page, product);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect.poll(() => Boolean(releaseLogin)).toBe(true);
    await page.getByRole('button', { name: 'Server-Adresse ändern' }).click();
    await page.getByRole('dialog').getByRole('textbox').fill(SERVER_B);
    await page.getByRole('dialog').getByRole('button', { name: /Speichern|Verbinden|Übernehmen/ }).click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), `${product}.url`)).toBe(SERVER_B);
    releaseLogin();
    await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeEnabled();
    expect(await page.evaluate((key) => localStorage.getItem(key), `${product}.session`), 'the late answer of server A is not stored').toBeNull();

    await fillLogin(page, product);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByText(`${product} angemeldet: ${SERVER_B}`, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Abmelden', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), `${product}.session`)).toBeNull();
    await page.screenshot({ path: test.info().outputPath(`${product}-logout.png`), fullPage: true });
  });

  test(`${product}: a wrong password is refused by the server and stores no session`, async ({ page }) => {
    await page.goto(`/?product=${product}`);
    await page.getByLabel('E-Mail-Adresse', { exact: true }).fill(`owner-${product}@example.com`);
    await page.getByLabel('Passwort', { exact: true }).fill('falsches-passwort');
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), `${product}.session`)).toBeNull();
    await expect(page.getByRole('button', { name: 'Abmelden', exact: true })).toHaveCount(0);
  });

  test(`${product}: the real renderer uses the new session after logout and never the old one`, async ({ page }) => {
    const bearers = [];
    page.on('request', (request) => {
      if (request.url().startsWith(SERVER_A) && !request.url().includes('/auth/')) {
        const authorization = request.headers().authorization;
        if (authorization) bearers.push(authorization);
      }
    });
    await page.addInitScript(({ key, url }) => { localStorage.setItem(key, url); }, { key: product === 'pro' ? 'billme.web-pro.api-url.v1' : 'billme.web.lite.api-url.v1', url: SERVER_A });
    await page.goto(`/?real&product=${product}`);
    await fillLogin(page, product);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Abmelden', exact: true })).toBeVisible({ timeout: 15000 });
    await expect.poll(() => bearers.length).toBeGreaterThan(0);
    const first = bearers[0];
    await page.getByRole('button', { name: 'Abmelden', exact: true }).click();
    const afterLogout = bearers.length;
    await fillLogin(page, product);
    await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Abmelden', exact: true })).toBeVisible();
    await expect.poll(() => bearers.length).toBeGreaterThan(afterLogout);
    expect(bearers.slice(afterLogout).every((bearer) => bearer !== first), 'no request after logout carries the old session').toBe(true);
    await page.screenshot({ path: test.info().outputPath(`${product}-real-renderer.png`), fullPage: true });
  });
}
