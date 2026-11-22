import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { assertSafeDbPath } from './db-guard.mjs';

const projectDir = new URL('..', import.meta.url);
const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-audit-security-'));
const dataDir = join(tempDir, 'data');
const backupDir = join(tempDir, 'backups');
assertSafeDbPath(join(dataDir, 'fikratak.sqlite'), 'test database');
await mkdir(dataDir, { recursive: true });
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', resolve);
});
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));

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
server.stderr.on('data', chunk => { serverErrors += chunk.toString(); });
const baseUrl = `http://127.0.0.1:${port}`;
let ready = false;
for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
  if (server.exitCode !== null) throw new Error(`Test server stopped: ${serverErrors}`);
  try { ready = (await fetch(baseUrl)).status === 200; } catch {}
  if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
}
if (!ready) throw new Error(`Test server did not start: ${serverErrors}`);

const adminCredentials = { username: 'audit-admin', password: 'Audit-test-password-2026!' };
const setup = await fetch(`${baseUrl}/api/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(adminCredentials)
});
assert.equal(setup.status, 201);
const adminCookie = setup.headers.get('set-cookie')?.split(';')[0];
assert.ok(adminCookie);
const confirmation = {
  confirmationUsername: adminCredentials.username,
  confirmationPassword: adminCredentials.password
};

async function call(path, { cookie = adminCookie, ...options } = {}) {
  let requestOptions = options;
  if (path === '/api/import' && String(options.method || 'GET').toUpperCase() === 'POST'
    && options.body && typeof options.body === 'object' && !options.body.previewId) {
    const previewResponse = await fetch(`${baseUrl}/api/import/preview`, {
      method: 'POST',
      body: JSON.stringify(options.body),
      headers: {
        ...(cookie ? { cookie } : {}),
        'content-type': 'application/json',
        ...options.headers
      }
    });
    const previewBody = await previewResponse.json().catch(() => ({}));
    if (!previewResponse.ok) return { response: previewResponse, body: previewBody };
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
      ...(cookie ? { cookie } : {}),
      ...(requestOptions.body ? { 'content-type': 'application/json' } : {}),
      ...requestOptions.headers
    }
  });
  return { response, body: await response.json().catch(() => ({})) };
}

async function mustCall(path, options = {}) {
  const result = await call(path, options);
  assert.ok(result.response.ok, `${path}: ${result.response.status} ${JSON.stringify(result.body)} ${serverErrors}`);
  return result.body;
}

async function login(username, password) {
  const result = await call('/api/login', { cookie: '', method: 'POST', body: { username, password } });
  assert.equal(result.response.status, 200);
  return result.response.headers.get('set-cookie')?.split(';')[0];
}

after(async () => {
  if (server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
  await rm(tempDir, { recursive: true, force: true });
});

test('company identity is independent from login and audit entries retain safe before/after values', async () => {
  const identity = await mustCall('/api/system-identity');
  assert.equal(identity.identity.email, 'fkretkinfluencer1@gmail.com');

  const created = await mustCall('/api/influencers', {
    method: 'POST',
    body: {
      Name: 'Audit Fixture Creator', 'Username I': 'audit_fixture_creator',
      'Followers Count I': '12000', 'Country Code': '+966',
      Number: '555000456', Full_Mobile_Number: '+966555000456'
    }
  });
  const createEvent = (await mustCall('/api/audit?action=influencer.create&q=Audit%20Fixture')).rows[0];
  assert.equal(createEvent.entityType, 'influencer');
  assert.equal(createEvent.entityId, created.record.id);
  await mustCall(`/api/influencers/${created.record.id}`, {
    method: 'PUT',
    body: { ...created.record, Name: 'Audit Fixture Updated' }
  });

  const filtered = await mustCall('/api/audit?user=audit-admin&action=influencer.update&q=Audit%20Fixture');
  assert.equal(filtered.total, 1);
  const event = filtered.rows[0];
  assert.equal(event.username, 'audit-admin');
  assert.equal(event.role, 'admin');
  assert.equal(event.outcome, 'success');
  assert.equal(event.oldValues.record.Name, 'Audit Fixture Creator');
  assert.equal(event.newValues.record.Name, 'Audit Fixture Updated');
  for (const values of [event.oldValues.record, event.newValues.record]) {
    assert.equal('Number' in values, false);
    assert.equal('Country Code' in values, false);
    assert.equal('Full_Mobile_Number' in values, false);
  }
  const detail = await mustCall(`/api/audit/${event.id}`);
  assert.equal(detail.event.id, event.id);
  assert.ok(detail.event.occurredAt);
  const auditDb = new DatabaseSync(join(dataDir, 'fikratak.sqlite'), { readOnly: true });
  const allAuditJson = auditDb.prepare('SELECT old_values_json, new_values_json FROM audit_events').all().map(row => JSON.stringify(row)).join('\n');
  auditDb.close();
  assert.equal(allAuditJson.includes(adminCredentials.password), false);
});

test('failed mutations are rolled back and recorded as failures', async () => {
  const invalid = await call('/api/import', { method: 'POST', body: {} });
  assert.equal(invalid.response.status, 400);
  const event = (await mustCall('/api/audit?action=influencers.import')).rows[0];
  assert.equal(event.outcome, 'failure');
  assert.equal(event.status, invalid.response.status);
  assert.equal(event.newValues.httpStatus, invalid.response.status);

  const auditDb = new DatabaseSync(join(dataDir, 'fikratak.sqlite'));
  const before = auditDb.prepare('SELECT COUNT(*) AS count FROM influencers').get().count;
  auditDb.exec(`CREATE TRIGGER reject_audit_insert BEFORE INSERT ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit persistence unavailable'); END;`);
  auditDb.close();

  const rejected = await call('/api/influencers', {
    method: 'POST',
    body: { Name: 'Must Roll Back Creator', 'Username I': 'must_rollback_creator' }
  });
  assert.equal(rejected.response.status, 503);
  assert.match(rejected.body.error, /لم يتم اعتماد تغييرات قاعدة البيانات/);

  const verifyDb = new DatabaseSync(join(dataDir, 'fikratak.sqlite'));
  assert.equal(verifyDb.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, before);
  assert.equal(verifyDb.prepare(`SELECT COUNT(*) AS count FROM influencers
    WHERE record_json LIKE '%Must Roll Back Creator%'`).get().count, 0);
  verifyDb.exec('DROP TRIGGER reject_audit_insert');
  verifyDb.close();
});

