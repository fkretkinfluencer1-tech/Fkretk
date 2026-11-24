import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const projectDir = new URL('..', import.meta.url);

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('production requires trusted HTTPS setup, secures cookies, and denies internal files', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-production-'));
  const dataDir = join(tempDir, 'data');
  const backupDir = join(tempDir, 'backups');
  await Promise.all([mkdir(dataDir), mkdir(backupDir)]);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const setupToken = 'production-setup-token-for-isolated-test-0000000000000000';
  const server = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      FIKRATAK_HOST: '127.0.0.1',
      FIKRATAK_DATA_DIR: dataDir,
      FIKRATAK_BACKUP_DIR: backupDir,
      FIKRATAK_ALLOWED_ORIGINS: 'https://crm.example.test',
      FIKRATAK_SETUP_TOKEN: setupToken
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  let serverErrors = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverErrors += chunk.toString(); });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await once(server, 'exit');
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Production test server stopped: ${serverErrors}`);
    try { ready = (await fetch(baseUrl)).status === 200; } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Production test server did not start: ${serverErrors}`);

  const headers = { origin: 'https://crm.example.test', host: 'crm.example.test', 'content-type': 'application/json' };
  const session = await fetch(`${baseUrl}/api/session`);
  assert.deepEqual(await session.json(), { setupRequired: true, setupTokenRequired: true, user: null });
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(session.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  assert.equal(session.headers.get('cross-origin-resource-policy'), 'same-origin');
  const visibilityAsset = await fetch(`${baseUrl}/assets/password-visibility.js`);
  assert.equal(visibilityAsset.status, 200);
  assert.match(await visibilityAsset.text(), /password-visibility-toggle/);

  const blockedWithoutOrigin = await fetch(`${baseUrl}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'production-admin', password: 'Production-test-password-2026!' })
  });
  assert.equal(blockedWithoutOrigin.status, 403);

  const blockedHttpOrigin = await fetch(`${baseUrl}/api/setup`, {
    method: 'POST',
    headers: { ...headers, origin: 'http://crm.example.test' },
    body: JSON.stringify({ username: 'production-admin', password: 'Production-test-password-2026!', setupToken })
  });
  assert.equal(blockedHttpOrigin.status, 403);

  const blockedUnlistedOrigin = await fetch(`${baseUrl}/api/setup`, {
    method: 'POST',
    headers: { ...headers, origin: 'https://other.example.test' },
    body: JSON.stringify({ username: 'production-admin', password: 'Production-test-password-2026!', setupToken })
  });
  assert.equal(blockedUnlistedOrigin.status, 403);
  assert.match((await blockedUnlistedOrigin.json()).error, /FIKRATAK_ALLOWED_ORIGINS/);

  const missingToken = await fetch(`${baseUrl}/api/setup`, {
    method: 'POST', headers,
    body: JSON.stringify({ username: 'production-admin', password: 'Production-test-password-2026!' })
  });
  assert.equal(missingToken.status, 403);
  assert.match((await missingToken.json()).error, /FIKRATAK_SETUP_TOKEN/);

  const concurrentSetups = await Promise.all([0, 1].map(() => fetch(`${baseUrl}/api/setup`, {
    method: 'POST', headers,
    body: JSON.stringify({ username: 'production-admin', password: 'Production-test-password-2026!', setupToken })
  })));
  assert.deepEqual(concurrentSetups.map((response) => response.status).sort(), [201, 409]);
  const setup = concurrentSetups.find((response) => response.status === 201);
  assert.ok(setup);
  assert.match(setup.headers.get('set-cookie'), /; Secure(?:;|$)/);
  assert.match(setup.headers.get('set-cookie'), /HttpOnly/);
  assert.match(setup.headers.get('set-cookie'), /SameSite=Strict/);
  const adminCookie = setup.headers.get('set-cookie').split(';')[0];
  const importStatus = await fetch(`${baseUrl}/api/import/status`, { headers: { ...headers, cookie: adminCookie } });
  assert.deepEqual(await importStatus.json(), { paused: true });
  for (const endpoint of ['/api/import/preview', '/api/import']) {
    const pausedImport = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { ...headers, cookie: adminCookie },
      body: JSON.stringify({ rows: [] })
    });
    assert.equal(pausedImport.status, 503);
    assert.equal((await pausedImport.json()).error, 'الاستيراد متوقف مؤقتاً للصيانة.');
  }

  const secondSetup = await fetch(`${baseUrl}/api/setup`, {
    method: 'POST', headers,
    body: JSON.stringify({ username: 'second-admin', password: 'Production-test-password-2026!', setupToken })
  });
  assert.equal(secondSetup.status, 409);
  const auditDatabase = new DatabaseSync(join(dataDir, 'fikratak.sqlite'), { readOnly: true });
  try {
    const auditEntries = auditDatabase.prepare('SELECT old_values_json, new_values_json FROM audit_events').all();
    assert.ok(auditEntries.every((entry) => !entry.old_values_json.includes(setupToken)
      && !entry.old_values_json.includes('Production-test-password-2026!')
      && !entry.new_values_json.includes(setupToken)
      && !entry.new_values_json.includes('Production-test-password-2026!')));
  } finally {
    auditDatabase.close();
  }

  const reset = await fetch(`${baseUrl}/api/password-reset-request`, {
    method: 'POST', headers,
    body: JSON.stringify({ username: 'production-admin' })
  });

  test('production limits failed first-admin setup token attempts', async (t) => {
    const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-setup-limit-'));
    const dataDir = join(tempDir, 'data');
    const backupDir = join(tempDir, 'backups');
    await Promise.all([mkdir(dataDir), mkdir(backupDir)]);
    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
      cwd: projectDir,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        FIKRATAK_HOST: '127.0.0.1',
        FIKRATAK_DATA_DIR: dataDir,
        FIKRATAK_BACKUP_DIR: backupDir,
        FIKRATAK_ALLOWED_ORIGINS: 'https://crm.example.test',
        FIKRATAK_SETUP_TOKEN: 'another-production-setup-token-for-isolated-test-000000000000'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let serverErrors = '';
    server.stderr.on('data', (chunk) => { serverErrors += chunk.toString(); });
    t.after(async () => {
      if (server.exitCode === null) {
        server.kill();
        await once(server, 'exit');
      }
      await rm(tempDir, { recursive: true, force: true });
    });

    let ready = false;
    for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Setup-limit server stopped: ${serverErrors}`);
      try { ready = (await fetch(baseUrl)).status === 200; } catch {}
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, `Setup-limit server did not start: ${serverErrors}`);

    const headers = {
      origin: 'https://crm.example.test',
      host: 'crm.example.test',
      'content-type': 'application/json'
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/setup`, {
        method: 'POST', headers,
        body: JSON.stringify({ username: 'production-admin', password: 'Production-test-password-2026!', setupToken: 'invalid' })
      });
      assert.equal(response.status, 403);
    }
    const throttled = await fetch(`${baseUrl}/api/setup`, {
      method: 'POST', headers,
      body: JSON.stringify({ username: 'production-admin', password: 'Production-test-password-2026!', setupToken: 'invalid' })
    });
    assert.equal(throttled.status, 429);
    assert.equal((await fetch(`${baseUrl}/api/session`).then((response) => response.json())).setupRequired, true);
  });
  assert.equal(reset.status, 503);

  const resetConfirm = await fetch(`${baseUrl}/api/password-reset-confirm`, {
    method: 'POST', headers,
    body: JSON.stringify({ username: 'production-admin', code: '000000', password: 'Production-test-password-2026!' })
  });
  assert.equal(resetConfirm.status, 503);
  const syntheticLogPassword = 'Synthetic-log-password-sentinel!';
  await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { ...headers, origin: 'https://crm.example.test' },
    body: JSON.stringify({ username: 'synthetic-log-5550001234', password: syntheticLogPassword })
  });
  const processLogs = `${serverOutput}\n${serverErrors}`;
  for (const secret of [setupToken, 'Production-test-password-2026!', syntheticLogPassword, '5550001234']) {
    assert.equal(processLogs.includes(secret), false, `Process logs must not contain submitted sensitive data: ${secret}`);
  }

  for (const path of [
    '/server.mjs',
    '/data/fikratak.sqlite',
    '/data/',
    '/data/fikratak.db',
    '/data/fikratak.sqlite3',
    '/data/fikratak.sqlite-wal',
    '/data/fikratak.sqlite-shm',
    '/backups/',
    '/backups/backup.sqlite',
    '/backups/backup.sqlite-wal',
    '/backups/backup.sqlite-shm',
    '/backups/backup.db',
    '/backups/backup.sqlite3',
    '/docs/DEPLOYMENT_RUNBOOK.md',
    '/docs/',
    '/.env',
    '/.git/config',
    '/assets/admin.css.map',
    '/tests/production-hardening.test.mjs',
    '/README.md',
    '/assets/../server.mjs'
  ]) {
    assert.equal((await fetch(new URL(path, baseUrl))).status, 404, `${path} must not be publicly served`);
  }
});
