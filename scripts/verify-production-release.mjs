import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readdir, readFile, rm, stat, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createXlsxWorkbook } from '../data-access/xlsx-workbook.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = process.argv[2] ? resolve(projectDir, process.argv[2]) : join(projectDir, 'production-release');
const requiredFiles = [
  'server.mjs',
  'campaign-presentation.html',
  'assets/presentation.css',
  'scripts/create-first-admin.mjs',
  'scripts/create-production-admin.mjs',
  'scripts/sqlite-backup.mjs',
  'scripts/backup-offsite.sh',
  'scripts/restore-offsite.sh',
  'data-access/sqlite.mjs',
  'docs/DEPLOYMENT_RUNBOOK.md',
  'influencer-template.csv',
  'fikratak-influencers-template-3000.xlsx'
];
const testOnlyFiles = [
  'scripts/verify-production-release.mjs',
  'scripts/verify-linux-operations.sh'
];
const manifest = JSON.parse(await readFile(join(releaseDir, '.production-release-manifest.json'), 'utf8'));
assert.equal(manifest.generatedBy, 'scripts/create-production-release.mjs');
assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
assert.equal(manifest.sourceCommit, execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: projectDir, encoding: 'utf8'
}).trim());
assert.deepEqual(manifest.outOfZipDocuments, ['HOSTING-SETUP-AR.md']);
assert.ok(!manifest.files.includes('HOSTING-SETUP-AR.md'));
assert.ok(!manifest.files.includes('production-release.zip'));
assert.ok(!manifest.files.includes('SHA256SUMS.txt'));
assert.ok(manifest.files.every((path) => !path.includes('\\') && !path.startsWith('/')));
for (const path of requiredFiles) {
  assert.ok(manifest.files.includes(path), `Release manifest is missing ${path}.`);
  await stat(join(releaseDir, path));
}
for (const path of testOnlyFiles) {
  assert.ok(!manifest.files.includes(path), `A development verifier must not ship: ${path}.`);
  await assert.rejects(stat(join(releaseDir, path)), { code: 'ENOENT' });
}
for (const path of manifest.files) await stat(join(releaseDir, path));
assert.ok(!manifest.files.some((path) => /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)));

