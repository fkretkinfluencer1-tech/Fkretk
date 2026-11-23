import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { performance } from 'node:perf_hooks';
import { assertSafeDbPath } from './db-guard.mjs';

const projectDir = new URL('..', import.meta.url);
const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-scale-test-'));
const dataDir = join(tempDir, 'data');
const databasePath = join(dataDir, 'fikratak.sqlite');
assertSafeDbPath(databasePath, 'test database');
await mkdir(dataDir, { recursive: true });

const fixture = new DatabaseSync(databasePath);
fixture.exec('CREATE TABLE influencers (id TEXT PRIMARY KEY, record_json TEXT NOT NULL, phone_key TEXT UNIQUE)');
fixture.function('account_username', { deterministic: true }, value =>
  String(value || '').normalize('NFKC').trim().replace(/^@+/, '').replace(/\s+/gu, '').toLocaleLowerCase('en-US'));
fixture.function('country_iso', { deterministic: true }, value => ({
  'Saudi Arabia': 'SA', UAE: 'AE'
}[String(value || '').trim()] || ''));
fixture.function('workflow_status', { deterministic: true }, value => String(value || '').trim().toLocaleLowerCase('en-US'));
fixture.function('normalized_filter', { deterministic: true }, (_field, value) =>
  String(value || '').trim().toLocaleLowerCase('en-US'));

function seedToCount(count) {
  const start = Number(fixture.prepare('SELECT COUNT(*) AS count FROM influencers').get().count);
  const insertBatch = fixture.prepare('INSERT INTO influencers (id, record_json) VALUES (?, ?)');
  fixture.exec('BEGIN IMMEDIATE');
  try {
    for (let index = start + 1; index <= count; index += 1) {
      const suffix = String(index).padStart(5, '0');
      insertBatch.run(index.toString(16).padStart(32, '0'), JSON.stringify({
        Name: `Scale Creator ${suffix}`,
        Main_Username: `scale_creator_${suffix}`,
        'Best Platform': 'Instagram',
        'Username I': `scale_creator_${suffix}`,
        'Followers Count I': String(1000 + index),
        Country: index % 2 ? 'Saudi Arabia' : 'UAE',
        Area: index % 2 ? 'Riyadh Region' : 'Dubai',
        City: index % 2 ? 'Riyadh' : 'Dubai',
        Classification: index % 2 ? 'Food' : 'Travel',
        'Categories 1': index % 2 ? 'Food' : 'Travel',
        'Influencer Status': 'Active',
        'Workflow Status': 'new'
      }));
    }
    fixture.exec('COMMIT');
  } catch (error) {
    fixture.exec('ROLLBACK');
    throw error;
  }
}

seedToCount(4000);

const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once('error', reject);
  portProbe.listen(0, '127.0.0.1', resolve);
});
const port = portProbe.address().port;
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));

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
server.stderr.on('data', chunk => { serverErrors += chunk.toString(); });
const baseUrl = `http://127.0.0.1:${port}`;

