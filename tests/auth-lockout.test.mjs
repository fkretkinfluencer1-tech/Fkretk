import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { requestAddress } from '../security/request-address.mjs';

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

test('only a trusted loopback peer can supply the forwarded client address', () => {
  const trusted = new Set(['127.0.0.1', '10.0.0.2']);
  const createRequest = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers });

  assert.equal(requestAddress(createRequest('127.0.0.1', {
    'x-forwarded-for': '198.51.100.12', 'x-real-ip': '198.51.100.13'
  }), trusted), '198.51.100.12');
  assert.equal(requestAddress(createRequest('192.0.2.2', {
    'x-forwarded-for': '198.51.100.12', 'x-real-ip': '198.51.100.13'
  }), trusted), '192.0.2.2');
  assert.equal(requestAddress(createRequest('10.0.0.2', {
    'x-forwarded-for': '198.51.100.12', 'x-real-ip': '198.51.100.13'
  }), trusted), '10.0.0.2');
  assert.equal(requestAddress(createRequest('127.0.0.1', {
    'x-forwarded-for': '198.51.100.12, 203.0.113.8'
  }), trusted), '127.0.0.1');
});

test('configurable login lockout applies independently to internal and client portal login', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-auth-lockout-'));
  const dataDir = join(tempDir, 'data');
  const backupDir = join(tempDir, 'backups');
  await Promise.all([mkdir(dataDir), mkdir(backupDir)]);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      FIKRATAK_HOST: '127.0.0.1',
      FIKRATAK_DATA_DIR: dataDir,
      FIKRATAK_BACKUP_DIR: backupDir,
      FIKRATAK_TRUSTED_PROXIES: '127.0.0.1',
      FIKRATAK_LOGIN_MAX_ATTEMPTS: '2',
      FIKRATAK_LOGIN_LOCKOUT_MINUTES: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await once(server, 'exit');
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Lockout test server stopped: ${serverOutput}`);
    try { ready = (await fetch(baseUrl)).status === 200; } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, `Lockout test server did not start: ${serverOutput}`);

  const login = async (endpoint, username, password, forwardedFor) => fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'content-type': 'application/json',
      'x-forwarded-for': forwardedFor
    },
    body: JSON.stringify({ username, email: username, password })
  });
  const noUsers = await login('/api/login', 'unknown-user', 'synthetic-password', '198.51.100.20');
  assert.equal(noUsers.status, 409);
  assert.deepEqual(await noUsers.json(), {
    code: 'SETUP_REQUIRED',
    error: 'لا يوجد مستخدمون بعد، شغّل الإعداد الأولي.'
  });
  const loginPage = await fetch(baseUrl).then((response) => response.text());
  assert.match(loginPage, /No users exist yet\. Run setup\./);
  assert.match(loginPage, /Locked, try again in/);

  const setup = await fetch(`${baseUrl}/api/setup`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'test-admin', password: 'Synthetic-admin-password-2026!' })
  });
  assert.equal(setup.status, 201);

  const internalIp = '198.51.100.20';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await login('/api/login', 'test-admin', 'wrong-password-sentinel', internalIp)).status, 401);
  }
  const internalLocked = await login('/api/login', 'test-admin', 'wrong-password-sentinel', internalIp);
  assert.equal(internalLocked.status, 429);
  const internalLockBody = await internalLocked.json();
  assert.equal(internalLockBody.code, 'LOGIN_LOCKED');
  assert.match(internalLockBody.error, /1 دقيقة/);
  assert.equal(internalLockBody.retryAfter, 60);
  assert.equal((await login('/api/login', 'test-admin', 'wrong-password-sentinel', '198.51.100.21')).status, 401);

  const clientIp = '198.51.100.30';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.equal((await login('/api/client-portal/login', 'unknown-client', 'wrong-password-sentinel', clientIp)).status, 401);
  }
  const clientLocked = await login('/api/client-portal/login', 'unknown-client', 'wrong-password-sentinel', clientIp);
  assert.equal(clientLocked.status, 429);
  assert.equal((await clientLocked.json()).retryAfter, 60);
  assert.equal((await login('/api/client-portal/login', 'unknown-client', 'wrong-password-sentinel', '198.51.100.31')).status, 401);

  assert.match(serverOutput, /"event":"auth\.login"/);
  assert.match(serverOutput, /"outcome":"no_users"/);
  assert.match(serverOutput, /"outcome":"bad_credentials"/);
  assert.ok(!serverOutput.includes('wrong-password-sentinel'));
  assert.ok(!serverOutput.includes('Synthetic-admin-password-2026!'));
});
