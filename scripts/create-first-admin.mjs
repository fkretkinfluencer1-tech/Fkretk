import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, stat } from 'node:fs/promises';

const scryptAsync = promisify(scrypt);
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isWithin(parent, target) {
  const path = relative(parent, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function validateUsername(username) {
  return /^[\p{L}\p{M}\p{N}._ -]{3,32}$/u.test(username);
}

function validateStrongPassword(password, username) {
  const classes = [
    /\p{L}/u.test(password),
    /\p{N}/u.test(password),
    /[^\p{L}\p{N}]/u.test(password)
  ].filter(Boolean).length;
  return typeof password === 'string'
    && password.length >= 12
    && password.length <= 128
    && classes >= 2
    && !password.toLocaleLowerCase().includes(username.toLocaleLowerCase());
}

function assertUsersTableEmpty(database) {
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!table) throw new Error('The database has no users table; start the application once before creating its first admin.');
  const count = Number(database.prepare('SELECT COUNT(*) AS count FROM users').get().count);
  if (count) throw new Error('The database already contains users; first-admin creation is refused.');
}

export async function createFirstAdmin(databasePath, usernameInput, password) {
  const username = String(usernameInput ?? '').trim();
  if (!validateUsername(username)) {
    throw new Error('Username must be 3–32 letters, numbers, spaces, dots, underscores, or hyphens.');
  }
  if (!validateStrongPassword(password, username)) {
    throw new Error('Password must be 12–128 characters, use at least two of letters, numbers, and symbols, and not contain the username.');
  }

  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const userId = randomBytes(16).toString('hex');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      assertUsersTableEmpty(database);
      database.prepare(`INSERT INTO users (id, username, salt, password_hash, role, active, created_at)
        VALUES (?, ?, ?, ?, 'admin', 1, ?)`)
        .run(userId, username, salt.toString('hex'), Buffer.from(hash).toString('hex'), new Date().toISOString());
      const saved = database.prepare('SELECT id, username, salt, password_hash, role, active FROM users WHERE id = ?')
        .get(userId);
      if (!saved || saved.username !== username || saved.role !== 'admin' || saved.active !== 1) {
        throw new Error('The first administrator could not be verified.');
      }
      const check = await scryptAsync(password, Buffer.from(saved.salt, 'hex'), 64,
        { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      if (!timingSafeEqual(Buffer.from(check), Buffer.from(saved.password_hash, 'hex'))) {
        throw new Error('The first administrator could not be verified.');
      }
      database.exec('COMMIT');
      return { id: userId, username };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

async function resolveDatabasePath() {
  const configuredDataDir = process.env.FIKRATAK_DATA_DIR || '';
  if (!configuredDataDir || !isAbsolute(configuredDataDir)) {
    throw new Error('Set FIKRATAK_DATA_DIR to the absolute production data directory.');
  }
  const dataDir = await realpath(resolve(configuredDataDir));
  if (isWithin(projectDir, dataDir)) throw new Error('The production data directory must be outside the application release.');
  const configuredDatabase = join(dataDir, 'fikratak.sqlite');
  const info = await stat(configuredDatabase);
  if (!info.isFile()) throw new Error('The production SQLite database does not exist.');
  const databasePath = await realpath(configuredDatabase);
  if (!isWithin(dataDir, databasePath)) throw new Error('The SQLite database resolves outside FIKRATAK_DATA_DIR.');
  return databasePath;
}

function promptHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('A private interactive terminal is required for hidden password input. Use the one-time web setup instead.');
  }
  return new Promise((resolvePrompt, rejectPrompt) => {
    let value = '';
    let rawMode = false;
    const finish = (error) => {
      stdin.off('data', onData);
      if (rawMode) stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) rejectPrompt(error);
      else resolvePrompt(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new Error('Password entry cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    stdout.write(label);
    try {
      stdin.setRawMode(true);
      rawMode = true;
      stdin.resume();
      stdin.on('data', onData);
    } catch (error) {
      finish(error);
    }
  });
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('Run this command in a private interactive terminal.');
  const databasePath = await resolveDatabasePath();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { assertUsersTableEmpty(database); }
  finally { database.close(); }

  const prompt = createInterface({ input: stdin, output: stdout });
  let username;
  try { username = (await prompt.question('First admin username: ')).trim(); }
  finally { prompt.close(); }

  const password = await promptHidden('Password (input hidden): ');
  const confirmation = await promptHidden('Confirm password (input hidden): ');
  if (password !== confirmation) throw new Error('Passwords do not match.');
  if (!validateStrongPassword(password, username)) {
    throw new Error('Password must be 12–128 characters, use at least two of letters, numbers, and symbols, and not contain the username.');
  }

  const admin = await createFirstAdmin(databasePath, username, password);
  console.log(`First administrator created: ${admin.username}. Sign in through the application.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