after(async () => {
  fixture.close();
  if (server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
  await rm(tempDir, { recursive: true, force: true });
});

let ready = false;
for (let attempt = 0; attempt < 300 && !ready; attempt += 1) {
  if (server.exitCode !== null) throw new Error(`Scale test server stopped: ${serverErrors}`);
  try { ready = (await fetch(baseUrl)).status === 200; } catch {}
  if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
}
if (!ready) throw new Error(`Scale test server did not start: ${serverErrors}`);

const setup = await fetch(`${baseUrl}/api/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'scale-admin', password: 'Scale-test-password-2026!' })
});
assert.equal(setup.status, 201);
const cookie = setup.headers.get('set-cookie')?.split(';')[0];
const exportConfirmation = {
  confirmationUsername: 'scale-admin',
  confirmationPassword: 'Scale-test-password-2026!'
};

async function request(path, options = {}) {
  let requestOptions = options;
  if (path === '/api/import' && String(options.method || 'GET').toUpperCase() === 'POST'
    && options.body && typeof options.body === 'object' && !options.body.previewId) {
    const previewResponse = await fetch(`${baseUrl}/api/import/preview`, {
      method: 'POST',
      body: JSON.stringify(options.body),
      headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }
    });
    const previewBody = await previewResponse.json();
    if (!previewResponse.ok) throw new Error(`/api/import/preview: ${previewResponse.status} ${JSON.stringify(previewBody)} ${serverErrors}`);
    requestOptions = {
      ...options,
      body: {
        ...options.body, previewId: previewBody.preview.previewId,
        acknowledgeUnknownColumns: true, confirmAllNew: true
      }
    };
  }
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    ...requestOptions,
    body: requestOptions.body && typeof requestOptions.body !== 'string' ? JSON.stringify(requestOptions.body) : requestOptions.body,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(requestOptions.body ? { 'content-type': 'application/json' } : {}),
      ...requestOptions.headers
    }
  });
  const durationMs = performance.now() - started;
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)} ${serverErrors}`);
  return { body, durationMs };
}

function reportTiming(t, label, values) {
  const timings = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.round(value)]));
  t.diagnostic(`${label} timings (ms): ${JSON.stringify(timings)}`);
}

test('database search, filters, and pagination remain server-side at 4,000 influencers', { concurrency: false }, async t => {
  const total = await request('/api/influencers?page=1&pageSize=100');
  assert.equal(total.body.total, 4000);
  assert.equal(total.body.rows.length, 100);
  const page = await request('/api/influencers?page=40&pageSize=100');
  assert.equal(page.body.rows.length, 100);
  assert.equal(page.body.rows.at(-1).Name, 'Scale Creator 00001');
  const search = await request('/api/influencers?q=scale_creator_03999&page=1&pageSize=20');
  assert.equal(search.body.total, 1);
  const filters = await request('/api/influencers?country=SA&city=Riyadh&tier=Nano&pageSize=100');
  assert.equal(filters.body.total, 2000);
  reportTiming(t, '4,000 records', {
    page: total.durationMs, lastPage: page.durationMs, exactSearch: search.durationMs, combinedFilters: filters.durationMs
  });
});

test('database totals and search remain correct at 5,000 influencers', { concurrency: false }, async t => {
  seedToCount(5000);
  const metadata = await request('/api/influencers/meta');
  const page = await request('/api/influencers?q=scale_creator_04999&page=1&pageSize=50');
  assert.equal(metadata.body.stats.total, 5000);
  assert.equal(page.body.total, 1);
  assert.equal(page.body.rows[0].Name, 'Scale Creator 04999');
  reportTiming(t, '5,000 records', { metadata: metadata.durationMs, exactSearch: page.durationMs });
});

