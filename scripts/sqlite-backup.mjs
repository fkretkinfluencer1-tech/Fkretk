import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';

async function validateDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const check = database.prepare('PRAGMA quick_check').get()?.quick_check;
    if (check !== 'ok') throw new Error(`SQLite quick_check failed: ${String(check)}`);
    const foreignKeyIssues = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyIssues.length) throw new Error(`SQLite foreign_key_check found ${foreignKeyIssues.length} issue(s).`);
  } finally {
    database.close();
  }
}

async function copyDatabase(sourcePath, destinationPath) {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination) throw new Error('Source and destination must be different files.');
  await stat(source);
  try {
    await stat(destination);
    throw new Error('Destination already exists; refusing to overwrite it.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let sourceDatabase;
  try {
    sourceDatabase = new DatabaseSync(source, { readOnly: true });
    await backup(sourceDatabase, temporary);
    sourceDatabase.close();
    sourceDatabase = null;
    await validateDatabase(temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    console.log(`SQLite database copied and validated: ${destination}`);
  } catch (error) {
    if (sourceDatabase) sourceDatabase.close();
    await rm(temporary, { force: true });
    throw error;
  }
}

const [action, source, destination] = process.argv.slice(2);
if (action === 'validate' && source && !destination) {
  await validateDatabase(resolve(source));
  console.log('SQLite quick_check and foreign_key_check passed.');
} else if (['create', 'restore'].includes(action) && source && destination) {
  await copyDatabase(source, destination);
} else {
  throw new Error('Usage: node scripts/sqlite-backup.mjs validate <database> | create|restore <source> <new-destination>');
}
