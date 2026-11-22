import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const projectDirArgument = process.argv.find((argument) => argument.startsWith('--project-dir='));
const outputDirArgument = process.argv.find((argument) => argument.startsWith('--output-dir='));
const projectDir = resolve(projectDirArgument?.slice('--project-dir='.length) || fileURLToPath(new URL('..', import.meta.url)));
const screenshotsDir = resolve(outputDirArgument?.slice('--output-dir='.length) || join(projectDir, 'screenshots'));
const labelArgument = process.argv.find((argument) => argument.startsWith('--label='));
const label = (labelArgument?.slice('--label='.length) || 'baseline').replace(/[^a-zA-Z0-9_-]/g, '-');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputDir = join(screenshotsDir, `${timestamp}-${label}`);
const tempDir = join(tmpdir(), `fkretk-visual-check-${process.pid}-${Date.now()}`);
const dataDir = join(tempDir, 'data');
const backupDir = join(tempDir, 'backups');
const demoAdmin = { username: 'visual-admin', password: 'Visual-check-pass-2026!' };
const demoClient = { username: 'visual-client', email: 'visual@example.test', password: 'Visual-client-pass-2026!' };
const pageErrors = [];
const contrastViolations = [];
const accessibilityScan = process.env.FIKRATAK_AXE === '1';
let server;
let browser;
let serverOutput = '';

async function reservePort() {
  const probe = createServer();
  await new Promise((resolvePromise, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolvePromise);
  });
  const { port } = probe.address();
  await new Promise((resolvePromise, reject) => {
    probe.close((error) => error ? reject(error) : resolvePromise());
  });
  return port;
}