test('database export, filtering, details, imports, and campaign linking work beyond 10,000', { concurrency: false }, async t => {
  seedToCount(10000);
  const page = await request('/api/influencers?page=100&pageSize=100');
  assert.equal(page.body.total, 10000);
  assert.equal(page.body.rows.length, 100);
  assert.equal(page.body.rows.at(-1).Name, 'Scale Creator 00001');

  const search = await request('/api/influencers?platform=Instagram&country=SA&q=scale_creator_09999&pageSize=20');
  assert.equal(search.body.total, 1);
  const exportResult = await request('/api/influencers/export', { method: 'POST', body: exportConfirmation });
  assert.equal(exportResult.body.rows.length, 10000);
  const details = await request('/api/influencers/by-ids', {
    method: 'POST',
    body: { ids: ['00000000000000000000000000000001', '00000000000000000000000000002710'] }
  });
  assert.equal(details.body.rows.length, 2);

  const duplicateImport = await request('/api/import', {
    method: 'POST',
    body: { rows: [{ id: '00000000000000000000000000000001', 'Username I': ' SCALE_CREATOR_00001 ', Name: 'Scale Creator Updated' }] }
  });
  assert.equal(duplicateImport.body.created, 0);
  assert.equal(duplicateImport.body.updated, 1);
  const newImport = await request('/api/import', {
    method: 'POST',
    body: { rows: [{ Name: 'API Added Scale Creator', 'Username I': 'api_added_scale_creator', 'Followers Count I': '25000' }] }
  });
  assert.equal(newImport.body.created, 1);
  const newRecord = fixture.prepare(`SELECT id FROM influencers
    WHERE json_extract(record_json, '$."Username I"') = 'api_added_scale_creator'`).get();
  assert.ok(newRecord);
  assert.equal(fixture.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, 10001);

  const unchangedPreviewResponse = await fetch(`${baseUrl}/api/import/preview`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ rows: [{
      Name: ' Scale Creator 00001 ',
      'Username I': ' SCALE_CREATOR_00001 ',
      City: ' Riyadh '
    }] })
  });
  assert.equal(unchangedPreviewResponse.status, 200);
  const unchangedPreview = (await unchangedPreviewResponse.json()).preview.integrity;
  assert.deepEqual({ unchanged: unchangedPreview.unchanged, updates: unchangedPreview.updates }, {
    unchanged: 1, updates: 0
  });
  const updatedPreviewResponse = await fetch(`${baseUrl}/api/import/preview`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ rows: [{
      'Username I': 'scale_creator_00001',
      City: 'Changed Riyadh'
    }] })
  });
  assert.equal(updatedPreviewResponse.status, 200);
  const updatedPreview = (await updatedPreviewResponse.json()).preview.integrity;
  assert.deepEqual({ unchanged: updatedPreview.unchanged, updates: updatedPreview.updates }, {
    unchanged: 0, updates: 1
  });

  const campaign = await request('/api/campaigns', {
    method: 'POST',
    body: {
      campaignName: '10K scale verification',
      companyName: 'Synthetic Test Client',
      campaignType: 'visit',
      serviceType: 'influencer',
      startDate: '2026-11-02',
      endDate: '2026-11-05',
      targets: [{ id: newRecord.id, visitDate: '2026-11-03' }]
    }
  });
  assert.equal(campaign.body.campaign.targets.length, 1);
  assert.equal(campaign.body.campaign.targets[0].id, newRecord.id);
  const list = await request('/api/campaigns');
  assert.equal(list.body.campaigns.some(item => item.id === campaign.body.campaign.id
    && item.targets.some(target => target.id === newRecord.id)), true);
  const largeTargetIds = fixture.prepare(`SELECT id FROM influencers
    WHERE json_extract(record_json, '$.Name') LIKE 'Scale Creator %' ORDER BY id LIMIT 1000`).all();
  assert.equal(largeTargetIds.length, 1000);
  const largeCampaign = await request('/api/campaigns', {
    method: 'POST',
    body: {
      campaignName: '1,000 target scale verification',
      companyName: 'Synthetic Large Campaign Client',
      campaignType: 'visit',
      serviceType: 'influencer',
      startDate: '2026-11-02',
      endDate: '2026-11-05',
      targets: largeTargetIds.map(({ id }) => ({ id, visitDate: '2026-11-03' }))
    }
  });
  assert.equal(largeCampaign.body.campaign.targets.length, 1000);
  assert.equal(fixture.prepare('SELECT COUNT(*) AS count FROM campaign_targets WHERE campaign_id = ?')
    .get(largeCampaign.body.campaign.id).count, 1000);

  const bulkRows = [
    ...Array.from({ length: 1000 }, (_, index) => ({
      Name: `Bulk Imported Creator ${String(index + 1).padStart(4, '0')}`,
      'Username I': `bulk_import_creator_${String(index + 1).padStart(4, '0')}`
    })),
    ...Array.from({ length: 1000 }, (_, index) => ({
      id: (index + 1001).toString(16).padStart(32, '0'),
      'Username I': `scale_creator_${String(index + 1001).padStart(5, '0')}`
    }))
  ];
  const bulkImport = await request('/api/import', { method: 'POST', body: { rows: bulkRows } });
  assert.deepEqual(
    { created: bulkImport.body.created, updated: bulkImport.body.updated, unchanged: bulkImport.body.unchanged, failed: bulkImport.body.failed },
    { created: 1000, updated: 0, unchanged: 1000, failed: 0 }
  );
  assert.equal(Number(fixture.prepare('SELECT COUNT(*) AS count FROM influencers').get().count), 11001);
  const stillLinked = await request('/api/campaigns');
  assert.equal(stillLinked.body.campaigns.some(item => item.id === campaign.body.campaign.id
    && item.targets.some(target => target.id === newRecord.id)), true);

  const integrity = fixture.prepare('PRAGMA quick_check').all().map(row => Object.values(row)[0]);
  assert.deepEqual(integrity, ['ok']);
  reportTiming(t, '10,000+ records', {
    page: page.durationMs, filteredSearch: search.durationMs, fullExport: exportResult.durationMs,
    detailsBatch: details.durationMs, duplicateImport: duplicateImport.durationMs,
    newImport: newImport.durationMs, bulkImport: bulkImport.durationMs,
    campaignCreate: campaign.durationMs, campaignList: list.durationMs,
    largeCampaignCreate: largeCampaign.durationMs
  });
});

