import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const projectDir = new URL('..', import.meta.url);

test('SQLite online backup and restore preserve a synthetic database snapshot', async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-sqlite-backup-'));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const sourcePath = join(tempDir, 'source.sqlite');
  const snapshotPath = join(tempDir, 'snapshot.sqlite');
  const restoredPath = join(tempDir, 'restored.sqlite');
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE owners (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES owners(id),
      platform TEXT NOT NULL,
      username TEXT NOT NULL,
      UNIQUE (platform, username)
    );
    INSERT INTO owners (id, label) VALUES (1, 'synthetic-owner');
    INSERT INTO accounts (id, owner_id, platform, username) VALUES
      (1, 1, 'TikTok', 'synthetic_handle');
  `);
  source.close();

  function run(...args) {
    const result = spawnSync(process.execPath, ['scripts/sqlite-backup.mjs', ...args], {
      cwd: projectDir,
      encoding: 'utf8'
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }

  run('create', sourcePath, snapshotPath);
  const mutableSource = new DatabaseSync(sourcePath);
  mutableSource.prepare('UPDATE owners SET label = ? WHERE id = 1').run('changed-after-snapshot');
  mutableSource.close();
  run('restore', snapshotPath, restoredPath);
  run('validate', snapshotPath);
  run('validate', restoredPath);

  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  const restored = new DatabaseSync(restoredPath, { readOnly: true });
  try {
    assert.equal(snapshot.prepare('SELECT label FROM owners WHERE id = 1').get().label, 'synthetic-owner');
    assert.equal(restored.prepare('SELECT label FROM owners WHERE id = 1').get().label, 'synthetic-owner');
    assert.equal(restored.prepare('SELECT username FROM accounts WHERE id = 1').get().username, 'synthetic_handle');
    assert.equal(restored.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    snapshot.close();
    restored.close();
  }
});
