import { chmod, mkdir, realpath, stat } from 'node:fs/promises';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { DatabaseSync } from 'node:sqlite';

const scryptAsync = promisify(scrypt);
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.FIKRATAK_DATA_DIR || '';
const backupDir = process.env.FIKRATAK_BACKUP_DIR || '';
const loginUrl = process.env.FIKRATAK_LOGIN_URL || '';

function isWithin(parent, target) {
  const path = relative(parent, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function requiredExternalDirectory(value, label) {
  if (!value || !isAbsolute(value)) throw new Error(`${label} must be an explicitly configured absolute path.`);
  const path = resolve(value);
  if (isWithin(projectDir, path)) throw new Error(`${label} must be outside the application release directory.`);
  return path;
}

async function validateDatabaseBackup(path) {
  const snapshot = new DatabaseSync(path);
  try {
    const result = snapshot.prepare('PRAGMA quick_check').get().quick_check;
    if (result !== 'ok') throw new Error('The SQLite backup did not pass PRAGMA quick_check.');
    snapshot.prepare('PRAGMA journal_mode = DELETE').get();
  } finally {
    snapshot.close();
  }
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Run this command interactively in a private terminal; do not redirect its output.');
  if (!loginUrl) throw new Error('FIKRATAK_LOGIN_URL must be set to the production HTTPS application URL.');
  const login = new URL(loginUrl);
  if (login.protocol !== 'https:' || login.username || login.password || login.search || login.hash
    || !['', '/'].includes(login.pathname)) {
    throw new Error('FIKRATAK_LOGIN_URL must be an HTTPS origin without credentials, path, query, or fragment.');
  }
  let resolvedDataDir = requiredExternalDirectory(dataDir, 'FIKRATAK_DATA_DIR');
  const resolvedBackupDir = requiredExternalDirectory(backupDir, 'FIKRATAK_BACKUP_DIR');
  resolvedDataDir = await realpath(resolvedDataDir);
  if (isWithin(projectDir, resolvedDataDir)) throw new Error('The resolved production data directory must be outside the application release directory.');
  if (isWithin(resolvedDataDir, resolvedBackupDir) || isWithin(resolvedBackupDir, resolvedDataDir)) {
    throw new Error('The production backup directory must be separate from the data directory.');
  }
  const configuredDatabasePath = join(resolvedDataDir, 'fikratak.sqlite');
  const info = await stat(configuredDatabasePath);
  if (!info.isFile()) throw new Error('The configured production SQLite file does not exist.');
  const databasePath = await realpath(configuredDatabasePath);
  if (!isWithin(resolvedDataDir, databasePath)) throw new Error('The configured SQLite file resolves outside FIKRATAK_DATA_DIR.');

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const confirmation = await prompt.question(
      `This adds a second administrator to ${databasePath}. Existing users will remain unchanged. Type ADD-ADMIN to continue: `
    );
    if (confirmation !== 'ADD-ADMIN') throw new Error('Administrator creation cancelled.');
  } finally {
    prompt.close();
  }

  const database = new DatabaseSync(databasePath);
  let newUserId = '';
  let backupPath = '';
  try {
    database.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
    if (!table) throw new Error('The configured database has no users table; refusing to initialize or replace it.');
    const existingAdmins = Number(database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get().count);
    const influencerCount = Number(database.prepare('SELECT COUNT(*) AS count FROM influencers').get().count);
    if (!existingAdmins || !influencerCount) {
      throw new Error('Expected existing administrator and influencer records were not found; refusing a reset or fresh-database setup.');
    }

    await mkdir(resolvedBackupDir, { recursive: true, mode: 0o700 });
    const actualBackupDir = await realpath(resolvedBackupDir);
    if (isWithin(projectDir, actualBackupDir) || isWithin(resolvedDataDir, actualBackupDir) || isWithin(actualBackupDir, resolvedDataDir)) {
      throw new Error('The resolved production backup directory must be separate from the application and data directories.');
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = join(actualBackupDir, `fikratak-before-admin-add-${stamp}-${randomBytes(3).toString('hex')}.sqlite`);
    await database.backup(backupPath);
    await chmod(backupPath, 0o600);
    await validateDatabaseBackup(backupPath);

    const username = `admin-${randomBytes(6).toString('hex')}`;
    const password = randomBytes(32).toString('base64url');
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const userId = randomBytes(16).toString('hex');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`INSERT INTO users (id, username, salt, password_hash, role, active, created_at)
        VALUES (?, ?, ?, ?, 'admin', 1, ?)`)
        .run(userId, username, salt.toString('hex'), Buffer.from(hash).toString('hex'), new Date().toISOString());
      const saved = database.prepare('SELECT id, username, salt, password_hash, role, active FROM users WHERE id = ?').get(userId);
      if (!saved || saved.username !== username || saved.role !== 'admin' || saved.active !== 1) {
        throw new Error('The new administrator failed database verification.');
      }
      const check = await scryptAsync(password, Buffer.from(saved.salt, 'hex'), 64,
        { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      if (!timingSafeEqual(Buffer.from(check), Buffer.from(saved.password_hash, 'hex'))) {
        throw new Error('The new administrator password hash failed verification.');
      }
      database.exec('COMMIT');
      newUserId = userId;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    let response;
    try {
      response = await fetch(new URL('/api/login', login.origin), {
        method: 'POST',
        headers: { origin: login.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(15_000)
      });
    } catch (error) {
      throw new Error(`The administrator was saved and backed up, but HTTPS login verification could not reach the server: ${error.message}`);
    }
    const loginResult = await response.json().catch(() => ({}));
    if (!response.ok || loginResult.user?.role !== 'admin' || loginResult.user?.username !== username) {
      throw new Error(`The administrator was saved and backed up, but login verification failed with HTTP ${response.status}.`);
    }
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('The administrator login succeeded but did not issue a session cookie.');
    const adminCheck = await fetch(new URL('/api/users', login.origin), {
      headers: { cookie },
      signal: AbortSignal.timeout(15_000)
    });
    const adminCheckResult = await adminCheck.json().catch(() => ({}));
    if (!adminCheck.ok || !adminCheckResult.users?.some((user) => user.username === username && user.role === 'admin')) {
      throw new Error(`The administrator logged in but the admin-only user-management check failed with HTTP ${adminCheck.status}.`);
    }

    console.log(`Administrator login and admin-only user-management access verified successfully. Backup: ${backupPath}`);
    console.log(`Username: ${username}`);
    console.log(`Temporary Password: ${password}`);
    console.log(`Login URL: ${login.origin}/`);
    console.log('Deliver these credentials through an approved private channel, then sign in and change the password. Do not save or redirect this terminal output.');
  } catch (error) {
    if (newUserId) {
      database.prepare('DELETE FROM users WHERE id = ?').run(newUserId);
      throw new Error(`${error.message} The newly added account was removed; existing accounts and records were left unchanged.`);
    }
    throw error;
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
