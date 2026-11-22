import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { assertSafeDbPath } from './db-guard.mjs';

const projectDir = new URL('..', import.meta.url);
const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-backup-restore-test-'));
assertSafeDbPath(join(tempDir, 'data', 'fikratak.sqlite'), 'test database');

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

function launchServer(dataDir, backupDir, port) {
  return spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(port), FIKRATAK_DATA_DIR: dataDir, FIKRATAK_BACKUP_DIR: backupDir },
    stdio: ['ignore', 'ignore', 'pipe']
  });
}

async function waitForServer(server, baseUrl) {
  let errors = '';
  server.stderr.on('data', chunk => { errors += chunk.toString(); });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Test server stopped during startup: ${errors}`);
    try {
      if ((await fetch(baseUrl)).status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Test server did not start: ${errors}`);
}

async function stopServer(server) {
  if (server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
}

test('a full SQLite backup restores records and campaign relationships on an isolated server', { concurrency: false }, async t => {
  const sourceData = join(tempDir, 'source-data');
  const sourceBackups = join(tempDir, 'source-backups');
  const restoredData = join(tempDir, 'restored-data');
  const restoredBackups = join(tempDir, 'restored-backups');
  await Promise.all([sourceData, sourceBackups, restoredData, restoredBackups].map(path => mkdir(path, { recursive: true })));

  const sourcePort = await availablePort();
  const sourceUrl = `http://127.0.0.1:${sourcePort}`;
  let sourceServer = launchServer(sourceData, sourceBackups, sourcePort);
  let restoredServer;
  t.after(async () => {
    await stopServer(sourceServer);
    if (restoredServer) await stopServer(restoredServer);
    await rm(tempDir, { recursive: true, force: true });
  });
  await waitForServer(sourceServer, sourceUrl);

  const setup = await fetch(`${sourceUrl}/api/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'backup-restore-admin', password: 'Restore-test-password-2026!' })
  });
  assert.equal(setup.status, 201);
  let cookie = setup.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  async function sourceApi(path, options = {}) {
    const response = await fetch(`${sourceUrl}${path}`, {
      ...options,
      headers: {
        cookie,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers
      },
      body: options.body ? JSON.stringify(options.body) : options.body
    });
    const body = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(body)}`);
    return body;
  }

  const influencer = await sourceApi('/api/influencers', {
    method: 'POST',
    body: { Name: 'Backup Restore Fixture', 'Username I': 'backup_restore_fixture', 'Followers Count I': '12500' }
  });
  const campaign = await sourceApi('/api/campaigns', {
    method: 'POST',
    body: {
      campaignName: 'Backup Restore Campaign',
      companyName: 'Test Advertiser',
      campaignType: 'visit',
      serviceType: 'influencer',
      startDate: '2026-11-02',
      endDate: '2026-11-05',
      targets: [{ id: influencer.record.id, visitDate: '2026-11-03' }]
    }
  });
  const backup = await sourceApi('/api/backups/create', {
    method: 'POST',
    body: {
      confirmationUsername: 'backup-restore-admin',
      confirmationPassword: 'Restore-test-password-2026!'
    }
  });
  const backupPath = join(sourceBackups, backup.file);
  const snapshot = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(snapshot.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(snapshot.prepare('SELECT COUNT(*) AS count FROM campaign_targets WHERE influencer_id = ?')
    .get(influencer.record.id).count, 1);
  snapshot.close();

  await sourceApi(`/api/influencers/${influencer.record.id}`, {
    method: 'PUT',
    body: { ...influencer.record, Name: 'Changed After Backup' }
  });
  const restoredPath = join(restoredData, 'fikratak.sqlite');
  await copyFile(backupPath, restoredPath);

  const restoredPort = await availablePort();
  const restoredUrl = `http://127.0.0.1:${restoredPort}`;
  restoredServer = launchServer(restoredData, restoredBackups, restoredPort);
  await waitForServer(restoredServer, restoredUrl);

  const login = await fetch(`${restoredUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'backup-restore-admin', password: 'Restore-test-password-2026!' })
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  const restoredInfluencers = await fetch(`${restoredUrl}/api/influencers?q=backup_restore_fixture`, {
    headers: { cookie }
  }).then(response => response.json());
  assert.equal(restoredInfluencers.total, 1);
  assert.equal(restoredInfluencers.rows[0].Name, 'Backup Restore Fixture');

  const restoredCampaigns = await fetch(`${restoredUrl}/api/campaigns`, { headers: { cookie } }).then(response => response.json());
  const linkedCampaign = restoredCampaigns.campaigns.find(item => item.id === campaign.campaign.id);
  assert.ok(linkedCampaign);
  assert.equal(linkedCampaign.targets.some(target => target.id === influencer.record.id), true);

  const restoredDatabase = new DatabaseSync(restoredPath, { readOnly: true });
  assert.equal(restoredDatabase.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(restoredDatabase.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(restoredDatabase.prepare('SELECT COUNT(*) AS count FROM influencers WHERE id = ?')
    .get(influencer.record.id).count, 1);
  restoredDatabase.close();
});