const secretScanCounts = { privateKeyBlocks: 0, credentialLiterals: 0 };
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu;
const credentialPattern = /\b(?:password|passwd|secret|api[_-]?key|private[_-]?key|access[_-]?token)\b\s*[:=]\s*(['"])([^'"\r\n]{8,})\1/giu;

async function assertCleanRelease(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    assert.ok(![
      'data', 'backups', 'artifacts', 'influencer-data-collector', 'follower-sync-lab',
      'test', 'tests', '__tests__'
    ].includes(entry.name.toLocaleLowerCase()),
      `A data, backup, or test directory must not ship: ${path}`);
    if (entry.isDirectory()) {
      await assertCleanRelease(path);
      continue;
    }
    assert.doesNotMatch(entry.name, /\.(?:sqlite(?:-(?:shm|wal))?|db|bak|backup|log|map)$/i,
      `A database, backup, log, or source map must not ship: ${path}`);
    if (/^(?!\.env\.example$)\.env(?:\.|$)/i.test(entry.name)) {
      assert.fail(`A real environment file must not ship: ${path}`);
    }
    const contents = (await readFile(path)).toString('latin1');
    secretScanCounts.privateKeyBlocks += [...contents.matchAll(privateKeyPattern)].length;
    secretScanCounts.credentialLiterals += [...contents.matchAll(credentialPattern)].length;
  }
}
await assertCleanRelease(releaseDir);
assert.equal(secretScanCounts.privateKeyBlocks, 0, 'Secret scan found private key blocks.');
assert.equal(secretScanCounts.credentialLiterals, 0, 'Secret scan found credential literals.');

const releasePackage = JSON.parse(await readFile(join(releaseDir, 'package.json'), 'utf8'));
assert.ok(!Object.hasOwn(releasePackage.scripts, 'test'));
assert.ok(!Object.hasOwn(releasePackage.scripts, 'verify:release'));
assert.equal(releasePackage.engines.node, '>=24');
assert.deepEqual(releasePackage.dependencies || {}, {});
assert.deepEqual(releasePackage.devDependencies || {}, {});
assert.match(releasePackage.scripts.start, /start-production/);
const startupScript = await readFile(join(releaseDir, 'start-production.sh'), 'utf8');
assert.match(startupScript, /server\.mjs/);
const serverSource = await readFile(join(releaseDir, 'server.mjs'), 'utf8');
for (const requiredEnginePart of [
  'Username Tiktok',
  'Username Snapchat',
  'Username Instagram',
  'phone-number-changed-needs-review',
  'identity-conflict',
  'duplicate-account-in-file',
  'importBlocked: true',
  'UNIQUE (platform, normalized_username)',
  'import_batches',
  'undo_data_json',
  'importUndoMatch'
]) {
  assert.ok(serverSource.includes(requiredEnginePart), `Release server is missing an importer invariant: ${requiredEnginePart}.`);
}
const managementHtml = await readFile(join(releaseDir, 'index.html'), 'utf8');
assert.match(managementHtml, /توقف الاستيراد: أعمدة غير معروفة/);
assert.doesNotMatch(managementHtml, /import-account-match-approve|import-account-matches-panel/,
  'The obsolete account-match approval UI must not be reintroduced.');

const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-release-smoke-'));
const dataDir = join(tempDir, 'clean-data');
const backupDir = join(tempDir, 'backups');
const cliDatabasePath = join(tempDir, 'first-admin-cli.sqlite');
await assert.rejects(stat(dataDir), { code: 'ENOENT' });
async function unusedPort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const selectedPort = probe.address().port;
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return selectedPort;
}
async function waitForReady(child, url, readErrors) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Release server exited: ${readErrors()}`);
    try {
      if ((await fetch(url)).status === 200) return;
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Release server did not start: ${readErrors()}`);
}
async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}
async function verifyMissingRequiredEnvironment() {
  const port = await unusedPort();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    FIKRATAK_HOST: '127.0.0.1',
    FIKRATAK_BACKUP_DIR: join(tempDir, 'missing-env-backups'),
    FIKRATAK_ALLOWED_ORIGINS: 'https://crm.example.test',
    FIKRATAK_SETUP_TOKEN: randomBytes(32).toString('hex')
  };
  delete env.FIKRATAK_DATA_DIR;
  const child = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
    cwd: releaseDir, env, stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(errors, /FIKRATAK_DATA_DIR must be an absolute path outside the application directory/u);
}
const port = await unusedPort();
await verifyMissingRequiredEnvironment();
const baseUrl = `http://127.0.0.1:${port}`;
const setupToken = randomBytes(32).toString('hex');
const adminUsername = `release-admin-${randomBytes(6).toString('hex')}`;
const adminPassword = `${randomBytes(32).toString('base64url')}${randomBytes(2).toString('hex')}!A`;
const server = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
  cwd: releaseDir,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    FIKRATAK_HOST: '127.0.0.1',
    FIKRATAK_DATA_DIR: dataDir,
    FIKRATAK_BACKUP_DIR: backupDir,
    FIKRATAK_ALLOWED_ORIGINS: 'https://crm.example.test',
    FIKRATAK_SETUP_TOKEN: setupToken,
    FIKRATAK_IMPORT_ENABLED: '1',
    FIKRATAK_LOGIN_MAX_ATTEMPTS: '6',
    FIKRATAK_LOGIN_LOCKOUT_MINUTES: '10'
  },
  stdio: ['ignore', 'ignore', 'pipe']
});
let serverErrors = '';
server.stderr.on('data', (chunk) => { serverErrors += chunk.toString(); });

