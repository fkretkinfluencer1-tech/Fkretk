import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argumentsToPass = process.argv.slice(2);
const child = spawn(process.execPath, ['scripts/screenshots.mjs', ...argumentsToPass], {
  cwd: projectDir,
  env: { ...process.env, FIKRATAK_AXE: '1' },
  stdio: 'inherit'
});
const [code, signal] = await once(child, 'exit');
if (signal) throw new Error(`Contrast scan stopped by signal ${signal}.`);
if (code !== 0) process.exitCode = code || 1;