test('every data export requires admin role and password confirmation on that request', async () => {
  const missing = await call('/api/export', { method: 'POST', body: {} });
  assert.equal(missing.response.status, 403);
  const wrongPassword = await call('/api/export', {
    method: 'POST',
    body: { ...confirmation, confirmationPassword: 'Incorrect-test-password-2026!' }
  });
  assert.equal(wrongPassword.response.status, 403);
  const differentUsername = await call('/api/export', {
    method: 'POST',
    body: { ...confirmation, confirmationUsername: 'another-admin' }
  });
  assert.equal(differentUsername.response.status, 403);
  assert.equal('rows' in wrongPassword.body, false);
  assert.equal('rows' in differentUsername.body, false);

  const editorPassword = 'Editor-audit-test-2026!';
  const viewerPassword = 'Viewer-audit-test-2026!';
  await mustCall('/api/users', { method: 'POST', body: { username: 'audit-editor', password: editorPassword, role: 'editor' } });
  await mustCall('/api/users', { method: 'POST', body: { username: 'audit-viewer', password: viewerPassword, role: 'viewer' } });
  const editorCookie = await login('audit-editor', editorPassword);
  const viewerCookie = await login('audit-viewer', viewerPassword);
  for (const cookie of [editorCookie, viewerCookie]) {
    const denied = await call('/api/export', { cookie, method: 'POST', body: confirmation });
    assert.equal(denied.response.status, 403);
  }

  const exported = await mustCall('/api/export', { method: 'POST', body: confirmation });
  assert.equal(exported.rows.length, 1);
  const protectedExports = [
    '/api/legacy-export',
    '/api/influencers/export',
    `/api/campaigns/${'a'.repeat(32)}/export`,
    `/api/client-catalogs/${'b'.repeat(32)}/export`,
    `/api/campaigns/${'c'.repeat(32)}/targets/${'d'.repeat(32)}/qr-export`
  ];
  for (const path of protectedExports) {
    const denied = await call(path, { method: 'POST', body: {} });
    assert.equal(denied.response.status, 403, `${path} must require per-operation confirmation`);
    assert.equal('rows' in denied.body, false);
    const confirmed = await call(path, {
      method: 'POST',
      body: { ...confirmation, recordCount: 1 }
    });
    assert.notEqual(confirmed.response.status, 403, `${path} must accept the same user's valid confirmation`);
  }
  const filteredExport = await mustCall('/api/influencers/export', { method: 'POST', body: confirmation });
  assert.equal(filteredExport.rows.length, 1);
  const exportEvent = (await mustCall('/api/audit?action=data.export')).rows[0];
  assert.equal(exportEvent.username, 'audit-admin');
  assert.equal(exportEvent.outcome, 'success');
  assert.equal(exportEvent.newValues.exportType, '/api/influencers/export');
  assert.equal(exportEvent.newValues.rowCount, 1);
  const deniedEvent = (await mustCall('/api/audit?action=data.export')).rows
    .find(event => event.outcome === 'failure' && event.status === 403
      && event.newValues.exportType.endsWith('/targets/dddddddddddddddddddddddddddddddd/qr-export'));
  assert.ok(deniedEvent);
  assert.equal(deniedEvent.outcome, 'failure');
  const auditDb = new DatabaseSync(join(dataDir, 'fikratak.sqlite'), { readOnly: true });
  const auditJson = auditDb.prepare('SELECT old_values_json, new_values_json FROM audit_events')
    .all().map(row => JSON.stringify(row)).join('\n');
  auditDb.close();
  assert.equal(auditJson.includes(adminCredentials.password), false);
  assert.equal(auditJson.includes('confirmationUsername'), false);

  for (const cookie of [editorCookie, viewerCookie]) {
    assert.equal((await call('/api/audit', { cookie })).response.status, 403);
  }
  assert.equal((await call('/api/audit', { cookie: '' })).response.status, 401);
  assert.equal((await call(`/api/audit/${exportEvent.id}`, { method: 'DELETE' })).response.status, 404);

  const firstConflict = await mustCall('/api/influencers', {
    method: 'POST',
    body: { Name: 'Conflict Fixture One', 'Username T': 'unique_fixture_tiktok_one' }
  });
  const secondConflict = await mustCall('/api/influencers', {
    method: 'POST',
    body: { Name: 'Conflict Fixture Two', 'Username T': 'unique_fixture_tiktok_two' }
  });
  const conflictDb = new DatabaseSync(join(dataDir, 'fikratak.sqlite'));
  for (const { name } of conflictDb.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'influencers'"
  ).all()) {
    conflictDb.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  }
  for (const { name } of conflictDb.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'influencers' AND sql IS NOT NULL"
  ).all()) {
    conflictDb.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
  }
  const updateAccount = conflictDb.prepare('UPDATE influencers SET record_json = ? WHERE id = ?');
  for (const record of [firstConflict.record, secondConflict.record]) {
    record['Username T'] = 'shared_conflict_fixture';
    updateAccount.run(JSON.stringify(record), record.id);
  }
  conflictDb.close();

  const report = await mustCall('/api/account-conflicts');
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].platform, 'TikTok');
  assert.equal(report.groups[0].username, 'shared_conflict_fixture');
  assert.deepEqual(report.groups[0].influencers.map(item => item.id).sort(),
    [firstConflict.record.id, secondConflict.record.id].sort());
  assert.deepEqual(report.groups[0].influencers.map(item => item.name).sort(),
    ['Conflict Fixture One', 'Conflict Fixture Two']);
  for (const cookie of [editorCookie, viewerCookie, '']) {
    assert.equal((await call('/api/account-conflicts', { cookie })).response.status, cookie ? 403 : 401);
    const denied = await call('/api/account-conflicts/export', { cookie, method: 'POST', body: confirmation });
    assert.equal(denied.response.status, cookie ? 403 : 401);
    assert.equal('rows' in denied.body, false);
  }
  const unconfirmed = await call('/api/account-conflicts/export', { method: 'POST', body: {} });
  assert.equal(unconfirmed.response.status, 403);
  const reportExport = await mustCall('/api/account-conflicts/export', { method: 'POST', body: confirmation });
  assert.equal(reportExport.rows.length, 2);
  assert.ok(reportExport.rows.every(row => row.Platform === 'TikTok'
    && row.Username === 'shared_conflict_fixture'
    && ['Conflict Fixture One', 'Conflict Fixture Two'].includes(row['Influencer Name'])));
  const conflictExportAudit = (await mustCall('/api/audit?action=data.export')).rows
    .find(event => event.newValues.exportType === '/api/account-conflicts/export');
  assert.ok(conflictExportAudit);
  assert.equal(conflictExportAudit.outcome, 'success');
  assert.equal(conflictExportAudit.newValues.rowCount, 2);
});