try {
  await waitForReady(server, baseUrl, () => serverErrors);

  const database = new DatabaseSync(join(dataDir, 'fikratak.sqlite'), { readOnly: true });
  try {
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of ['users', 'influencers', 'influencer_accounts', 'import_batches', 'campaigns', 'client_accounts', 'interest_catalog']) {
      assert.ok(tables.has(table), `Fresh database schema is missing ${table}.`);
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, 0);
  } finally {
    database.close();
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dataDir, 'fikratak.sqlite')).mode & 0o777), 0o600);
  }

  const cliDb = new DatabaseSync(cliDatabasePath);
  cliDb.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL,
    password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL
  )`);
  cliDb.close();
  const { createFirstAdmin } = await import(pathToFileURL(join(releaseDir, 'scripts/create-first-admin.mjs')).href);
  const cliUsername = `cli-admin-${randomBytes(6).toString('hex')}`;
  const cliPassword = `${randomBytes(32).toString('base64url')}${randomBytes(2).toString('hex')}!B`;
  const cliAdmin = await createFirstAdmin(cliDatabasePath, cliUsername, cliPassword);
  assert.equal(cliAdmin.username, cliUsername);
  await assert.rejects(createFirstAdmin(cliDatabasePath, `second-${randomBytes(6).toString('hex')}`, cliPassword),
    /already contains users/);

  const headers = {
    origin: 'https://crm.example.test',
    host: 'crm.example.test',
    'content-type': 'application/json'
  };
  const wrongSetup = await fetch(`${baseUrl}/api/setup`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: adminUsername, password: adminPassword, setupToken: 'incorrect-token' })
  });
  assert.equal(wrongSetup.status, 403);
  const setup = await fetch(`${baseUrl}/api/setup`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: adminUsername, password: adminPassword, setupToken })
  });
  assert.equal(setup.status, 201, await setup.text());
  const setCookie = setup.headers.get('set-cookie') || '';
  assert.match(setCookie, /;\s*Secure(?:;|$)/i);
  assert.match(setCookie, /;\s*HttpOnly(?:;|$)/i);
  assert.match(setCookie, /;\s*SameSite=Strict(?:;|$)/i);
  assert.ok(setCookie.split(';')[0]);
  const secondSetup = await fetch(`${baseUrl}/api/setup`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: `stranger-${randomBytes(6).toString('hex')}`, password: adminPassword, setupToken })
  });
  assert.equal(secondSetup.status, 409);
  const login = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: adminUsername, password: adminPassword })
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  async function call(path, body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { ...headers, cookie },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  }
  async function fetchApi(path, {
    method = 'GET', body, session = cookie, url = baseUrl, origin = headers.origin, host = headers.host
  } = {}) {
    const requestHeaders = { origin, host };
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';
    if (session) requestHeaders.cookie = session;
    const response = await fetch(`${url}${path}`, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch {}
    return { response, body: payload, text };
  }
  const loginPage = await fetch(`${baseUrl}/`);
  assert.equal(loginPage.status, 200);
  const loginHtml = await loginPage.text();
  const contactNote = '<p class="auth-contact-note">تواصل مع مدير النظام</p>';
  const contactNotePosition = loginHtml.indexOf(contactNote);
  assert.notEqual(contactNotePosition, -1);
  for (const match of loginHtml.matchAll(/<(a|button)\b[^>]*>[\s\S]*?<\/\1>/giu)) {
    const elementEnd = match.index + match[0].length;
    assert.ok(contactNotePosition < match.index || contactNotePosition >= elementEnd,
      'The system-administrator note must not be inside an interactive element.');
  }
  const protectedPaths = [
    '/data/', '/backups/', '/.env', '/server.mjs',
    '/data/fikratak.sqlite', '/data/fikratak.sqlite-wal', '/data/fikratak.sqlite-shm'
  ];
  for (const path of protectedPaths) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.ok([403, 404].includes(response.status), `Sensitive static path was reachable: ${path}`);
  }
  async function verifyImportClosedByDefault() {
    const disabledPort = await unusedPort();
    const disabledUrl = `http://127.0.0.1:${disabledPort}`;
    const disabledSetupToken = randomBytes(32).toString('hex');
    const disabledHeaders = {
      origin: headers.origin, host: `crm.example.test`, 'content-type': 'application/json'
    };
    const disabledEnv = {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(disabledPort),
      FIKRATAK_HOST: '127.0.0.1',
      FIKRATAK_DATA_DIR: join(tempDir, 'default-import-data'),
      FIKRATAK_BACKUP_DIR: join(tempDir, 'default-import-backups'),
      FIKRATAK_ALLOWED_ORIGINS: headers.origin,
      FIKRATAK_SETUP_TOKEN: disabledSetupToken,
      FIKRATAK_LOGIN_MAX_ATTEMPTS: '6',
      FIKRATAK_LOGIN_LOCKOUT_MINUTES: '10'
    };
    delete disabledEnv.FIKRATAK_IMPORT_ENABLED;
    const disabledServer = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
      cwd: releaseDir, env: disabledEnv, stdio: ['ignore', 'ignore', 'pipe']
    });
    let disabledErrors = '';
    disabledServer.stderr.on('data', (chunk) => { disabledErrors += chunk.toString(); });
    try {
      await waitForReady(disabledServer, disabledUrl, () => disabledErrors);
      const username = `release-default-${randomBytes(6).toString('hex')}`;
      const password = `${randomBytes(32).toString('base64url')}!D`;
      const response = await fetch(`${disabledUrl}/api/setup`, {
        method: 'POST', headers: disabledHeaders,
        body: JSON.stringify({ username, password, setupToken: disabledSetupToken })
      });
      assert.equal(response.status, 201);
      const session = (response.headers.get('set-cookie') || '').split(';')[0];
      assert.ok(session);
      const importStatus = await fetch(`${disabledUrl}/api/import/status`, {
        headers: { ...disabledHeaders, cookie: session }
      });
      assert.deepEqual(await importStatus.json(), { paused: true });
      const importPreview = await fetch(`${disabledUrl}/api/import/preview`, {
        method: 'POST',
        headers: { ...disabledHeaders, cookie: session },
        body: JSON.stringify({ rows: [], fileName: 'synthetic.csv', fileBase64: '' })
      });
      assert.equal(importPreview.status, 503);
    } finally {
      await stopChild(disabledServer);
    }
  }
  await verifyImportClosedByDefault();
  async function commit(rows, name, bytes, { confirmAllNew = false } = {}) {
    const payload = {
      rows,
      fileName: name,
      fileBase64: bytes,
      confirmAllNew
    };
    const preview = await call('/api/import/preview', payload);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const result = await call('/api/import', { ...payload, previewId: preview.body.preview.previewId });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  }

  const status = await fetch(`${baseUrl}/api/import/status`, { headers: { ...headers, cookie } }).then((response) => response.json());
  assert.deepEqual(status, { paused: false });
  const csvTemplate = (await readFile(join(releaseDir, 'influencer-template.csv'), 'utf8')).replace(/^\uFEFF/, '');
  const headerLine = csvTemplate.split(/\r?\n/u, 1)[0];
  const canonicalHeaders = headerLine.slice(1, -1).split('","');
  assert.equal(canonicalHeaders.length, 36);
  assert.equal(canonicalHeaders[0], 'Name');
  const xlsxHeaders = [
    'Name',
    'Username I',
    ...canonicalHeaders.filter((header) => !['Name', 'Username I'].includes(header))
  ];
  const xlsxRow = {
    Name: 'Synthetic XLSX Template Check',
    'Username I': 'synthetic_xlsx_template_check'
  };
  const xlsxTemplateCheck = createXlsxWorkbook(xlsxHeaders, [
    xlsxHeaders.map((header) => xlsxRow[header] || '')
  ]);
  const xlsxPreview = await call('/api/import/preview', {
    fileName: 'synthetic-template-check.xlsx',
    fileBase64: xlsxTemplateCheck.toString('base64')
  });
  assert.equal(xlsxPreview.status, 200, JSON.stringify(xlsxPreview.body));
  assert.deepEqual(xlsxPreview.body.preview.unknownColumns, []);
  assert.equal(xlsxPreview.body.preview.integrity.creates, 1, JSON.stringify(xlsxPreview.body.preview));

  const unknownColumnRows = [{
    Name: 'Synthetic Unknown Column Check',
    'Username Instagram': 'synthetic_unknown_column_check',
    'Launch QA Unknown': 'must-block'
  }];
  const unknownColumnPayload = {
    rows: unknownColumnRows,
    fileName: 'synthetic-unknown-column.csv',
    fileBase64: Buffer.from('synthetic-unknown-column').toString('base64')
  };
  const unknownPreview = await call('/api/import/preview', unknownColumnPayload);
  assert.equal(unknownPreview.status, 200, JSON.stringify(unknownPreview.body));
  assert.deepEqual(unknownPreview.body.preview.unknownColumns, ['Launch QA Unknown']);
  assert.equal(unknownPreview.body.preview.importBlocked, true);
  const blockedUnknownCommit = await call('/api/import', {
    ...unknownColumnPayload,
    previewId: unknownPreview.body.preview.previewId
  });
  assert.equal(blockedUnknownCommit.status, 400);
  const emptyDb = new DatabaseSync(join(dataDir, 'fikratak.sqlite'), { readOnly: true });
  try { assert.equal(emptyDb.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, 0); }
  finally { emptyDb.close(); }

  const duplicateRows = [
    { Name: 'Synthetic Duplicate One', 'Username Instagram': 'duplicate_release_handle' },
    { Name: 'Synthetic Duplicate Two', 'Username Instagram': '@DUPLICATE_RELEASE_HANDLE' }
  ];
  const duplicateFile = {
    rows: duplicateRows,
    fileName: 'synthetic-duplicates.csv',
    fileBase64: Buffer.from('synthetic-duplicates').toString('base64')
  };
  const duplicatePreview = await call('/api/import/preview', duplicateFile);
  assert.equal(duplicatePreview.status, 200, JSON.stringify(duplicatePreview.body));
  assert.equal(duplicatePreview.body.preview.integrity.issues
    .filter((issue) => issue.reason === 'duplicate-account-in-file').length, 2);
  const duplicateCommit = await call('/api/import', {
    ...duplicateFile,
    previewId: duplicatePreview.body.preview.previewId,
    confirmAllNew: true
  });
  assert.equal(duplicateCommit.status, 200, JSON.stringify(duplicateCommit.body));
  assert.equal(duplicateCommit.body.created, 0);
  assert.equal(duplicateCommit.body.failed, 2);

  const headersRow = ['Name', 'City', 'Username Tiktok', 'Username Snapchat', 'Username Instagram'];
  const initialCity = 'Synthetic Riyadh';
  const changedCity = 'Synthetic Jeddah';
  function syntheticRows(city) {
    return Array.from({ length: 3000 }, (_, index) => ({
      Name: `Synthetic Creator ${String(index + 1).padStart(4, '0')}`,
      City: city,
      'Username Tiktok': `synthetic_tiktok_${index + 1}`,
      'Username Snapchat': `synthetic_snap_${index + 1}`,
      'Username Instagram': `synthetic_inst_${index + 1}`
    }));
  }
  function csvFor(rows) {
    const cell = (value) => {
      const text = String(value ?? '');
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    return [headersRow, ...rows.map((row) => headersRow.map((header) => row[header] ?? ''))]
      .map((row) => row.map(cell).join(',')).join('\r\n');
  }

  const sourceRows = syntheticRows(initialCity);
  const fileName = 'synthetic-first-import-3000.csv';
  const fileBase64 = Buffer.from(csvFor(sourceRows), 'utf8').toString('base64');
  const firstPreview = await call('/api/import/preview', { rows: sourceRows, fileName, fileBase64 });
  assert.equal(firstPreview.status, 200, JSON.stringify(firstPreview.body));
  assert.equal(firstPreview.body.preview.integrity.creates, 3000);
  assert.deepEqual(firstPreview.body.preview.unknownColumns, []);
  const first = await commit(sourceRows, fileName, fileBase64);
  assert.equal(first.created, 3000);
  assert.equal(first.updated, 0);
  assert.equal(first.failed, 0);

  const repeated = await commit(sourceRows, fileName, fileBase64);
  assert.equal(repeated.created, 0);
  assert.equal(repeated.updated, 0);
  assert.equal(repeated.unchanged, 3000);
  assert.equal(repeated.matchedByAccount, 3000);
  assert.equal(repeated.failed, 0);

  const changedAccountRows = sourceRows.slice(0, 100).map((row) => ({ ...row, City: 'Synthetic Account Update City' }));
  const changedAccountBytes = Buffer.from(csvFor(changedAccountRows), 'utf8').toString('base64');
  const accountPreview = await call('/api/import/preview', {
    rows: changedAccountRows, fileName: 'synthetic-account-update-100.csv', fileBase64: changedAccountBytes
  });
  assert.equal(accountPreview.status, 200, JSON.stringify(accountPreview.body));
  assert.equal(accountPreview.body.preview.integrity.matchedByAccount, 100);
  assert.equal(accountPreview.body.preview.integrity.updates, 100);
  const accountUpdate = await commit(changedAccountRows, 'synthetic-account-update-100.csv', changedAccountBytes);
  assert.equal(accountUpdate.created, 0);
  assert.equal(accountUpdate.updated, 100);
  assert.equal(accountUpdate.failed, 0);
  const accountUndo = await call(`/api/import/batches/${accountUpdate.batchId}/undo`, {});
  assert.equal(accountUndo.status, 200, JSON.stringify(accountUndo.body));
  assert.equal(accountUndo.body.undone, 100);

  const changedRows = syntheticRows(changedCity);
  const changedBytes = Buffer.from(csvFor(changedRows), 'utf8').toString('base64');
  const changed = await commit(changedRows, 'synthetic-changed-cities-3000.csv', changedBytes);
  assert.equal(changed.created, 0);
  assert.equal(changed.updated, 3000);
  assert.equal(changed.matchedByAccount, 3000);
  assert.equal(changed.failed, 0);

  const undoRows = [{ Name: 'Synthetic Undo Fixture', 'Username Instagram': 'synthetic_undo_fixture' }];
  const undoBatch = await commit(undoRows, 'synthetic-undo.csv',
    Buffer.from('synthetic-undo').toString('base64'), { confirmAllNew: true });
  assert.equal(undoBatch.created, 1);
  const undoResponse = await call(`/api/import/batches/${undoBatch.batchId}/undo`, {});
  assert.equal(undoResponse.status, 200, JSON.stringify(undoResponse.body));
  assert.equal(undoResponse.body.undone, 1);

  const checkDb = new DatabaseSync(join(dataDir, 'fikratak.sqlite'), { readOnly: true });
  try {
    const updated = checkDb.prepare("SELECT record_json FROM influencers WHERE json_extract(record_json, '$.Name') = ?")
      .get('Synthetic Creator 0002');
    assert.equal(JSON.parse(updated.record_json).City, changedCity);
    assert.ok(checkDb.prepare('SELECT COUNT(*) AS count FROM import_batches').get().count >= 5);
    const account = checkDb.prepare("SELECT influencer_id, normalized_username FROM influencer_accounts WHERE platform = 'TikTok' LIMIT 1").get();
    assert.ok(account);
    const writableCheck = new DatabaseSync(join(dataDir, 'fikratak.sqlite'));
    try {
      assert.throws(() => writableCheck.prepare(`INSERT INTO influencer_accounts
        (influencer_id, platform, normalized_username) VALUES (?, 'TikTok', ?)`)
        .run(account.influencer_id, account.normalized_username), /UNIQUE constraint failed/);
    } finally {
      writableCheck.close();
    }
  } finally {
    checkDb.close();
  }

  const editorUsername = `release-editor-${randomBytes(6).toString('hex')}`;
  const editorPassword = `${randomBytes(32).toString('base64url')}!E`;
  const viewerUsername = `release-viewer-${randomBytes(6).toString('hex')}`;
  const viewerPassword = `${randomBytes(32).toString('base64url')}!V`;
  const editorCreated = await fetchApi('/api/users', {
    method: 'POST', body: { username: editorUsername, role: 'editor', password: editorPassword }
  });
  assert.equal(editorCreated.response.status, 201);
  const viewerCreated = await fetchApi('/api/users', {
    method: 'POST', body: { username: viewerUsername, role: 'viewer', password: viewerPassword }
  });
  assert.equal(viewerCreated.response.status, 201);
  const editorLogin = await fetchApi('/api/login', {
    method: 'POST', session: '', body: { username: editorUsername, password: editorPassword }
  });
  assert.equal(editorLogin.response.status, 200);
  const editorCookie = (editorLogin.response.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(editorCookie);
  const viewerLogin = await fetchApi('/api/login', {
    method: 'POST', session: '', body: { username: viewerUsername, password: viewerPassword }
  });
  assert.equal(viewerLogin.response.status, 200);
  const viewerCookie = (viewerLogin.response.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(viewerCookie);
  const editorImport = {
    rows: [{ Name: 'Synthetic Editor Import', 'Username Instagram': 'release_editor_import' }],
    fileName: 'synthetic-editor-import.csv',
    fileBase64: Buffer.from('synthetic-editor-import').toString('base64'),
    confirmAllNew: true
  };
  const editorPreview = await fetchApi('/api/import/preview', {
    method: 'POST', session: editorCookie, body: editorImport
  });
  assert.equal(editorPreview.response.status, 200);
  const editorImportResult = await fetchApi('/api/import', {
    method: 'POST',
    session: editorCookie,
    body: { ...editorImport, previewId: editorPreview.body.preview.previewId }
  });
  assert.equal(editorImportResult.response.status, 200);
  assert.equal(editorImportResult.body.created, 1);
  const viewerPreview = await fetchApi('/api/import/preview', {
    method: 'POST', session: viewerCookie, body: editorImport
  });
  assert.equal(viewerPreview.response.status, 403);
  const viewerImport = await fetchApi('/api/import', {
    method: 'POST', session: viewerCookie, body: editorImport
  });
  assert.equal(viewerImport.response.status, 403);

  const presentationDb = new DatabaseSync(join(dataDir, 'fikratak.sqlite'), { readOnly: true });
  let presentationInfluencerId;
  try {
    presentationInfluencerId = presentationDb.prepare(
      "SELECT id FROM influencers WHERE json_extract(record_json, '$.Name') = ?"
    ).get('Synthetic Creator 0001')?.id;
  } finally {
    presentationDb.close();
  }
  assert.ok(presentationInfluencerId);
  const campaignResult = await fetchApi('/api/campaigns', {
    method: 'POST',
    body: {
      campaignName: 'Synthetic Release Presentation Campaign',
      companyName: 'Synthetic Release Company',
      campaignType: 'visit',
      serviceType: 'influencer',
      startDate: '2026-10-11',
      endDate: '2026-10-20',
      targets: [{
        id: presentationInfluencerId,
        visitDate: '2026-10-14',
        visitTime: '15:30',
        visitCity: 'Synthetic Riyadh',
        visitBranch: 'Synthetic Release Branch'
      }]
    }
  });
  assert.equal(campaignResult.response.status, 201);
  const campaignId = campaignResult.body.campaign.id;
  const clientResult = await fetchApi('/api/client-accounts', {
    method: 'POST',
    body: {
      username: 'synthetic-release-client',
      email: 'synthetic.release@example.test',
      clientName: 'Synthetic Release Client',
      companyName: 'Synthetic Release Company',
      password: `${randomBytes(32).toString('base64url')}!C`,
      campaignIds: [campaignId]
    }
  });
  assert.equal(clientResult.response.status, 201);
  const presentationDefaults = {
    brandId: 'fkretk',
    clientAccountId: clientResult.body.account.id,
    influencerIds: [presentationInfluencerId],
    fields: ['name', 'visitDate', 'visitTime', 'visitCity', 'visitBranch'],
    displayOptions: {
      showInfluencerDetails: true,
      showSocialAccounts: true,
      showFollowers: true,
      showAdditionalDetails: true,
      showCompanyWork: false
    },
    companyWorkVideoIds: [],
    videoReferences: []
  };
  const selectingResult = await fetchApi(`/api/campaigns/${campaignId}/presentations`, {
    method: 'POST',
    body: { ...presentationDefaults, fields: ['name', 'platform', 'username', 'visitDate', 'followers'] }
  });
  assert.equal(selectingResult.response.status, 201);
  const selectingPage = await fetch(`${baseUrl}${selectingResult.body.url}`);
  assert.equal(selectingPage.status, 200);
  const selectingPublic = await fetch(`${baseUrl}/api/campaign-presentations/${selectingResult.body.token}`);
  assert.equal(selectingPublic.status, 200);
  const selectingData = await selectingPublic.json();
  assert.equal(selectingData.presentation.mode, 'selecting');
  assert.equal(selectingData.targets[0].name, 'Synthetic Creator 0001');
  const visitsResult = await fetchApi(`/api/campaigns/${campaignId}/presentations`, {
    method: 'POST',
    body: {
      ...presentationDefaults,
      presentationMode: 'visits',
      headerTitle: 'Synthetic Release Visits',
      headerTagline: 'Synthetic visit schedule',
      packageVisitsCount: 1
    }
  });
  assert.equal(visitsResult.response.status, 201);
  const visitsPage = await fetch(`${baseUrl}${visitsResult.body.url}`);
  assert.equal(visitsPage.status, 200);
  const visitsPublic = await fetch(`${baseUrl}/api/campaign-presentations/${visitsResult.body.token}`);
  assert.equal(visitsPublic.status, 200);
  const visitsData = await visitsPublic.json();
  assert.equal(visitsData.presentation.mode, 'visits');
  assert.equal(visitsData.targets[0].visitBranch, 'Synthetic Release Branch');

  const lockoutUsername = `lockout-${randomBytes(5).toString('hex')}`;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const failedLogin = await fetchApi('/api/login', {
      method: 'POST',
      session: '',
      body: { username: lockoutUsername, password: 'Synthetic-invalid-password!' }
    });
    assert.equal(failedLogin.response.status, 401);
  }
  const lockedLogin = await fetchApi('/api/login', {
    method: 'POST',
    session: '',
    body: { username: lockoutUsername, password: 'Synthetic-invalid-password!' }
  });
  assert.equal(lockedLogin.response.status, 429);
  assert.match(lockedLogin.body.error, /تم قفل الدخول/u);
  assert.ok(lockedLogin.body.retryAfter > 590 && lockedLogin.body.retryAfter <= 600);

  console.log(JSON.stringify({
    result: 'PASS',
    sourceCommit: manifest.sourceCommit,
    secretScanCounts,
    cleanDatabase: 'schema created from scratch; no packaged database',
    firstAdminCli: 'created once with hidden-password policy; repeat refused',
    webFirstAdmin: 'wrong token HTTP 403; valid token created once; second setup HTTP 409; login succeeded',
    productionFiles: 'sensitive paths denied; verifier scripts, databases, backups, and credentials absent',
    missingProductionEnvironment: 'startup rejected with explicit required-path error',
    loginLockout: 'six failures, then HTTP 429 with Arabic 10-minute lockout message',
    clientPresentations: { selecting: selectingData.presentation.mode, visits: visitsData.presentation.mode },
    imports: { default: 'disabled', editor: editorImportResult.body.created, viewer: 'HTTP 403' },
    templates: '36 canonical headers accepted from XLSX and CSV',
    unknownColumns: 'preview blocked and commit rejected without writes',
    firstImport: { created: first.created, updated: first.updated, failed: first.failed },
    repeatedImport: { created: repeated.created, unchanged: repeated.unchanged, matchedByAccount: repeated.matchedByAccount },
    directDryRunMatches: { created: accountUpdate.created, updated: accountUpdate.updated, undone: accountUndo.body.undone },
    changedCities: { created: changed.created, updated: changed.updated, matchedByAccount: changed.matchedByAccount },
    duplicateRowsBlocked: duplicateCommit.body.failed,
    undoRows: undoResponse.body.undone
  }, null, 2));
} finally {
  if (server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
  await rm(tempDir, { recursive: true, force: true });
}