async function api(baseUrl, path, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${result.error || response.statusText}`);
  }
  return { result, response };
}

async function seedDemo(baseUrl) {
  const { response: setupResponse } = await api(baseUrl, '/api/setup', {
    method: 'POST',
    body: demoAdmin
  });
  const adminCookie = setupResponse.headers.get('set-cookie')?.split(';')[0];
  if (!adminCookie) throw new Error('Initial setup did not return an admin session cookie.');

  const profiles = [
    { Name: 'ريم العتيبي', Main_Username: 'reem_creator', 'Best Platform': 'Instagram', 'Username I': 'reem.inspires', 'Followers Count I': '128000', 'Username T': 'reem.shortform', 'Followers Count T': '64000', Country: 'Saudi Arabia', City: 'Riyadh', Area: 'Al Olaya', Gender: 'Female', 'Categories 1': 'Beauty', 'Categories 2': 'Lifestyle', Verified: 'Yes', Mawthouq: 'Yes' },
    { Name: 'سلمان الحربي', Main_Username: 'salman_creates', 'Best Platform': 'TikTok', 'Username T': 'salman.creates', 'Followers Count T': '512000', 'Username I': 'salman.frames', 'Followers Count I': '87000', Country: 'Saudi Arabia', City: 'Jeddah', Area: 'Al Rawdah', Gender: 'Male', 'Categories 1': 'Food', 'Categories 2': 'Travel', Verified: 'Yes' },
    { Name: 'نورة الشمري', Main_Username: 'noura_daily', 'Best Platform': 'Snapchat', Username: 'noura.daily', 'Followers Count S': '92000', 'Username I': 'noura.daily.life', 'Followers Count I': '48000', Country: 'Saudi Arabia', City: 'Riyadh', Area: 'Al Nakheel', Gender: 'Female', 'Categories 1': 'Lifestyle', 'Categories 2': 'Family' },
    { Name: 'فهد القحطاني', Main_Username: 'fahad_media', 'Best Platform': 'Instagram', 'Username I': 'fahad.media', 'Followers Count I': '1200000', 'Username T': 'fahad.motion', 'Followers Count T': '305000', Country: 'Saudi Arabia', City: 'Dammam', Area: 'Al Faisaliyah', Gender: 'Male', 'Categories 1': 'Technology', 'Categories 2': 'Gaming', Mawthouq: 'Yes' },
    { Name: 'جود المطيري', Main_Username: 'joud.studio', 'Best Platform': 'TikTok', 'Username T': 'joud.studio', 'Followers Count T': '24500', 'Username I': 'joud.studio.sa', 'Followers Count I': '18000', Country: 'Saudi Arabia', City: 'Jeddah', Area: 'Al Zahra', Gender: 'Female', 'Categories 1': 'Fashion', 'Categories 2': 'Beauty' }
  ];
  const ids = [];
  for (const profile of profiles) {
    const { result } = await api(baseUrl, '/api/influencers', {
      method: 'POST',
      cookie: adminCookie,
      body: profile
    });
    if (!result.record?.id) throw new Error(`Influencer creation returned no ID for ${profile.Name}.`);
    ids.push(result.record.id);
  }

  const today = new Date();
  const date = (offset) => {
    const value = new Date(today);
    value.setDate(value.getDate() + offset);
    return value.toISOString().slice(0, 10);
  };
  const { result: campaignResult } = await api(baseUrl, '/api/campaigns', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      campaignName: 'حملة الرفاهية اليومية',
      companyName: 'علامة تجريبية',
      campaignType: 'visit',
      serviceType: 'influencer',
      startDate: date(0),
      endDate: date(14),
      targets: ids.slice(0, 4).map((id, index) => ({
        id,
        visitDate: date(index + 1),
        visitTime: `${14 + index}:00`,
        visitCity: profiles[index].City,
        visitBranch: 'فرع تجريبي',
        visitAddress: 'عنوان تجريبي للمعاينة',
        visitStatus: 'pending_confirmation'
      }))
    }
  });
  const campaign = campaignResult.campaign;
  if (!campaign?.id) throw new Error('Campaign creation returned no campaign ID.');

  const { result: offerResult } = await api(baseUrl, '/api/client-catalogs', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      brandId: 'fkretk',
      clientName: 'عميل تجريبي',
      companyName: 'علامة تجريبية',
      offerName: 'قائمة المؤثرين المقترحة',
      influencerIds: ids
    }
  });
  if (!offerResult.catalog?.id || !offerResult.url) throw new Error('Client offer creation returned no preview URL.');

  const { result: clientResult } = await api(baseUrl, '/api/client-accounts', {
    method: 'POST',
    cookie: adminCookie,
    body: {
      username: demoClient.username,
      email: demoClient.email,
      clientName: 'عميل تجريبي',
      companyName: 'علامة تجريبية',
      password: demoClient.password,
      campaignIds: [campaign.id],
      portalConfig: {
        template: 'visit-schedule',
        status: 'published',
        sections: ['requestApproval', 'visitSchedule', 'campaignReport'],
        fields: {
          requestApproval: ['name', 'username', 'platform', 'followers', 'decision'],
          visitSchedule: ['name', 'username', 'visitDate', 'visitTime', 'visitCity', 'visitBranch', 'visitAddress', 'visitStatus'],
          deliveryCampaign: [],
          campaignReport: ['campaignSummary', 'targetCount', 'visitSummary']
        },
        actions: {
          allowDecisions: true,
          allowRevert: true,
          allowVisitConfirmation: true,
          allowVisitChangeRequest: true,
          allowShippingFollowUp: false
        }
      }
    }
  });
  const clientAccount = clientResult.account;
  if (!clientAccount?.id) throw new Error('Client account creation returned no account ID.');

  await api(baseUrl, `/api/client-accounts/${clientAccount.id}`, {
    method: 'PATCH',
    cookie: adminCookie,
    body: { catalogIds: [offerResult.catalog.id] }
  });

  const { result: presentationResult } = await api(baseUrl, `/api/campaigns/${campaign.id}/presentations`, {
    method: 'POST',
    cookie: adminCookie,
    body: {
      brandId: 'fkretk',
      clientAccountId: clientAccount.id,
      influencerIds: ids.slice(0, 4),
      fields: ['name', 'platform', 'username', 'visitDate', 'visitTime', 'visitCity', 'visitBranch', 'followers'],
      displayOptions: {
        showInfluencerDetails: true,
        showSocialAccounts: true,
        showFollowers: true,
        showAdditionalDetails: true,
        showCompanyWork: false
      }
    }
  });
  if (!presentationResult.url) throw new Error('Campaign presentation creation returned no URL.');

  return {
    admin: demoAdmin,
    client: demoClient,
    offerUrl: offerResult.url,
    campaignUrl: presentationResult.url
  };
}

async function waitForServer(child, baseUrl) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Screenshot server exited early.\n${serverOutput}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`Screenshot server did not become ready.\n${serverOutput}`);
}

function connectDiagnostics(page, description) {
  page.on('pageerror', (error) => pageErrors.push(`${description}: ${error.stack || error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`${description} console: ${message.text()}`);
  });
}

