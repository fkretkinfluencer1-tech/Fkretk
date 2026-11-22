import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { assertSafeDbPath } from './db-guard.mjs';

const projectDir = new URL('..', import.meta.url);
const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-mode-migration-test-'));
const dataDir = join(tempDir, 'data');
const databasePath = join(dataDir, 'fikratak.sqlite');
assertSafeDbPath(databasePath, 'test database');
await mkdir(dataDir, { recursive: true });

const fixture = new DatabaseSync(databasePath);
fixture.exec(`
  CREATE TABLE influencers (id TEXT PRIMARY KEY, record_json TEXT NOT NULL, phone_key TEXT UNIQUE);
  INSERT INTO influencers (id, record_json) VALUES
    ('${'a'.repeat(32)}', '{"Name":"Migration fixture","Main_Username":"kept_separate","Best Platform":"Instagram","Username I":"social_fixture","Followers Count I":"100K","Influencer Type I":"Mid","Classification":"Fitness","Categories 1":"Beauty","Categories 2":"Travel","Unmapped Interests":"Archived Interest"}');
  CREATE TABLE client_accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    client_name TEXT NOT NULL,
    company_name TEXT NOT NULL,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    client_type TEXT NOT NULL CHECK (client_type IN ('prospective', 'current')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO client_accounts (id, username, client_name, company_name, salt, password_hash, client_type, created_at, updated_at)
    VALUES
      ('${'b'.repeat(32)}', 'legacy-prospect', 'Legacy Prospect', 'Prospect Co', 'old-salt', 'old-hash', 'prospective', '2025-01-01', '2025-01-01'),
      ('${'c'.repeat(32)}', 'legacy-current', 'Legacy Current', 'Current Co', 'old-salt-2', 'old-hash-2', 'current', '2025-01-02', '2025-01-02');
`);
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
    FIKRATAK_BACKUP_DIR: join(tempDir, 'backups')
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
  if (server.exitCode !== null) throw new Error(`Migration fixture server stopped: ${serverErrors}`);
  try { ready = (await fetch(baseUrl)).status === 200; } catch {}
  if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!ready) throw new Error(`Migration fixture server did not start: ${serverErrors}`);

const setup = await fetch(`${baseUrl}/api/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'migration-admin', password: 'Migration-admin-pass-2026!' })
});
assert.equal(setup.status, 201, serverErrors);
const cookie = setup.headers.get('set-cookie')?.split(';')[0];

test('legacy client accounts receive safe display-mode defaults without losing records', async () => {
  const response = await fetch(`${baseUrl}/api/client-accounts`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const { accounts } = await response.json();
  assert.equal(accounts.length, 2);
  assert.equal(accounts.find((account) => account.username === 'legacy-prospect').displayMode, 'prospective');
  assert.equal(accounts.find((account) => account.username === 'legacy-current').displayMode, 'selecting');

  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  const columns = migrated.prepare('PRAGMA table_info(client_accounts)').all().map((column) => column.name);
  assert.ok(columns.includes('display_mode'));
  assert.equal(migrated.prepare('SELECT password_hash FROM client_accounts WHERE username = ?').get('legacy-prospect').password_hash, 'old-hash');
  assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, 1);
  const record = JSON.parse(migrated.prepare('SELECT record_json FROM influencers').get().record_json);
  assert.deepEqual(record.Interests, ['Archived Interest', 'Beauty', 'Travel', 'Fitness']);
  assert.deepEqual(record['Unmapped Interests'], []);
  assert.equal(record['Full Classification'], 'Archived Interest, Beauty, Travel, Fitness');
  assert.equal(record.Main_Username, 'kept_separate');
  assert.equal(record['Best Platform'], 'Instagram');
  assert.equal('Classification' in record, false);
  assert.equal('Categories 1' in record, false);
  assert.equal(migrated.prepare('SELECT COUNT(*) AS count FROM interest_catalog').get().count >= 15, true);
  assert.equal(migrated.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  migrated.close();
  const backups = await readdir(join(tempDir, 'backups'));
  const databaseBackup = backups.find((name) => name.endsWith('.sqlite'));
  assert.ok(databaseBackup, 'migration must create a SQLite backup before normalizing legacy categories');
  const backupDb = new DatabaseSync(join(tempDir, 'backups', databaseBackup), { readOnly: true });
  const backupRecord = JSON.parse(backupDb.prepare('SELECT record_json FROM influencers').get().record_json);
  assert.equal(backupRecord.Classification, 'Fitness');
  assert.equal(backupRecord['Categories 1'], 'Beauty');
  backupDb.close();

  const influencerResponse = await fetch(`${baseUrl}/api/influencers?q=kept_separate`, { headers: { cookie } });
  assert.equal(influencerResponse.status, 200);
  const influencerResult = await influencerResponse.json();
  assert.equal(influencerResult.rows[0].Main_Username, 'social_fixture');
  assert.equal(influencerResult.rows[0]['Best Platform'], 'Instagram');
  assert.equal(influencerResult.rows[0]['Influencer Type I'], 'Macro');
});