test('backup creation also requires a fresh confirmation and is audited', async () => {
  const filesBeforeDeniedRequests = await readdir(backupDir).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const denied = await call('/api/backups/create', { method: 'POST', body: {} });
  assert.equal(denied.response.status, 403);
  assert.equal('file' in denied.body, false);
  assert.deepEqual(await readdir(backupDir), filesBeforeDeniedRequests);
  const created = await mustCall('/api/backups/create', { method: 'POST', body: confirmation });
  assert.equal(created.ok, true);
  const backupEvent = (await mustCall('/api/audit?action=backup.create&user=audit-admin')).rows[0];
  assert.equal(backupEvent.outcome, 'success');
  assert.equal(backupEvent.username, 'audit-admin');
  assert.equal(backupEvent.newValues.backupType, 'database');
  const failedBackupEvent = (await mustCall('/api/audit?action=backup.create')).rows
    .find(event => event.outcome === 'failure' && event.status === 403 && event.newValues.backupType === 'database');
  assert.ok(failedBackupEvent);
  assert.equal(failedBackupEvent.outcome, 'failure');
  assert.equal(failedBackupEvent.newValues.backupType, 'database');
  const filesBeforeDeniedExcel = await readdir(backupDir);
  const deniedExcel = await call('/api/backups/influencers/create', { method: 'POST', body: {} });
  assert.equal(deniedExcel.response.status, 403);
  assert.equal('path' in deniedExcel.body, false);
  assert.deepEqual(await readdir(backupDir), filesBeforeDeniedExcel);
  const excelEvent = (await mustCall('/api/audit?action=backup.create')).rows
    .find(event => event.outcome === 'failure' && event.status === 403
      && event.newValues.backupType === 'influencer_excel');
  assert.ok(excelEvent);
  assert.equal(excelEvent.newValues.backupType, 'influencer_excel');
  const stored = new DatabaseSync(join(dataDir, 'fikratak.sqlite'), { readOnly: true });
  assert.equal(stored.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  stored.close();
});

test('an Excel backup is restored if its required audit event cannot be saved', async () => {
  const workbookPath = join(tempDir, 'backups', 'Fikratak_Influencers.xlsx');
  const statusPath = join(tempDir, 'backups', 'Fikratak_Influencers.status.json');
  const lockPath = join(tempDir, 'backups', '.Fikratak_Influencers.xlsx.lock');
  const readIfPresent = async path => {
    try { return await readFile(path); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  for (let attempt = 0; attempt < 100 && await readIfPresent(lockPath); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await readIfPresent(lockPath), null);
  const previousWorkbook = await readIfPresent(workbookPath);
  const previousStatus = await readIfPresent(statusPath);
  const auditDb = new DatabaseSync(join(dataDir, 'fikratak.sqlite'));
  auditDb.exec(`CREATE TRIGGER reject_excel_backup_audit BEFORE INSERT ON audit_events
    WHEN NEW.action = 'backup.create'
    BEGIN SELECT RAISE(ABORT, 'audit persistence unavailable'); END;`);
  auditDb.close();

  const result = await call('/api/backups/influencers/create', { method: 'POST', body: confirmation });
  assert.equal(result.response.status, 503);
  assert.deepEqual(await readIfPresent(workbookPath), previousWorkbook);
  assert.deepEqual(await readIfPresent(statusPath), previousStatus);

  const cleanupDb = new DatabaseSync(join(dataDir, 'fikratak.sqlite'));
  cleanupDb.exec('DROP TRIGGER reject_excel_backup_audit');
  cleanupDb.close();
});