async function setTheme(context, theme, language) {
  await context.addInitScript(({ selectedTheme, selectedLanguage }) => {
    const keys = [
      'fikratak.theme',
      'fikratak.client.theme',
      'ryfaq-campaign-presentation-theme',
      'fikratak.showcase.theme'
    ];
    for (const key of keys) {
      try { localStorage.setItem(key, selectedTheme); } catch {}
    }
    for (const key of ['fikratak.language', 'fikratak.client.language', 'fikratak.showcase.language']) {
      try { localStorage.setItem(key, selectedLanguage); } catch {}
    }
  }, { selectedTheme: theme, selectedLanguage: language });
}

async function capture(page, name, width, theme, language) {
  await page.evaluate(({ selectedTheme, selectedLanguage }) => {
    document.documentElement.dataset.theme = selectedTheme;
    document.documentElement.lang = selectedLanguage;
    document.documentElement.dir = selectedLanguage === 'ar' ? 'rtl' : 'ltr';
    if (document.body) document.body.dataset.theme = selectedTheme;
  }, { selectedTheme: theme, selectedLanguage: language });
  await page.evaluate(() => document.fonts?.ready);
  if (accessibilityScan) {
    const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
    for (const violation of results.violations) {
      for (const node of violation.nodes) {
        const ratio = node.any.map((check) => check.data?.contrastRatio).find(Boolean)
          || node.failureSummary?.match(/contrast ratio of ([\d.]+)/i)?.[1]
          || 'unknown';
        contrastViolations.push({
          page: `${name} (${width}px, ${language}, ${theme})`,
          selector: node.target.join(' '),
          ratio,
          summary: node.failureSummary || violation.help
        });
      }
    }
  }
  await page.evaluate(async () => {
    const scrollStep = Math.max(300, window.innerHeight * 0.75);
    for (let top = 0; top < document.documentElement.scrollHeight; top += scrollStep) {
      window.scrollTo(0, top);
      await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
    }
    window.scrollTo(0, 0);
    await new Promise((resolvePromise) => requestAnimationFrame(resolvePromise));
  });
  await page.waitForTimeout(300);
  const fileName = `${name}-${width}-${language}-${theme}.png`;
  await page.screenshot({
    path: join(outputDir, fileName),
    fullPage: true,
    animations: 'disabled'
  });
  return fileName;
}

