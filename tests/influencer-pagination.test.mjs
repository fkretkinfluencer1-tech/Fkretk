import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { validateXlsxWorkbook } from '../data-access/xlsx-workbook.mjs';
import { assertSafeDbPath } from './db-guard.mjs';

const projectDir = new URL('..', import.meta.url);
const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-pagination-test-'));
const dataDir = join(tempDir, 'data');
const backupDir = join(tempDir, 'backups');
const databasePath = join(dataDir, 'fikratak.sqlite');
assertSafeDbPath(databasePath, 'test database');
await mkdir(dataDir, { recursive: true });

const fixture = new DatabaseSync(databasePath);
fixture.exec(`
  CREATE TABLE influencers (
    id TEXT PRIMARY KEY,
    record_json TEXT NOT NULL,
    phone_key TEXT UNIQUE
  )
`);
const insertFixture = fixture.prepare('INSERT INTO influencers (id, record_json) VALUES (?, ?)');
for (let index = 1; index <= 125; index += 1) {
  const suffix = String(index).padStart(3, '0');
  const record = {
    Name: `Test Creator ${suffix}`,
    Main_Username: `test_creator_${suffix}`,
    'Username I': `test_creator_${suffix}`,
    'Best Platform': 'Instagram',
    'Followers Count I': String(index * 1000),
    Number: '555123456',
    Price: '1000',
    Note: 'internal fixture note',
    'Internal Notes': 'private fixture note',
    Country: index % 2 ? 'Saudi Arabia' : 'UAE',
    Area: index % 2 ? 'Riyadh Region' : 'Dubai',
    City: index % 2 ? 'Riyadh' : 'Dubai',
    Classification: index % 2 ? 'Food' : 'Travel',
    Gender: index % 2 ? 'Female' : 'Male',
    Verified: index % 5 ? 'No' : 'Yes',
    Mawthouq: index % 3 ? 'No' : 'Yes',
    'Paid or Voucher': index % 2 ? 'Paid' : 'Voucher',
    'Categories 1': index % 2 ? 'Food' : 'Travel',
    'Influencer Status': 'Active',
    'Workflow Status': 'new'
  };
  insertFixture.run(suffix.padStart(32, '0'), JSON.stringify(record));
}
fixture.close();

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
    FIKRATAK_BACKUP_DIR: backupDir
  },
  stdio: ['ignore', 'ignore', 'pipe']
});
let serverErrors = '';
server.stderr.on('data', (chunk) => { serverErrors += chunk.toString(); });

after(async () => {
  if (server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
  await rm(tempDir, { recursive: true, force: true });
});

const baseUrl = `http://127.0.0.1:${port}`;
let ready = false;
for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
  if (server.exitCode !== null) throw new Error(`Test server stopped during startup: ${serverErrors}`);
  try {
    ready = (await fetch(baseUrl)).status === 200;
  } catch {}
  if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!ready) throw new Error(`Test server did not start: ${serverErrors}`);

const initialExcelPath = join(backupDir, 'Fikratak_Influencers.xlsx');
let excelCreated = false;
for (let attempt = 0; attempt < 200 && !excelCreated; attempt += 1) {
  if (server.exitCode !== null) throw new Error(`Test server stopped during scheduled backup: ${serverErrors}`);
  try { excelCreated = (await stat(initialExcelPath)).isFile(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!excelCreated) await new Promise((resolve) => setTimeout(resolve, 50));
}
assert.ok(excelCreated, `Scheduled Excel backup did not run without a browser: ${serverErrors}`);
assert.equal(validateXlsxWorkbook(await readFile(initialExcelPath), 125), true);

const designStyles = await fetch(`${baseUrl}/assets/fikratak-design.css`);
assert.equal(designStyles.status, 200);
assert.match(await designStyles.text(), /--fk-blue-500:\s*#2D82C4/);
const sharedTierRules = await fetch(`${baseUrl}/assets/follower-tiers.js`);
assert.equal(sharedTierRules.status, 200);
assert.match(await sharedTierRules.text(), /100000/);

const setupResponse = await fetch(`${baseUrl}/api/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'pagination-test', password: 'Test-only-password-2026!' })
});
assert.equal(setupResponse.status, 201);
const sessionCookie = setupResponse.headers.get('set-cookie')?.split(';')[0];
assert.ok(sessionCookie);
const exportConfirmation = {
  confirmationUsername: 'pagination-test',
  confirmationPassword: 'Test-only-password-2026!'
};

async function api(path, options = {}) {
  let requestOptions = options;
  if (path === '/api/import' && String(options.method || 'GET').toUpperCase() === 'POST'
    && options.body && typeof options.body === 'object' && !options.body.previewId) {
    const previewResponse = await fetch(`${baseUrl}/api/import/preview`, {
      method: 'POST',
      body: JSON.stringify(options.body),
      headers: {
        cookie: options.cookie || sessionCookie,
        'content-type': 'application/json',
        ...options.headers
      }
    });
    const previewBody = await previewResponse.json();
    if (!previewResponse.ok) throw new Error(`/api/import/preview returned ${previewResponse.status}: ${JSON.stringify(previewBody)} ${serverErrors}`);
    requestOptions = {
      ...options,
      body: {
        ...options.body, previewId: previewBody.preview.previewId,
        acknowledgeUnknownColumns: true, confirmAllNew: true
      }
    };
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...requestOptions,
    body: requestOptions.body && typeof requestOptions.body !== 'string' ? JSON.stringify(requestOptions.body) : requestOptions.body,
    headers: {
      cookie: options.cookie || sessionCookie,
      ...(requestOptions.body ? { 'content-type': 'application/json' } : {}),
      ...requestOptions.headers
    }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(result)} ${serverErrors}`);
  return result;
}

async function login(username, password) {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie')?.split(';')[0];
}

const editorPassword = 'Editor-test-password-2026!';
const viewerPassword = 'Viewer-test-password-2026!';
const editorExportConfirmation = {
  confirmationUsername: 'pagination-editor',
  confirmationPassword: editorPassword
};
await api('/api/users', {
  method: 'POST',
  body: { username: 'pagination-editor', password: editorPassword, role: 'editor' }
});
await api('/api/users', {
  method: 'POST',
  body: { username: 'pagination-viewer', password: viewerPassword, role: 'viewer' }
});
const editorCookie = await login('pagination-editor', editorPassword);
const viewerCookie = await login('pagination-viewer', viewerPassword);

test('manual follower updates are authenticated, platform-specific, and retain growth history', { concurrency: false }, async () => {
  const influencerId = '00000000000000000000000000000001';
  const historyPath = `/api/influencers/${influencerId}/follower-history?platform=Instagram`;
  const updatePath = `/api/influencers/${influencerId}/follower-updates`;
  const unauthenticated = await fetch(`${baseUrl}${historyPath}`);
  assert.equal(unauthenticated.status, 401);
  const viewerUpdate = await fetch(`${baseUrl}${updatePath}`, {
    method: 'POST',
    headers: { cookie: viewerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'Instagram', followersCount: 1200 })
  });
  assert.equal(viewerUpdate.status, 403);
  const invalidCount = await fetch(`${baseUrl}${updatePath}`, {
    method: 'POST',
    headers: { cookie: editorCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'Instagram', followersCount: '1.2K' })
  });
  assert.equal(invalidCount.status, 400);

  const firstUpdate = await api(updatePath, {
    method: 'POST', cookie: editorCookie,
    body: { platform: 'Instagram', followersCount: '١٬٢٠٠' }
  });
  assert.equal(firstUpdate.previousCount, 1000);
  assert.equal(firstUpdate.delta, 200);
  assert.equal(firstUpdate.record['Followers Count I'], '1200');
  assert.equal(firstUpdate.record['Influencer Type I'], 'Nano');
  assert.equal(firstUpdate.history.length, 1);
  assert.equal(firstUpdate.history[0].actorUsername, 'pagination-editor');

  const secondUpdate = await api(updatePath, {
    method: 'POST', cookie: editorCookie,
    body: { platform: 'Instagram', followersCount: 1500 }
  });
  assert.equal(secondUpdate.previousCount, 1200);
  assert.equal(secondUpdate.delta, 300);
  assert.equal(secondUpdate.history.length, 2);

  const instagramHistory = await api(historyPath, { cookie: editorCookie });
  assert.equal(instagramHistory.currentCount, 1500);
  assert.deepEqual(instagramHistory.history.map((entry) => entry.followersCount), [1500, 1200]);
  const tiktokHistory = await api(`/api/influencers/${influencerId}/follower-history?platform=TikTok`, { cookie: editorCookie });
  assert.equal(tiktokHistory.currentCount, null);
  assert.deepEqual(tiktokHistory.history, []);
  assert.equal((await api(`/api/influencers?q=test_creator_001`)).rows[0]['Followers Count T'], undefined);
  const stored = await api(`/api/influencers?q=test_creator_001`);
  assert.equal(stored.rows[0]['Followers Count I'], '1500');
});