test('dashboard Mawthouq and platform verification metrics use separate unique-influencer counts', { concurrency: false }, async () => {
  const dashboardMarkup = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(dashboardMarkup, /<span>شهادة موثوق<\/span>[\s\S]*?<strong id="dashboard-mawthouq">[\s\S]*?<span class="dashboard-metric-note">مؤثرون حاصلون على شهادة موثوق<\/span>/);
  assert.match(dashboardMarkup, /<span>حسابات موثّقة<\/span>[\s\S]*?<strong id="dashboard-verified">[\s\S]*?<span class="dashboard-metric-note">مؤثرون بشارة التوثيق على المنصة<\/span>/);

  const initial = (await request('/api/influencers/meta')).body.stats;
  assert.equal(initial.total, 11001);
  assert.equal(initial.mawthouq, 0);
  assert.equal(initial.verified, 0);

  const samples = [
    {
      Name: 'Synthetic certified multi-platform creator',
      Mawthouq: 'Yes',
      Verified: 'No',
      'Username I': 'dashboard_certified_ig',
      'Username T': 'dashboard_certified_tt',
      Username: 'dashboard_certified_snap'
    },
    {
      Name: 'Synthetic platform verified creator',
      Mawthouq: 'No',
      Verified: 'Yes',
      'Username I': 'dashboard_platform_verified'
    },
    {
      Name: 'Synthetic unlicensed creator',
      Mawthouq: 'No',
      Verified: 'No',
      'Username I': 'dashboard_unlicensed'
    },
    {
      Name: 'Synthetic unclear status creator',
      Mawthouq: 'Needs review',
      Verified: 'Pending',
      'Username I': 'dashboard_unclear'
    }
  ];
  for (const sample of samples) {
    const created = await request('/api/influencers', { method: 'POST', body: sample });
    assert.ok(created.body.record.id);
  }

  const updated = (await request('/api/influencers/meta')).body.stats;
  assert.equal(updated.total, initial.total + samples.length);
  assert.equal(updated.mawthouq, 1);
  assert.equal(updated.verified, 1);
  const filteredPage = await request('/api/influencers?q=dashboard_certified_ig&page=1&pageSize=1');
  assert.equal(filteredPage.body.total, 1);
  assert.equal(filteredPage.body.rows.length, 1);
  const afterFilteredPage = (await request('/api/influencers/meta')).body.stats;
  assert.equal(afterFilteredPage.mawthouq, updated.mawthouq);
  assert.equal(afterFilteredPage.verified, updated.verified);
});