async function loginAdmin(page, credentials) {
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-username').fill(credentials.username);
  await page.locator('#login-password').fill(credentials.password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#app-shell').waitFor({ state: 'visible', timeout: 15000 });
}

async function captureAdminSection(page, screenshots, tabId, sectionId, name, width, theme, language) {
  const tab = page.locator(`#${tabId}`);
  if (!(await tab.count())) return;
  if (width <= 850 && !(await tab.isVisible())) await page.locator('.mobile-drawer-trigger').click();
  if (!(await tab.isVisible())) return;
  await tab.click();
  await page.locator(`#${sectionId}`).waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(300);
  if (width <= 850) {
    await page.locator('#mobile-sidebar-toggle').evaluate((input) => {
      input.checked = false;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  screenshots.push({
    file: await capture(page, name, width, theme, language),
    title: `${name} · ${width}px · ${language} · ${theme}`
  });
}

async function verifyDatabasePolish(page, width) {
  const selectRow = page.locator('.database-row-select').first();
  if (!(await selectRow.count())) return;
  const layout = await page.locator('#table-wrap').evaluate((table) => {
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => row.getBoundingClientRect());
    const styles = getComputedStyle(table);
    return {
      rowHeight: rows[0]?.height || 0,
      maxHeight: styles.maxHeight,
      tableWidth: table.querySelector('table').getBoundingClientRect().width,
      wrapWidth: table.getBoundingClientRect().width,
      wrapBottom: table.getBoundingClientRect().bottom,
      lastRowBottom: rows.at(-1)?.bottom || 0,
      rowsDoNotOverlap: rows.every((row, index) => index === 0 || row.top >= rows[index - 1].bottom),
      accountsFit: [...table.querySelectorAll('.database-accounts .database-account')].every((account) => {
        const accountRect = account.getBoundingClientRect();
        const rowRect = account.closest('tr').getBoundingClientRect();
        const accounts = account.parentElement;
        return accountRect.left >= rowRect.left - 1 && accountRect.right <= rowRect.right + 1
          && account.scrollWidth <= account.clientWidth + 1
          && accounts.scrollWidth <= accounts.clientWidth + 1;
      })
    };
  });
  if (width <= 560) {
    if (layout.maxHeight !== 'none' || layout.tableWidth > layout.wrapWidth + 1
      || layout.lastRowBottom > layout.wrapBottom + 1 || !layout.rowsDoNotOverlap || !layout.accountsFit) {
      throw new Error(`Mobile influencer table overflows or overlaps: ${JSON.stringify(layout)}`);
    }
  } else if (layout.rowHeight > 60) {
    throw new Error(`Influencer table row is ${Math.round(layout.rowHeight)}px tall; expected a compact 56px row.`);
  }
  await selectRow.check();
  await page.locator('#database-bulk-actions:not([hidden])').waitFor({ state: 'visible' });
  await page.locator('.database-column-panel > summary').click();
  const accountsColumn = page.locator('[data-database-column="accounts"]').first();
  const accountsToggle = page.locator('[data-database-column-toggle="accounts"]');
  await accountsToggle.uncheck();
  await accountsColumn.waitFor({ state: 'hidden' });
  await accountsToggle.check();
  await page.waitForTimeout(100);
  const columnState = await accountsColumn.evaluate((column) => ({
    hidden: column.hidden,
    checked: document.querySelector('[data-database-column-toggle="accounts"]').checked,
    preference: localStorage.getItem('fikratak.database.columns')
  }));
  if (columnState.hidden) throw new Error(`Column visibility failed to restore: ${JSON.stringify(columnState)}`);
  await page.locator('#search-input').fill('ريم');
  await page.locator('#database-active-filters button').first().waitFor({ state: 'visible' });
  await page.locator('#search-input').fill('');
  await page.locator('#database-clear-selection').click();
  await page.locator('#database-bulk-actions[hidden]').waitFor({ state: 'attached' });
}

async function loginShowcase(page, credentials) {
  await page.goto(`${baseUrl}/showcase`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-form input[type="email"]').fill(credentials.email);
  await page.locator('#login-form input[type="password"]').fill(credentials.password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#client-view').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#creator-grid .creator-card').first().waitFor({ state: 'visible', timeout: 15000 });
}

async function loginPortal(page, credentials) {
  await page.goto(`${baseUrl}/portal`, { waitUntil: 'domcontentloaded' });
  await page.locator('#login-form input[name="email"]').fill(credentials.email);
  await page.locator('#login-form input[name="password"]').fill(credentials.password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#portal-panel').waitFor({ state: 'visible', timeout: 15000 });
}

async function verifyMobileFilterSheet(page, panelId, theme) {
  const trigger = page.locator(`[data-mobile-filter-open="${panelId}"]`);
  const panel = page.locator(`#${panelId}`);
  await trigger.click();
  await page.locator(`#${panelId}.mobile-filter-sheet-open`).waitFor({ state: 'visible' });
  let fileName = '';
  if (theme === 'light') {
    fileName = `${panelId}-sheet-390.png`;
    await page.screenshot({ path: join(outputDir, fileName), animations: 'disabled' });
  }
  await page.locator(`[data-mobile-filter-close="${panelId}"]`).click();
  await panel.waitFor({ state: 'hidden' });
  return fileName;
}

async function verifyClientPrintDisabled(page, description) {
  const printControlCount = await page.locator('#pdf-button, #print-catalog, #print-offers, #print-presentation').count();
  if (printControlCount) throw new Error(`${description} still exposes a print/PDF control.`);

  await page.emulateMedia({ media: 'print' });
  const printState = await page.evaluate(() => ({
    message: getComputedStyle(document.body, '::after').content,
    messageDisplay: getComputedStyle(document.body, '::after').display,
    visibleElements: [...document.body.querySelectorAll('*')]
      .filter((element) => getComputedStyle(element).display !== 'none')
      .map((element) => element.id || element.tagName.toLowerCase())
  }));
  await page.emulateMedia({ media: 'screen' });

  if (printState.message !== '"هذا العرض غير متاح للطباعة"' || printState.messageDisplay !== 'block'
    || printState.visibleElements.length) {
    throw new Error(`${description} does not suppress browser printing: ${JSON.stringify(printState)}`);
  }
}

async function writeContactSheet(files) {
  const cards = files.map(({ file, title }) => `
    <figure><figcaption>${title}</figcaption><a href="${file}"><img src="${file}" alt="${title}" loading="lazy"></a></figure>`).join('');
  const document = `<!doctype html>
<html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>FKRETK visual screenshots · ${label}</title>
<style>
  *{box-sizing:border-box}body{margin:0;padding:24px;font:16px/1.6 "Segoe UI",sans-serif;background:#f3f6f9;color:#14232d}
  h1{margin:0 0 8px}p{margin:0 0 24px;color:#516473}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,520px),1fr));gap:20px}
  figure{margin:0;padding:12px;border:1px solid #dce3e8;border-radius:12px;background:white;box-shadow:0 5px 18px #14232d12}
  figcaption{margin-bottom:8px;font-weight:700}img{display:block;width:100%;height:auto;border:1px solid #dce3e8;border-radius:8px}
</style><h1>لقطات FKRETK — ${label}</h1><p>للمقارنة البصرية: افتح الصورتين للصفحة نفسها بأبعاد 1440 و390 وبالوضعين الفاتح والداكن.</p>
<main class="grid">${cards}</main></html>`;
  await writeFile(join(outputDir, 'index.html'), document, 'utf8');
}

let baseUrl = '';
try {
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  await mkdir(outputDir, { recursive: true });
  server = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(port),
      FIKRATAK_HOST: '127.0.0.1',
      FIKRATAK_DATA_DIR: dataDir,
      FIKRATAK_BACKUP_DIR: backupDir,
      NODE_ENV: 'development'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  await waitForServer(server, baseUrl);
  const routes = await seedDemo(baseUrl);
  browser = await chromium.launch({ headless: true });

  const screenshots = [];
  for (const width of [1440, 390]) {
    for (const language of ['ar', 'en']) {
      for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 1000 },
        deviceScaleFactor: 1,
        isMobile: width === 390,
        hasTouch: width === 390
      });
      await setTheme(context, theme, language);

      const adminPage = await context.newPage();
      connectDiagnostics(adminPage, `admin ${width} ${theme}`);
      await adminPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
      await adminPage.locator('#login-form').waitFor({ state: 'visible' });
      screenshots.push({
        file: await capture(adminPage, 'admin-login', width, theme, language),
        title: `تسجيل الدخول · ${width}px · ${language} · ${theme}`
      });
      await loginAdmin(adminPage, routes.admin);
      screenshots.push({
        file: await capture(adminPage, 'admin-dashboard', width, theme, language),
        title: `لوحة الإدارة · ${width}px · ${language} · ${theme}`
      });
      for (const [tabId, sectionId, name] of [
        ['lookup-tab', 'lookup-section', 'influencer-lookup'],
        ['database-tab', 'database-section', 'influencer-database'],
        ['influencer-photos-tab', 'influencer-photos-section', 'influencer-photos'],
        ['campaigns-tab', 'campaigns-section', 'campaign-management'],
        ['coverage-tab', 'coverage-section', 'coverage'],
        ['company-work-videos-tab', 'company-work-videos-section', 'company-work-videos'],
        ['client-prep-tab', 'client-prep-section', 'client-presentations'],
        ['audit-tab', 'audit-section', 'audit-report'],
        ['account-conflicts-tab', 'account-conflicts-section', 'account-conflicts-report'],
        ['about-tab', 'about-section', 'about']
      ]) {
        await captureAdminSection(adminPage, screenshots, tabId, sectionId, name, width, theme, language);
        if (tabId === 'database-tab' && width <= 850) await verifyDatabasePolish(adminPage, width);
      }
      if (width <= 850) await adminPage.locator('.mobile-drawer-trigger').click();
      await adminPage.locator('#users-button').click();
      await adminPage.locator('#users-dialog[open]').waitFor({ state: 'visible', timeout: 10000 });
      await adminPage.waitForTimeout(300);
      screenshots.push({
        file: await capture(adminPage, 'system-users-settings', width, theme, language),
        title: `إعدادات النظام والمستخدمون · ${width}px · ${language} · ${theme}`
      });
      await adminPage.locator('#close-users-dialog').click();
      if (width <= 850) {
        await adminPage.locator('#mobile-sidebar-toggle').evaluate((input) => { input.checked = false; });
        await adminPage.locator('.mobile-drawer-trigger').click();
      }
      await adminPage.locator('#dashboard-tab').click();
      if (width <= 850) {
        await adminPage.locator('#mobile-sidebar-toggle').evaluate((input) => { input.checked = false; });
      }
      await adminPage.locator('#backup-panel').waitFor({ state: 'visible', timeout: 10000 });
      screenshots.push({
        file: await capture(adminPage, 'system-backup-settings', width, theme, language),
        title: `النسخ الاحتياطي وإعدادات النظام · ${width}px · ${language} · ${theme}`
      });
      const clientsPage = await context.newPage();
      connectDiagnostics(clientsPage, `client account management ${width} ${theme}`);
      await clientsPage.goto(`${baseUrl}/client-accounts.html`, { waitUntil: 'domcontentloaded' });
      await clientsPage.locator('#accounts').waitFor({ state: 'visible', timeout: 15000 });
      screenshots.push({
        file: await capture(clientsPage, 'client-account-management', width, theme, language),
        title: `إدارة العملاء · ${width}px · ${language} · ${theme}`
      });
      await clientsPage.close();

      await context.clearCookies();
      const clientPage = await context.newPage();
      connectDiagnostics(clientPage, `client offer ${width} ${theme}`);
      await clientPage.goto(new URL(routes.offerUrl, baseUrl).href, { waitUntil: 'domcontentloaded' });
      await clientPage.locator('.card').first().waitFor({ state: 'visible', timeout: 15000 });
      await verifyClientPrintDisabled(clientPage, 'Client offer');
      if (width === 390) {
        const file = await verifyMobileFilterSheet(clientPage, 'client-filter-toolbar', theme);
        if (file) screenshots.push({ file, title: `فلاتر العرض · 390px` });
      }
      screenshots.push({
        file: await capture(clientPage, 'client-offer', width, theme, language),
        title: `عرض المؤثرين للعميل · ${width}px · ${language} · ${theme}`
      });

      const showcasePage = await context.newPage();
      connectDiagnostics(showcasePage, `client showcase ${width} ${theme}`);
      await loginShowcase(showcasePage, routes.client);
      await verifyClientPrintDisabled(showcasePage, 'Client showcase');
      if (width === 390) {
        const file = await verifyMobileFilterSheet(showcasePage, 'showcase-filters', theme);
        if (file) screenshots.push({ file, title: `فلاتر المعرض · 390px` });
      }
      screenshots.push({
        file: await capture(showcasePage, 'client-showcase', width, theme, language),
        title: `معرض العميل · ${width}px · ${language} · ${theme}`
      });

      await context.clearCookies();
      const portalPage = await context.newPage();
      connectDiagnostics(portalPage, `client portal ${width} ${theme}`);
      await loginPortal(portalPage, routes.client);
      await verifyClientPrintDisabled(portalPage, 'Client portal');
      if (width === 390) {
        const file = await verifyMobileFilterSheet(portalPage, 'offer-filters', theme);
        if (file) screenshots.push({ file, title: `فلاتر البوابة · 390px` });
      }
      screenshots.push({
        file: await capture(portalPage, 'client-portal', width, theme, language),
        title: `بوابة العميل · ${width}px · ${language} · ${theme}`
      });

      const presentationPage = await context.newPage();
      connectDiagnostics(presentationPage, `campaign presentation ${width} ${theme}`);
      await presentationPage.goto(new URL(routes.campaignUrl, baseUrl).href, { waitUntil: 'domcontentloaded' });
      await presentationPage.locator('#app .intro').waitFor({ state: 'visible', timeout: 15000 });
      await verifyClientPrintDisabled(presentationPage, 'Campaign presentation');
      if (width === 390) {
        const file = await verifyMobileFilterSheet(presentationPage, 'presentation-filters', theme);
        if (file) screenshots.push({ file, title: `فلاتر العرض التقديمي · 390px` });
      }
      screenshots.push({
        file: await capture(presentationPage, 'campaign-presentation', width, theme, language),
        title: `عرض الحملة · ${width}px · ${language} · ${theme}`
      });
      await context.close();
      }
    }
  }

  await writeContactSheet(screenshots);
  console.log(`Captured ${screenshots.length} screenshots in ${outputDir}`);
  console.log(`Open ${join(outputDir, 'index.html')} to review and compare the pages.`);
  if (pageErrors.length) {
    console.error(`Browser reported ${pageErrors.length} error(s):\n${pageErrors.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('No browser console errors or uncaught page errors were detected.');
  }
  if (accessibilityScan) {
    console.log(`Color contrast: ${contrastViolations.length} violation(s).`);
    for (const violation of contrastViolations) {
      console.log(`${violation.page} | ${violation.selector} | ${violation.ratio}: ${violation.summary}`);
    }
    if (contrastViolations.length) process.exitCode = 1;
  }
} catch (error) {
  console.error(error);
  if (pageErrors.length) console.error(`Browser reported ${pageErrors.length} error(s):\n${pageErrors.join('\n')}`);
  if (serverOutput) console.error(`Screenshot server output:\n${serverOutput}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    server.kill();
    await Promise.race([
      once(server, 'exit'),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5000))
    ]);
  }
  await rm(tempDir, { recursive: true, force: true });
}
