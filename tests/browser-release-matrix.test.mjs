import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { chromium } from 'playwright';

const projectDir = new URL('..', import.meta.url);
const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-browser-matrix-'));
const dataDir = join(tempDir, 'data');
await mkdir(dataDir, { recursive: true });

const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once('error', reject);
  portProbe.listen(0, '127.0.0.1', resolve);
});
const port = portProbe.address().port;
await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));

const server = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
  cwd: projectDir,
  env: {
    ...process.env,
    PORT: String(port),
    FIKRATAK_DATA_DIR: dataDir,
    FIKRATAK_BACKUP_DIR: join(tempDir, 'backups')
  },
  stdio: ['ignore', 'ignore', 'pipe']
});
let serverErrors = '';
server.stderr.on('data', (chunk) => { serverErrors += chunk.toString(); });

test('login, dashboard, database, and client link render across mobile/desktop, Arabic/English, light/dark', {
  concurrency: false,
  timeout: 120000
}, async (t) => {
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await once(server, 'exit');
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Browser-matrix server stopped: ${serverErrors}`);
    try { ready = (await fetch(baseUrl)).status === 200; } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Browser-matrix server did not start: ${serverErrors}`);

  const setup = await fetch(`${baseUrl}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'matrix-admin', password: 'Matrix-admin-pass-2026!' })
  });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const influencerResponse = await fetch(`${baseUrl}/api/influencers`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ Name: 'Synthetic Browser Matrix Creator', 'Username I': 'matrix_creator', 'Followers Count I': '15000' })
  });
  const influencerText = await influencerResponse.text();
  assert.equal(influencerResponse.status, 201, influencerText);
  const influencer = JSON.parse(influencerText);
  const catalogResponse = await fetch(`${baseUrl}/api/client-catalogs`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      brandId: 'fkretk', companyName: 'Synthetic Browser Matrix Company',
      offerName: 'Synthetic browser link', influencerIds: [influencer.record.id]
    })
  });
  const catalogText = await catalogResponse.text();
  assert.equal(catalogResponse.status, 201, catalogText);
  const catalog = JSON.parse(catalogText);
  const token = catalog.url.split('/').at(-1);
  const browser = await chromium.launch({ headless: true });

  try {
    for (const width of [390, 1440]) {
      for (const language of ['ar', 'en']) {
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 } });
          const page = await context.newPage();
          const pageErrors = [];
          page.on('pageerror', (error) => pageErrors.push(error.message));
          await page.addInitScript(({ appLanguage, appTheme, clientLanguage, clientTheme }) => {
            localStorage.setItem('fikratak.language', appLanguage);
            localStorage.setItem('fikratak.theme', appTheme);
            localStorage.setItem('fikratak.client.language', clientLanguage);
            localStorage.setItem('fikratak.client.theme', clientTheme);
          }, {
            appLanguage: language, appTheme: theme,
            clientLanguage: language, clientTheme: theme
          });

          await page.goto(baseUrl);
          await page.locator('#login-form').waitFor({ state: 'visible' });
          assert.equal(await page.locator('html').getAttribute('lang'), language);
          assert.equal(await page.locator('html').getAttribute('dir'), language === 'en' ? 'ltr' : 'rtl');
          assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
          await page.locator('#login-username').fill('matrix-admin');
          await page.locator('#login-password').fill('Matrix-admin-pass-2026!');
          await page.locator('#login-form button[type="submit"]').click();
          await page.waitForFunction(() => document.querySelector('#app-shell')?.style.display === 'grid');
          await page.waitForFunction(() => !document.querySelector('#dashboard-section')?.hidden);
          assert.equal(await page.locator('html').getAttribute('lang'), language);
          assert.equal(await page.locator('html').getAttribute('data-theme'), theme);

          if (width < 500) await page.locator('.mobile-drawer-trigger').click();
          await page.locator('#database-tab').click();
          await page.waitForFunction(() => !document.querySelector('#database-section')?.hidden);
          const databaseVisible = await page.locator('#database-section').isVisible();
          assert.equal(databaseVisible, true);

          await page.goto(`${baseUrl}/client/${token}`);
          await page.locator('.card').first().waitFor();
          assert.equal(await page.locator('html').getAttribute('lang'), language);
          assert.equal(await page.locator('html').getAttribute('dir'), language === 'en' ? 'ltr' : 'rtl');
          assert.equal(await page.locator('body').getAttribute('data-theme'), theme);
          assert.equal(await page.locator('.card').count(), 1);
          const dimensions = await page.evaluate(() => ({
            viewport: document.documentElement.clientWidth,
            content: document.documentElement.scrollWidth
          }));
          assert.ok(dimensions.content <= dimensions.viewport + 1, JSON.stringify({ width, language, theme, dimensions }));
          assert.deepEqual(pageErrors, [], `${width}px/${language}/${theme}: ${pageErrors.join('; ')}`);
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
});