test('server-side pagination searches, filters, and selects the complete growing database', { concurrency: false }, async () => {
  const meta = await api('/api/influencers/meta');
  assert.equal(meta.stats.total, 125);
  assert.equal(meta.stats.mawthouq, 41);
  assert.deepEqual(meta.stats.tiers.map((item) => item.label), ['Nano', 'Micro', 'Macro']);
  assert.equal(meta.stats.categories[0].count, 63);
  assert.equal(meta.stats.genders.length, 2);
  assert.equal(meta.stats.female, 63);
  assert.equal(meta.stats.male, 62);
  assert.equal(meta.stats.instagram, 125);
  assert.equal(meta.stats.tiktok, 0);
  assert.equal(meta.stats.snapchatAccounts, 0);
  assert.equal(meta.stats.cities, 2);
  assert.equal(meta.stats.paymentModes.reduce((sum, item) => sum + item.count, 0), 125);
  const statsSource = new DatabaseSync(databasePath, { readOnly: true });
  const sourceCounts = statsSource.prepare(`SELECT
    SUM(CASE WHEN Gender = 'Female' THEN 1 ELSE 0 END) AS female,
    SUM(CASE WHEN Gender = 'Male' THEN 1 ELSE 0 END) AS male,
    COUNT(DISTINCT NULLIF(lower(ltrim(trim("Username I"), '@')), '')) AS instagram,
    COUNT(DISTINCT NULLIF(lower(ltrim(trim("Username T"), '@')), '')) AS tiktok,
    COUNT(DISTINCT lower(ltrim(trim(COALESCE(NULLIF(Username, ''), NULLIF("Username S", ''), NULLIF(Snapchat_Username, ''), NULLIF(Snapchat, ''))), '@'))) AS snapchatAccounts
    FROM (SELECT json_extract(record_json, '$."Gender"') AS Gender,
      json_extract(record_json, '$."Username I"') AS "Username I",
      json_extract(record_json, '$."Username T"') AS "Username T",
      json_extract(record_json, '$."Username"') AS Username,
      json_extract(record_json, '$."Username S"') AS "Username S",
      json_extract(record_json, '$."Snapchat_Username"') AS Snapchat_Username,
      json_extract(record_json, '$."Snapchat"') AS Snapchat FROM influencers)`).get();
  assert.equal(meta.stats.female, sourceCounts.female);
  assert.equal(meta.stats.male, sourceCounts.male);
  assert.equal(meta.stats.instagram, sourceCounts.instagram);
  assert.equal(meta.stats.tiktok, sourceCounts.tiktok);
  assert.equal(meta.stats.snapchatAccounts, sourceCounts.snapchatAccounts);
  statsSource.close();

  const femaleMultiPlatform = await api('/api/influencers', {
    method: 'POST', body: { Name: 'Female multi-platform', Gender: 'Female', 'Username I': 'female_multi_ig', 'Username T': 'female_multi_tt' }
  });

  let liveStats = (await api('/api/influencers/meta')).stats;
  assert.equal(liveStats.total, 126);
  assert.equal(liveStats.female, 64);
  assert.equal(liveStats.male, 62);
  assert.equal(liveStats.instagram, 126);
  assert.equal(liveStats.tiktok, 1);
  assert.equal(liveStats.snapchatAccounts, 0);

  const femaleWithoutGender = await api(`/api/influencers/${femaleMultiPlatform.record.id}`, {
    method: 'PUT', body: { ...femaleMultiPlatform.record, Gender: '' }
  });
  assert.equal((await api('/api/influencers/meta')).stats.female, 63);
  const femaleWithSnapchat = await api(`/api/influencers/${femaleMultiPlatform.record.id}`, {
    method: 'PUT', body: { ...femaleWithoutGender.record, Gender: 'Female', Username: '@shared_snapchat', 'Followers Count S': '' }
  });
  assert.equal((await api('/api/influencers/meta')).stats.female, 64);
  assert.equal((await api('/api/influencers/meta')).stats.snapchatAccounts, 1);
  const unknownGender = await api('/api/influencers', {
    method: 'POST', body: { Name: 'Unspecified gender', Gender: '', 'Username I': 'unspecified_ig', 'Username T': 'unspecified_tiktok', Username: 'unspecified_snapchat' }
  });
  const duplicateInstagram = await fetch(`${baseUrl}/api/influencers`, {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ Name: 'Duplicate account attempt', 'Username I': 'female_multi_ig' })
  });
  assert.equal(duplicateInstagram.status, 409);
  const duplicateInstagramBody = await duplicateInstagram.json();
  assert.equal(duplicateInstagramBody.conflict.platform, 'Instagram');
  assert.deepEqual(duplicateInstagramBody.conflict.influencerIds, [femaleMultiPlatform.record.id]);
  const accountTransfer = await fetch(`${baseUrl}/api/influencers/${unknownGender.record.id}`, {
    method: 'PUT',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ...unknownGender.record, 'Username I': 'female_multi_ig' })
  });
  assert.equal(accountTransfer.status, 409);
  const unchangedOwner = (await api('/api/influencers?q=unspecified_ig')).rows[0];
  assert.equal(unchangedOwner.id, unknownGender.record.id);
  assert.equal(unchangedOwner['Username I'], 'unspecified_ig');
  liveStats = (await api('/api/influencers/meta')).stats;
  assert.equal(liveStats.total, 127);
  assert.equal(liveStats.female, 64);
  assert.equal(liveStats.male, 62);
  assert.equal(liveStats.tiktok, 2);
  assert.equal(liveStats.instagram, 127);
  assert.equal(liveStats.snapchatAccounts, 2);

  const maleWithSnapchat = await api('/api/influencers', {
    method: 'POST', body: { Name: 'Male Snapchat creator', Gender: 'ذكر', TikTok_Username: 'male_tiktok', 'Username S': 'male_snapchat_no_followers' }
  });
  liveStats = (await api('/api/influencers/meta')).stats;
  assert.equal(liveStats.female, 64);
  assert.equal(liveStats.male, 63);
  assert.equal(liveStats.tiktok, 3);
  assert.equal(liveStats.snapchatAccounts, 3);

  const renamedUnknown = await api(`/api/influencers/${unknownGender.record.id}`, {
    method: 'PUT', body: { ...unknownGender.record, Username: 'distinct_snapchat' }
  });
  assert.equal((await api('/api/influencers/meta')).stats.snapchatAccounts, 3);
  const removedMaleSnapchat = await api(`/api/influencers/${maleWithSnapchat.record.id}`, {
    method: 'PUT', body: { ...maleWithSnapchat.record, Username: '', 'Username S': '' }
  });
  assert.equal((await api('/api/influencers/meta')).stats.snapchatAccounts, 2);
  await api(`/api/influencers/${femaleWithSnapchat.record.id}`, {
    method: 'DELETE'
  });
  assert.equal((await api('/api/influencers/meta')).stats.snapchatAccounts, 1);
  await api(`/api/influencers/${renamedUnknown.record.id}`, {
    method: 'DELETE'
  });
  await api(`/api/influencers/${removedMaleSnapchat.record.id}`, {
    method: 'DELETE'
  });
  liveStats = (await api('/api/influencers/meta')).stats;
  assert.equal(liveStats.total, 125);
  assert.equal(liveStats.female, 63);
  assert.equal(liveStats.male, 62);
  assert.equal(liveStats.snapchatAccounts, 0);

  const filters = await api('/api/influencers/filter-options');
  assert.ok(filters.filters.values.Country.includes('Saudi Arabia'));
  assert.ok(filters.filters.values.Area.includes('Riyadh Region'));
  assert.ok(filters.filters.values.City.includes('Riyadh'));
  assert.ok(filters.filters.locations.some((location) => location.area === 'Riyadh Region' && location.city === 'Riyadh'));

  const firstPage = await api('/api/influencers?page=1&pageSize=50');
  assert.equal(firstPage.rows.length, 50);
  assert.equal(firstPage.total, 125);
  assert.equal(firstPage.pageCount, 3);
  const lastPage = await api('/api/influencers?page=999&pageSize=50');
  assert.equal(lastPage.page, 3);
  assert.equal(lastPage.rows.length, 25);

  const lastRecordSearch = await api('/api/influencers?q=test_creator_125&pageSize=50');
  assert.equal(lastRecordSearch.total, 1);
  assert.equal(lastRecordSearch.rows[0].Main_Username, 'test_creator_125');
  assert.equal((await api('/api/influencers?country=SA&pageSize=50')).total, 63);
  assert.equal((await api('/api/influencers?area=Riyadh%20Region&pageSize=100')).total, 63);
  assert.equal((await api('/api/influencers?city=Riyadh&pageSize=100')).total, 63);
  assert.equal((await api('/api/influencers?country=SA&area=Riyadh%20Region&city=Riyadh&pageSize=100')).total, 63);
  assert.equal((await api('/api/influencers?area=Dubai&city=Riyadh&pageSize=100')).total, 0);
  assert.equal((await api('/api/influencers?pageSize=100')).total, 125);
  assert.equal((await api('/api/influencers?tier=Macro&pageSize=50')).total, 26);
  assert.equal((await api('/api/influencers?scope=lookup&q=test_creator_125')).total, 1);
  assert.equal((await api('/api/influencers?scope=catalog&q=test_creator_125')).total, 1);
  assert.equal((await api('/api/influencers?scope=campaign&q=test_creator_125')).total, 1);
  assert.equal((await api('/api/influencers?gender=Female&pageSize=50')).total, 63);
  assert.equal((await api('/api/influencers/meta')).stats.total, 125, 'overall totals remain independent of filters and pagination');

  const ids = Array.from({ length: 125 }, (_, index) => String(index + 1).padStart(32, '0'));
  const catalog = await api('/api/client-catalogs', {
    method: 'POST',
    body: JSON.stringify({ brandId: 'fkretk', companyName: 'Test client', influencerIds: ids })
  });
  const publicOffer = await api(`/api/client-catalog/${catalog.url.split('/').at(-1)}`);
  const publicCreator = publicOffer.influencers[0];
  assert.equal(publicCreator.mainUsername, 'test_creator_001');
  assert.equal('instagramTier' in publicCreator, false);
  assert.equal('tiktokTier' in publicCreator, false);
  assert.equal('snapchatTier' in publicCreator, false);
  assert.equal(
    ['Influencer Type I', 'Influencer Type T', 'Influencer Type S'].some(key => key in publicCreator.details),
    false
  );
  assert.equal(publicCreator.bestPlatform, 'Instagram');
  assert.equal('Number' in publicCreator, false);
  assert.equal('Price' in publicCreator, false);
  assert.equal('Note' in publicCreator, false);
  assert.equal('Internal Notes' in publicCreator, false);
  const publicDecisionPath = `/api/client-catalog/${catalog.url.split('/').at(-1)}/decision`;
  for (const [decision, expected] of [['accepted', 'accepted'], ['rejected', 'rejected'], ['reverted', 'pending']]) {
    const response = await fetch(`${baseUrl}${publicDecisionPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ influencerId: ids[0], decision })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).decision, expected);
  }
  for (const [decision, expected] of [
    ['accepted', 'accepted'], ['reverted', 'pending'],
    ['rejected', 'rejected'], ['reverted', 'pending']
  ]) {
    const response = await fetch(`${baseUrl}${publicDecisionPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ influencerId: ids[0], decision })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).decision, expected);
  }
  const repeatedRevert = await fetch(`${baseUrl}${publicDecisionPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ influencerId: ids[0], decision: 'reverted' })
  });
  assert.equal(repeatedRevert.status, 409);
  const publicDecisionAudit = new DatabaseSync(databasePath, { readOnly: true });
  const publicDecisionHistory = publicDecisionAudit.prepare(`SELECT event_type AS eventType, previous_decision AS previousDecision
    FROM client_catalog_decision_history WHERE catalog_id = ? AND influencer_id = ? ORDER BY created_at, id`)
    .all(catalog.catalog.id, ids[0]);
  assert.equal(publicDecisionHistory.length, 7);
  assert.deepEqual(publicDecisionHistory.map((event) => event.eventType),
    ['accepted', 'rejected', 'reverted', 'accepted', 'reverted', 'rejected', 'reverted']);
  assert.deepEqual(publicDecisionHistory.map((event) => event.previousDecision),
    [null, 'accepted', 'rejected', null, 'accepted', null, 'rejected']);
  publicDecisionAudit.close();
  const campaign = await api('/api/campaigns', {
    method: 'POST',
    body: JSON.stringify({
      campaignName: 'Test campaign',
      companyName: 'Test client',
      campaignType: 'visit',
      serviceType: 'influencer',
      startDate: '2026-10-11',
      endDate: '2026-10-11',
      targets: ids.map((id) => ({ id, visitDate: '2026-10-11' }))
    })
  });
  const stored = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(stored.prepare('SELECT COUNT(*) AS count FROM client_catalog_items WHERE catalog_id = ?').get(catalog.catalog.id).count, 125);
  assert.equal(stored.prepare('SELECT COUNT(*) AS count FROM campaign_targets WHERE campaign_id = ?').get(campaign.campaign.id).count, 125);
  stored.close();

  const inserted = await api('/api/influencers', {
    method: 'POST',
    body: JSON.stringify({
      Name: 'New test creator',
      Main_Username: 'new_test_creator',
      'Username I': 'new_test_creator',
      'Followers Count T': '999',
      'Influencer Type T': 'Mega',
      'Followers Count I': '50K',
      'Followers Count S': '500K',
      Username: 'snap_test_creator',
      'Best Platform': 'Instagram',
      Country: 'Egypt'
    })
  });
  assert.equal(inserted.record.Main_Username, 'snap_test_creator');
  assert.equal(inserted.record['Best Platform'], 'Snapchat');
  assert.equal(inserted.record['Influencer Type T'], 'Nano');
  assert.equal(inserted.record['Influencer Type I'], 'Micro');
  assert.equal(inserted.record['Influencer Type S'], 'Semi Mega');
  const editedIdentity = await api(`/api/influencers/${inserted.record.id}`, {
    method: 'PUT',
    body: {
      ...inserted.record,
      'Best Platform': 'TikTok',
      'Username T': 'renamed_social_account'
    }
  });
  assert.equal(editedIdentity.record.Main_Username, 'snap_test_creator');
  assert.equal(editedIdentity.record['Best Platform'], 'Snapchat');
  assert.equal(editedIdentity.record['Username T'], 'renamed_social_account');

  const tiedAccounts = await api('/api/influencers', {
    method: 'POST',
    body: JSON.stringify({
      Name: 'Tie break creator',
      'Username T': 'tiktok_tie_creator',
      'Followers Count T': '1M',
      'Username I': 'instagram_tie_creator',
      'Followers Count I': '1000000',
      'Username': 'snapchat_tie_creator',
      'Followers Count S': '999K'
    })
  });
  assert.equal(tiedAccounts.record.Main_Username, 'tiktok_tie_creator');
  assert.equal(tiedAccounts.record['Best Platform'], 'TikTok');
  assert.equal(tiedAccounts.record['Influencer Type T'], 'Mega');
  assert.equal(tiedAccounts.record['Influencer Type I'], 'Mega');
  assert.equal(tiedAccounts.record['Influencer Type S'], 'Semi Mega');

  const microCreator = await api('/api/influencers', {
    method: 'POST',
    body: JSON.stringify({
      Name: 'Micro creator',
      'Username T': 'micro_creator',
      'Followers Count T': '10K',
      Main_Username: 'manual_unverified_name',
      'Best Platform': 'Snapchat'
    })
  });
  assert.equal(microCreator.record.Main_Username, 'micro_creator');
  assert.equal(microCreator.record['Best Platform'], 'TikTok');
  assert.equal(microCreator.record['Influencer Type T'], 'Micro');

  const mainAccountCreator = await api('/api/influencers', {
    method: 'POST',
    body: {
      Name: 'Main account regression creator',
      'Username I': 'main_instagram_fixture',
      'Followers Count I': '80000',
      'Username T': 'main_tiktok_fixture',
      'Followers Count T': '150000',
      Username: 'main_snapchat_fixture',
      'Followers Count S': '40000'
    }
  });
  assert.equal(mainAccountCreator.record['Best Platform'], 'TikTok');
  assert.equal(mainAccountCreator.record.Main_Username, 'main_tiktok_fixture');

  const mainAccountUpdated = await api(`/api/influencers/${mainAccountCreator.record.id}`, {
    method: 'PUT',
    body: { ...mainAccountCreator.record, 'Followers Count T': '30000', 'Followers Count I': '200000' }
  });
  assert.equal(mainAccountUpdated.record['Best Platform'], 'Instagram');
  assert.equal(mainAccountUpdated.record.Main_Username, 'main_instagram_fixture');

  const mainAccountFollowerUpdate = await api(`/api/influencers/${mainAccountCreator.record.id}/follower-updates`, {
    method: 'POST',
    body: { platform: 'Snapchat', followersCount: '500000' }
  });
  assert.equal(mainAccountFollowerUpdate.record['Best Platform'], 'Snapchat');
  assert.equal(mainAccountFollowerUpdate.record.Main_Username, 'main_snapchat_fixture');

  const deletedMainAccount = await api(`/api/influencers/${mainAccountCreator.record.id}`, {
    method: 'PUT',
    body: {
      ...mainAccountFollowerUpdate.record,
      'Username': '',
      'Followers Count S': ''
    }
  });
  assert.equal(deletedMainAccount.record['Best Platform'], 'Instagram');
  assert.equal(deletedMainAccount.record.Main_Username, 'main_instagram_fixture');

  const retainedMainAccount = await api(`/api/influencers/${mainAccountCreator.record.id}`, {
    method: 'PUT',
    body: {
      ...deletedMainAccount.record,
      'Followers Count I': '',
      'Followers Count T': '',
      Main_Username: 'unverified_manual_override',
      'Best Platform': 'Snapchat'
    }
  });
  assert.equal(retainedMainAccount.record['Best Platform'], 'Instagram');
  assert.equal(retainedMainAccount.record.Main_Username, 'main_instagram_fixture');

  const unrelatedMainAccount = await api('/api/influencers', {
    method: 'POST',
    body: {
      Name: 'Unrelated main account regression creator',
      'Username I': 'unrelated_instagram_fixture',
      'Followers Count I': '250000'
    }
  });
  assert.equal(unrelatedMainAccount.record['Best Platform'], 'Instagram');
  assert.equal(unrelatedMainAccount.record.Main_Username, 'unrelated_instagram_fixture');
  assert.notEqual(unrelatedMainAccount.record.id, mainAccountCreator.record.id);

  const tierSettings = await api('/api/settings/follower-tiers');
  assert.deepEqual(tierSettings.tiers, ['Nano', 'Micro', 'Macro', 'Semi Mega', 'Mega']);
  assert.deepEqual(tierSettings.thresholds, [10000, 100000, 500000, 1000000]);
  assert.equal(tierSettings.minimumFollowers, 0);
  assert.deepEqual((await api('/api/settings/follower-tiers', { cookie: editorCookie })).thresholds, tierSettings.thresholds);
  assert.deepEqual((await api('/api/settings/follower-tiers', { cookie: viewerCookie })).thresholds, tierSettings.thresholds);
  assert.equal((await fetch(`${baseUrl}/api/settings/follower-tiers`)).status, 401);

  const editorTierSettings = await fetch(`${baseUrl}/api/settings/follower-tiers`, {
    method: 'PUT',
    headers: { cookie: editorCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ thresholds: [500, 5000, 25000, 75000] })
  });
  assert.equal(editorTierSettings.status, 409);
  const viewerTierSettings = await fetch(`${baseUrl}/api/settings/follower-tiers`, {
    method: 'PUT',
    headers: { cookie: viewerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ thresholds: [500, 5000, 25000, 75000] })
  });
  assert.equal(viewerTierSettings.status, 403);

  const configuredTierSettings = await fetch(`${baseUrl}/api/settings/follower-tiers`, {
    method: 'PUT',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ thresholds: [500, 5000, 25000, 75000] })
  });
  assert.equal(configuredTierSettings.status, 409);
  assert.equal((await api('/api/influencers?q=micro_creator')).rows[0]['Influencer Type T'], 'Micro');
  assert.equal((await api('/api/influencers?tier=Micro&platform=TikTok&q=micro_creator')).total, 1);
  assert.equal((await api('/api/influencers?tier=Macro&platform=Instagram&q=micro_creator')).total, 0);
  assert.deepEqual((await api('/api/settings/follower-tiers')).thresholds, [10000, 100000, 500000, 1000000]);
  const thresholdAudit = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(thresholdAudit.prepare("SELECT value FROM app_settings WHERE key = 'follower_tier_thresholds'").get(), undefined);
  thresholdAudit.close();

  for (const thresholds of [
    [10000, 9000, 500000, 1000000],
    [-1, 50000, 500000, 1000000],
    [10000, 50000.5, 500000, 1000000],
    [10000, 50000, 500000, 1000000, 2000000],
    ['10000', 50000, 500000, 1000000]
  ]) {
    const invalidTierSettings = await fetch(`${baseUrl}/api/settings/follower-tiers`, {
      method: 'PUT',
      headers: { cookie: sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ thresholds })
    });
    assert.equal(invalidTierSettings.status, 409, JSON.stringify(thresholds));
  }
  assert.deepEqual((await api('/api/settings/follower-tiers')).thresholds, [10000, 100000, 500000, 1000000]);

  const resetTierSettings = await fetch(`${baseUrl}/api/settings/follower-tiers`, {
    method: 'PUT',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ thresholds: [10000, 50000, 500000, 1000000] })
  });
  assert.equal(resetTierSettings.status, 409);
  const updatedMicroRecord = await api(`/api/influencers?q=micro_creator`);
  assert.equal(updatedMicroRecord.rows[0]['Influencer Type T'], 'Micro');


  const importSeed = await api('/api/influencers', {
    method: 'POST',
    body: JSON.stringify({
      Name: 'Partial import creator',
      'Country Code': '+966',
      Number: '555444333',
      'Username I': 'partial_instagram',
      'Followers Count I': '50K',
      'Username T': 'partial_tiktok',
      'Followers Count T': '10K'
    })
  });
  assert.equal(importSeed.record.Main_Username, 'partial_instagram');
  assert.equal(importSeed.record['Best Platform'], 'Instagram');
  const partialImport = await api('/api/import', {
    method: 'POST',
    body: {
      updateExisting: true,
      rows: [{ id: importSeed.record.id, 'Username I': 'partial_instagram', 'Country Code': '+966', Number: '555444333', 'Followers Count T': '100K' }]
    }
  });
  assert.equal(partialImport.updated, 1);
  const importedRecord = new DatabaseSync(databasePath, { readOnly: true });
  const importedStored = JSON.parse(importedRecord.prepare('SELECT record_json FROM influencers WHERE id = ?')
    .get(importSeed.record.id).record_json);
  importedRecord.close();
  assert.equal(importedStored.Main_Username, 'partial_instagram');
  assert.equal(importedStored['Best Platform'], 'Instagram');
  assert.equal(importedStored['Influencer Type T'], 'Macro');

  const beforeFollowerImportCount = (await api('/api/influencers/meta')).stats.total;
  const followerImport = await api('/api/import', {
    method: 'POST',
    body: {
      followersOnly: true,
      updateExisting: true,
      rows: [
        { 'Influencer ID': importSeed.record.id, 'Username I': 'partial_instagram', 'Country Code': '+966', Number: '555444333', 'Followers Count I': '75,000', 'Update Date': '2026-11-05', Name: 'Must remain unchanged' },
        { 'Influencer ID': importSeed.record.id, 'Username T': 'partial_tiktok', 'Followers Count T': '120000', 'Update Date': '2026-11-05', Name: 'Ignored metadata' },
        { Number: '500000000', 'Country Code': '+966', 'Followers Count I': '1000', 'Update Date': '2026-11-05' },
        { 'Influencer ID': importSeed.record.id, 'Country Code': '+966', Number: '555444333', 'Followers Count S': '-1', 'Update Date': '2026-11-05' }
      ]
    }
  });
  const importedMainAccount = (await api(`/api/influencers?q=partial_instagram`)).rows[0];
  assert.equal(importedMainAccount['Best Platform'], 'TikTok');
  assert.equal(importedMainAccount.Main_Username, 'partial_tiktok');
  assert.equal(followerImport.followersOnly, true);
  assert.equal(followerImport.updatedAccounts, 2);
  assert.equal(followerImport.unmatched, 1);
  assert.equal(followerImport.invalid, 1);
  assert.equal(followerImport.ambiguous, 0);
  const afterFollowerImport = await api('/api/influencers?q=partial_instagram');
  assert.equal(afterFollowerImport.rows[0]['Followers Count I'], '75000');
  assert.equal(afterFollowerImport.rows[0].Name, 'Partial import creator');
  assert.equal(afterFollowerImport.rows[0]['Username I'], 'partial_instagram');
  assert.equal(afterFollowerImport.rows[0]['Followers Count T'], '120000');
  assert.equal((await api('/api/influencers/meta')).stats.total, beforeFollowerImportCount);
  const followerHistoryDb = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(followerHistoryDb.prepare("SELECT COUNT(*) AS count FROM influencer_follower_history WHERE source = 'import'").get().count, 3);
  followerHistoryDb.close();

  const duplicateAttempt = await fetch(`${baseUrl}/api/influencers`, {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ Name: 'Duplicate handle test', 'Username I': 'partial_instagram' })
  });
  assert.equal(duplicateAttempt.status, 409);
  assert.equal((await duplicateAttempt.json()).conflict.platform, 'Instagram');
  const accountGuardDb = new DatabaseSync(databasePath);
  accountGuardDb.function('account_username', { deterministic: true }, value =>
    String(value || '').normalize('NFKC').trim().replace(/^@+/, '').replace(/\s+/gu, '').toLocaleLowerCase('en-US'));
  accountGuardDb.function('country_iso', { deterministic: true }, value => String(value || '').trim());
  accountGuardDb.function('normalized_filter', { deterministic: true }, (field, value) =>
    String(value ?? '').trim().toLocaleLowerCase('en-US'));
  accountGuardDb.function('workflow_status', { deterministic: true }, value =>
    String(value || 'new').trim().toLocaleLowerCase('en-US'));
  assert.throws(
    () => accountGuardDb.prepare('INSERT INTO influencers (id, record_json) VALUES (?, ?)')
      .run('f'.repeat(32), JSON.stringify({ Name: 'Conflicting account fixture', 'Username I': 'partial_instagram' })),
    /social_account_conflict/
  );
  const guardedRecordId = '00000000000000000000000000000001';
  const updateTarget = JSON.parse(accountGuardDb.prepare('SELECT record_json FROM influencers WHERE id = ?')
    .get(guardedRecordId).record_json);
  updateTarget['Username I'] = 'partial_instagram';
  assert.throws(
    () => accountGuardDb.prepare('UPDATE influencers SET record_json = ? WHERE id = ?')
      .run(JSON.stringify(updateTarget), guardedRecordId),
    /social_account_conflict/
  );
  assert.equal(JSON.parse(accountGuardDb.prepare('SELECT record_json FROM influencers WHERE id = ?')
    .get(guardedRecordId).record_json)['Username I'], 'test_creator_001');
  accountGuardDb.close();

  const legacyDuplicateId = 'd'.repeat(32);
  const legacyDuplicateDb = new DatabaseSync(databasePath);
  legacyDuplicateDb.function('account_username', { deterministic: true }, value =>
    String(value || '').normalize('NFKC').trim().replace(/^@+/, '').replace(/\s+/gu, '').toLocaleLowerCase('en-US'));
  legacyDuplicateDb.function('country_iso', { deterministic: true }, value => String(value || '').trim());
  legacyDuplicateDb.function('normalized_filter', { deterministic: true }, (field, value) =>
    String(value ?? '').trim().toLocaleLowerCase('en-US'));
  legacyDuplicateDb.function('workflow_status', { deterministic: true }, value =>
    String(value || 'new').trim().toLocaleLowerCase('en-US'));
  legacyDuplicateDb.exec(`DROP TRIGGER influencers_account_owner_insert_guard;
    DROP TRIGGER influencers_accounts_after_insert;`);
  legacyDuplicateDb.prepare('INSERT INTO influencers (id, record_json) VALUES (?, ?)')
    .run(legacyDuplicateId, JSON.stringify({
      Name: 'Legacy duplicate account fixture',
      'Username I': 'partial_instagram',
      'Followers Count I': '75000'
    }));
  legacyDuplicateDb.exec(`CREATE TRIGGER influencers_accounts_after_insert
    AFTER INSERT ON influencers BEGIN
      INSERT INTO influencer_accounts (influencer_id, platform, normalized_username)
      SELECT NEW.id, platform, normalized_username FROM (
        SELECT 'Instagram' AS platform, account_username(json_extract(NEW.record_json, '$."Username I"')) AS normalized_username
        UNION ALL SELECT 'TikTok', account_username(json_extract(NEW.record_json, '$."Username T"'))
        UNION ALL SELECT 'Snapchat', account_username(json_extract(NEW.record_json, '$."Username"'))
      ) WHERE normalized_username <> '';
    END;`);
  legacyDuplicateDb.close();
  const ambiguousFollowerImport = await api('/api/import', {
    method: 'POST',
    body: {
      followersOnly: true,
      rows: [{
        'Influencer ID': importSeed.record.id,
        'Username I': 'PARTIAL_INSTAGRAM',
        'Followers Count I': '80000',
        'Update Date': '2026-11-05'
      }]
    }
  });
  assert.equal(ambiguousFollowerImport.updatedAccounts, 0);
  assert.equal(ambiguousFollowerImport.ambiguous, 1);

  assert.equal((await api('/api/influencers?q=new_test_creator')).total, 1);
  assert.equal((await api('/api/influencers?page=1&pageSize=50&sort=recent')).rows[0].id, legacyDuplicateId);
  const finalDb = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(finalDb.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, 135);
  assert.equal(finalDb.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  finalDb.close();
});

test('influencer saves normalize a country dial code and compute independent account and overall tiers', async () => {
  const created = await api('/api/influencers', {
    method: 'POST',
    body: {
      Name: 'Synthetic tier and phone creator',
      Country: 'Saudi Arabia',
      'Country Code': '00966',
      Number: '+966555000123',
      'Followers Count I': '0',
      'Followers Count T': '100000',
      'Followers Count S': ''
    }
  });
  assert.equal(created.record['Country Code'], '+966');
  assert.equal(created.record.Number, '555000123');
  assert.equal(created.record.Full_Mobile_Number, '+966555000123');
  assert.equal(created.record['Influencer Type I'], 'Nano');
  assert.equal(created.record['Influencer Type T'], 'Macro');
  assert.equal(created.record['Overall Influencer Type'], 'Macro');

  const updated = await api(`/api/influencers/${created.record.id}`, {
    method: 'PUT',
    body: { ...created.record, 'Followers Count S': '1000000' }
  });
  assert.equal(updated.record['Influencer Type T'], 'Macro');
  assert.equal(updated.record['Influencer Type S'], 'Mega');
  assert.equal(updated.record['Overall Influencer Type'], 'Mega');
});

test('exports are available to editors and admins with fresh confirmation; viewers can still browse', { concurrency: false }, async () => {
  for (const cookie of [sessionCookie, editorCookie]) {
    const confirmation = cookie === sessionCookie ? exportConfirmation : editorExportConfirmation;
    assert.equal((await api('/api/influencers?q=test_creator_125', { cookie })).total, 1);
    assert.equal((await api('/api/influencers/by-ids', {
      method: 'POST',
      body: { ids: ['00000000000000000000000000000001'] },
      cookie
    })).rows.length, 1);
    for (const path of [
      `/api/campaigns/${'a'.repeat(32)}/export`,
      `/api/client-catalogs/${'a'.repeat(32)}/export`
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(confirmation)
      });
      assert.equal(response.status, 404, `${path} export access`);
    }
  }

  for (const [cookie, confirmation] of [
    [sessionCookie, exportConfirmation], [editorCookie, editorExportConfirmation]
  ]) {
    for (const [path, search] of [
      ['/api/influencers/export?q=test_creator_125', true],
      ['/api/export', false]
    ]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(confirmation)
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      if (search) assert.equal(result.rows.length, 1);
      else {
        const currentDb = new DatabaseSync(databasePath, { readOnly: true });
        const expectedRows = Number(currentDb.prepare('SELECT COUNT(*) AS count FROM influencers WHERE archived_at IS NULL').get().count);
        currentDb.close();
        assert.equal(result.rows.length, expectedRows);
      }
    }
  }
  const missingConfirmation = await fetch(`${baseUrl}/api/export`, {
    method: 'POST', headers: { cookie: sessionCookie, 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(missingConfirmation.status, 403);

  const viewerPage = await api('/api/influencers?q=test_creator_125&page=1&pageSize=50', { cookie: viewerCookie });
  assert.equal(viewerPage.total, 1);
  assert.equal(viewerPage.rows.length, 1);
  const viewerBulkRoutes = [
    ['/api/influencers/export', 'POST'],
    ['/api/export', 'POST'],
    ['/api/influencers/by-ids', 'POST'],
    [`/api/campaigns/${'a'.repeat(32)}/export`, 'POST'],
    [`/api/client-catalogs/${'a'.repeat(32)}/export`, 'POST']
  ];
  for (const [path, method] of viewerBulkRoutes) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        cookie: viewerCookie,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {})
      },
      ...(method === 'POST' ? { body: JSON.stringify({ ...exportConfirmation, ids: ['00000000000000000000000000000001'] }) } : {})
    });
    assert.equal(response.status, 403, `${path} must reject viewer access`);
  }

  for (const [path, method] of [
    ['/api/influencers', 'GET'],
    ['/api/influencers/export', 'POST'],
    ['/api/export', 'POST'],
    ['/api/influencers/by-ids', 'POST']
  ]) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...exportConfirmation, ids: [] }) } : {})
    });
    assert.equal(response.status, 401, `${path} must reject requests without a session`);
  }
});

test('scheduled Excel backup is full, stable, and admin-only when run manually', { concurrency: false }, async () => {
  const status = await api('/api/backups');
  assert.equal(status.influencerExcel.state, 'success');
  assert.equal(status.influencerExcel.recordCount, 125);
  assert.equal(status.influencerExcel.path, initialExcelPath);
  assert.equal(validateXlsxWorkbook(await readFile(initialExcelPath), 125), true);

  const editorRequest = await fetch(`${baseUrl}/api/backups/influencers/create`, {
    method: 'POST',
    headers: { cookie: editorCookie, 'content-type': 'application/json' },
    body: JSON.stringify(editorExportConfirmation)
  });
  assert.equal(editorRequest.status, 200);
  const viewerRequest = await fetch(`${baseUrl}/api/backups/influencers/create`, {
    method: 'POST',
    headers: { cookie: viewerCookie }
  });
  assert.equal(viewerRequest.status, 403);
  const anonymousRequest = await fetch(`${baseUrl}/api/backups/influencers/create`, { method: 'POST' });
  assert.equal(anonymousRequest.status, 401);

  const added = await api('/api/influencers', {
    method: 'POST',
    cookie: editorCookie,
    body: { Name: 'Excel Backup Test', 'Username I': 'excel_backup_test', 'Followers Count I': '20K' }
  });
  await api(`/api/influencers/${added.record.id}`, {
    method: 'PUT',
    cookie: editorCookie,
    body: { ...added.record, Name: 'Excel Backup Test Updated' }
  });
  const update = await api('/api/backups/influencers/create', { method: 'POST', body: exportConfirmation });
  assert.ok(update.recordCount >= status.influencerExcel.recordCount);
  assert.equal(update.path, initialExcelPath);
  assert.equal(validateXlsxWorkbook(await readFile(initialExcelPath), update.recordCount), true);

  const deleted = await fetch(`${baseUrl}/api/influencers/${added.record.id}`, {
    method: 'DELETE',
    headers: { cookie: sessionCookie }
  });
  assert.equal(deleted.status, 200);
  const activeDb = new DatabaseSync(databasePath, { readOnly: true });
  const expectedActiveCount = Number(activeDb.prepare('SELECT COUNT(*) AS count FROM influencers WHERE archived_at IS NULL').get().count);
  activeDb.close();
  assert.equal((await api('/api/influencers/meta')).stats.total, expectedActiveCount);
  const afterDelete = await api('/api/backups/influencers/create', { method: 'POST', body: exportConfirmation });
  assert.equal(afterDelete.recordCount, update.recordCount);
  assert.equal(validateXlsxWorkbook(await readFile(initialExcelPath), update.recordCount), true);

});

test('unified interests, language, and content-update fields normalize and filter server-side', { concurrency: false }, async () => {
  const fieldOptionsResponse = await api('/api/influencers/filter-options');
  const defaultInterests = [
    'Beauty', 'Fashion', 'Fitness', 'Food & Cafe', 'kids', 'Tech', 'Travel', 'UGC',
    'Lifestyle', 'Bloging', 'photographer', 'Design', 'Model', 'Chef', 'real estate'
  ];
  defaultInterests.forEach((interest) => assert.ok(fieldOptionsResponse.filters.interests.includes(interest)));
  assert.ok(fieldOptionsResponse.filters.interests.includes('Food'), 'legacy categories migrate into the central interest catalog');
  assert.deepEqual(fieldOptionsResponse.filters.languages, ['Arabic', 'English']);
  assert.deepEqual(fieldOptionsResponse.filters.yesNo, ['Yes', 'No']);

  const createdInterest = await api('/api/interests', {
    method: 'POST', cookie: editorCookie, body: { name: 'Sustainable Living' }
  });
  assert.equal(createdInterest.interest.name, 'Sustainable Living');
  assert.ok((await api('/api/influencers/filter-options')).filters.interests.includes('Sustainable Living'));
  const duplicateInterest = await fetch(`${baseUrl}/api/interests`, {
    method: 'POST',
    headers: { cookie: editorCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '  SUSTAINABLE   LIVING  ' })
  });
  assert.equal(duplicateInterest.status, 409);
  const viewerAddInterest = await fetch(`${baseUrl}/api/interests`, {
    method: 'POST',
    headers: { cookie: viewerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Viewer Interest' })
  });
  assert.equal(viewerAddInterest.status, 403);

  const added = await api('/api/influencers', {
    method: 'POST',
    body: {
      Name: 'Unified Field Test',
      'Followers Count I': '9,999',
      'Followers Count T': '10,000',
      'Followers Count S': '500,000',
      Interests: ['Beauty', 'Food & Cafe', 'beauty', 'Sustainable Living', 'Old Legacy Interest'],
      'Content Update': 'نعم',
      language: 'العربية'
    }
  });
  assert.deepEqual(added.record.Interests, ['Beauty', 'Food & Cafe', 'Sustainable Living']);
  assert.equal(added.record['Full Classification'], 'Beauty, Food & Cafe, Sustainable Living');
  assert.equal('Classification' in added.record, false);
  assert.equal('Categories 1' in added.record, false);
  assert.deepEqual(added.record['Unmapped Interests'], ['Old Legacy Interest']);
  assert.equal(added.record['Content Update'], 'Yes');
  assert.equal(added.record.language, 'Arabic');
  assert.equal(added.record['Influencer Type I'], 'Nano');
  assert.equal(added.record['Influencer Type T'], 'Micro');
  assert.equal(added.record['Influencer Type S'], 'Semi Mega');

  const byBothInterests = new URLSearchParams();
  byBothInterests.append('interest', 'Sustainable Living');
  byBothInterests.append('interest', 'Food & Cafe');
  const matched = await api(`/api/influencers?${byBothInterests}`);
  assert.equal(matched.total, 1, serverErrors);
  assert.equal(matched.rows[0].id, added.record.id);

  const byOptions = await api('/api/influencers?contentUpdate=Yes&language=Arabic');
  assert.equal(byOptions.total, 1);
  assert.equal(byOptions.rows[0].id, added.record.id);

  const updated = await api(`/api/influencers/${added.record.id}`, {
    method: 'PUT',
    body: {
      ...added.record,
      Interests: [...fieldOptionsResponse.filters.interests, createdInterest.interest.name],
      'Followers Count I': '10,000',
      'Followers Count T': '1,000,000',
      'Followers Count S': '999,999'
    }
  });
  assert.equal(updated.record['Influencer Type I'], 'Micro');
  assert.equal(updated.record['Influencer Type T'], 'Mega');
  assert.equal(updated.record['Influencer Type S'], 'Semi Mega');
  assert.equal(updated.record['Content Update'], 'Yes');
  assert.equal(updated.record.language, 'Arabic');
  assert.deepEqual(updated.record.Interests, [...fieldOptionsResponse.filters.interests, createdInterest.interest.name]);
  assert.equal(updated.record['Full Classification'], updated.record.Interests.join(', '));

  const allInterestsQuery = new URLSearchParams({ q: 'Unified Field Test' });
  fieldOptionsResponse.filters.interests.forEach((interest) => allInterestsQuery.append('interest', interest));
  const byAllInterests = await api(`/api/influencers?${allInterestsQuery}`);
  assert.equal(byAllInterests.total, 1);
  assert.deepEqual(byAllInterests.rows.map((row) => row.id), [added.record.id]);

  const legacyValue = await api('/api/influencers', {
    method: 'POST',
    body: {
      Name: 'Legacy Choice Test',
      'Categories 1': 'Beauty, Blogging, Fashion',
      'Content Update': 'Weekly',
      language: 'French'
    }
  });
  assert.deepEqual(legacyValue.record.Interests, ['Beauty', 'Bloging', 'Fashion']);
  assert.deepEqual(legacyValue.record['Unmapped Interests'], []);
  assert.equal(legacyValue.record['Full Classification'], 'Beauty, Bloging, Fashion');
  assert.deepEqual(legacyValue.record['Unmapped Content Update'], ['Weekly']);
  assert.deepEqual(legacyValue.record['Unmapped Language'], ['French']);

  const renamedInterest = await api(`/api/interests/${createdInterest.interest.id}`, {
    method: 'PUT', body: { name: 'Eco Living' }
  });
  assert.equal(renamedInterest.interest.name, 'Eco Living');
  const renamedRecord = (await api('/api/influencers?q=Unified Field Test')).rows[0];
  assert.equal(renamedRecord.Interests.includes('Eco Living'), true);
  assert.equal(renamedRecord['Full Classification'].includes('Eco Living'), true);
  const reopened = (await api('/api/influencers/by-ids', {
    method: 'POST', body: { ids: [added.record.id] }
  })).rows[0];
  const expectedRenamedInterests = updated.record.Interests.map((interest) =>
    interest === 'Sustainable Living' ? 'Eco Living' : interest);
  assert.deepEqual(reopened.Interests, expectedRenamedInterests);
  assert.equal(reopened['Full Classification'], expectedRenamedInterests.join(', '));
  const exported = await api('/api/export', { method: 'POST', body: exportConfirmation });
  const exportedRecord = exported.rows.find((row) => row.id === added.record.id);
  assert.deepEqual(exportedRecord.Interests, renamedRecord.Interests);
  assert.equal(exportedRecord['Full Classification'], renamedRecord['Full Classification']);
});

test('inactive status, private advertiser-note history, and confirmed archive preserve linked records', { concurrency: false }, async () => {
  const influencerId = '00000000000000000000000000000001';
  const inactiveWithoutReason = await fetch(`${baseUrl}/api/influencers/${influencerId}/status`, {
    method: 'PATCH',
    headers: { cookie: editorCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'Inactive' })
  });
  assert.equal(inactiveWithoutReason.status, 400);
  assert.equal((await api('/api/influencers?q=test_creator_001')).rows[0]['Influencer Status'], 'Active');

  const inactive = await api(`/api/influencers/${influencerId}/status`, {
    method: 'PATCH', cookie: editorCookie,
    body: { status: 'Inactive', reason: 'لم يستكمل التعاون بعد الحملة.' }
  });
  assert.equal(inactive.record['Influencer Status'], 'Inactive');
  const firstStatusHistory = await api(`/api/influencers/${influencerId}/status-history`, { cookie: editorCookie });
  assert.equal(firstStatusHistory.history[0].reason, 'لم يستكمل التعاون بعد الحملة.');
  assert.equal(firstStatusHistory.history[0].actorUsername, 'pagination-editor');
  assert.ok(Number.isFinite(Date.parse(firstStatusHistory.history[0].changedAt)));

  await api(`/api/influencers/${influencerId}/status`, {
    method: 'PATCH', cookie: sessionCookie, body: { status: 'Active' }
  });
  const reactivatedHistory = await api(`/api/influencers/${influencerId}/status-history`);
  assert.equal(reactivatedHistory.history.length, 2);
  assert.equal(reactivatedHistory.history[0].status, 'Active');
  assert.equal(reactivatedHistory.history[1].reason, 'لم يستكمل التعاون بعد الحملة.');

  const firstNote = await api(`/api/influencers/${influencerId}/advertiser-notes`, {
    method: 'POST', cookie: editorCookie, body: { noteText: 'يفضل التواصل في الفترة الصباحية.' }
  });
  const secondNote = await api(`/api/influencers/${influencerId}/advertiser-notes`, {
    method: 'POST', cookie: sessionCookie, body: { noteText: 'التزم بالموعد في آخر تعاون.' }
  });
  const viewerNotes = await fetch(`${baseUrl}/api/influencers/${influencerId}/advertiser-notes`, {
    headers: { cookie: viewerCookie }
  });
  assert.equal(viewerNotes.status, 403);
  const notes = await api(`/api/influencers/${influencerId}/advertiser-notes`);
  assert.deepEqual(notes.notes.map((note) => note.id), [secondNote.note.id, firstNote.note.id]);
  assert.equal(notes.notes[0].createdBy, 'pagination-test');
  assert.ok(Number.isFinite(Date.parse(notes.notes[0].createdAt)));
  assert.equal(notes.history.length, 2);

  const updatedNote = await api(`/api/influencers/${influencerId}/advertiser-notes/${firstNote.note.id}`, {
    method: 'PUT', cookie: editorCookie, body: { noteText: 'يفضل التواصل برسالة صباحية.' }
  });
  assert.equal(updatedNote.note.noteText, 'يفضل التواصل برسالة صباحية.');
  const editorDelete = await fetch(`${baseUrl}/api/influencers/${influencerId}/advertiser-notes/${firstNote.note.id}`, {
    method: 'DELETE', headers: { cookie: editorCookie }
  });
  assert.equal(editorDelete.status, 200);
  const notesAfterDelete = await api(`/api/influencers/${influencerId}/advertiser-notes`);
  assert.deepEqual(notesAfterDelete.notes.map((note) => note.id), [secondNote.note.id]);
  assert.deepEqual(notesAfterDelete.history.map((entry) => entry.action), ['deleted', 'updated', 'created', 'created']);
  const exportedResponse = await fetch(`${baseUrl}/api/export`, {
    method: 'POST',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify(exportConfirmation)
  });
  assert.equal(exportedResponse.status, 200);
  const exported = await exportedResponse.json();
  assert.equal(JSON.stringify(exported.rows).includes('يفضل التواصل برسالة'), false);

  const beforeArchive = (await api('/api/influencers/meta')).stats.total;
  const archived = await api('/api/influencers', {
    method: 'POST', body: { Name: 'Archive linked test', Main_Username: 'archive_linked_test' }
  });
  await api(`/api/influencers/${archived.record.id}/advertiser-notes`, {
    method: 'POST', body: { noteText: 'ملاحظة تظل محفوظة بعد الأرشفة.' }
  });
  const campaign = await api('/api/campaigns', {
    method: 'POST',
    body: {
      campaignName: 'Archive retention test',
      companyName: 'Test client',
      campaignType: 'visit',
      serviceType: 'influencer',
      startDate: '2026-10-11',
      endDate: '2026-10-11',
      targets: [{ id: archived.record.id, visitDate: '2026-10-11' }]
    }
  });
  const relationships = await api(`/api/influencers/${archived.record.id}/relationships`);
  assert.equal(relationships.counts.campaigns, 1);
  assert.equal(relationships.counts.advertiserNotes, 1);
  assert.ok(relationships.total >= 2);

  const confirmedArchive = await fetch(`${baseUrl}/api/influencers/${archived.record.id}`, {
    method: 'DELETE',
    headers: { cookie: sessionCookie, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(confirmedArchive.status, 200);
  const archiveAuditDb = new DatabaseSync(databasePath, { readOnly: true });
  const archiveAudit = archiveAuditDb.prepare(`SELECT entity_id, entity_label, actor_username
    FROM audit_events WHERE action = 'influencer.archive' AND entity_id = ?
    ORDER BY occurred_at DESC LIMIT 1`).get(archived.record.id);
  assert.equal(archiveAudit.entity_id, archived.record.id);
  assert.equal(archiveAudit.entity_label, archived.record.Name);
  assert.equal(archiveAudit.actor_username, 'pagination-test');
  archiveAuditDb.close();
  const editorArchivable = await api('/api/influencers', {
    method: 'POST', cookie: editorCookie,
    body: { Name: 'Editor archive restore test', Main_Username: 'editor_archive_restore_test' }
  });
  const editorArchive = await fetch(`${baseUrl}/api/influencers/${editorArchivable.record.id}`, {
    method: 'DELETE',
    headers: { cookie: editorCookie, 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(editorArchive.status, 200);
  const editorRestored = await api(`/api/influencers/${editorArchivable.record.id}/restore`, {
    method: 'POST', cookie: editorCookie
  });
  assert.equal(editorRestored.record['Influencer Status'], 'Active');
  const editorCleanupArchive = await fetch(`${baseUrl}/api/influencers/${editorArchivable.record.id}`, {
    method: 'DELETE', headers: { cookie: editorCookie, 'content-type': 'application/json' }, body: JSON.stringify({})
  });
  assert.equal(editorCleanupArchive.status, 200);
  assert.equal((await api('/api/influencers?q=archive_linked_test')).total, 0);
  const archivedPage = await api('/api/influencers?status=Archived&q=archive_linked_test');
  assert.equal(archivedPage.total, 1);
  assert.deepEqual(archivedPage.archivedIds, [archived.record.id]);
  assert.equal((await api('/api/influencers/meta')).stats.total, beforeArchive);
  assert.equal((await api('/api/campaigns')).campaigns.find((item) => item.id === campaign.campaign.id).targets.length, 1);
  assert.equal((await api(`/api/influencers/${archived.record.id}/advertiser-notes`)).notes.length, 1);

  const restored = await api(`/api/influencers/${archived.record.id}/restore`, { method: 'POST' });
  assert.equal(restored.record['Influencer Status'], 'Active');
  assert.equal((await api('/api/influencers?q=archive_linked_test')).total, 1);
  assert.equal((await api(`/api/influencers/${archived.record.id}/status-history`)).history.length, 2);
});
