import { resolve } from 'node:path';

const liveDbCandidates = new Set([
  resolve(process.cwd(), 'data/fikratak.sqlite'),
  resolve(process.cwd(), 'data\\fikratak.sqlite'),
  resolve(process.cwd(), 'data', 'fikratak.sqlite')
]);

export function assertSafeDbPath(dbPath, label = 'database') {
  const target = resolve(String(dbPath || ''));
  if (liveDbCandidates.has(target)) {
    throw new Error(`Unsafe ${label}: ${dbPath}. Tests and scripts must use a temp SQLite file instead of the live database at data/fikratak.sqlite.`);
  }
}
