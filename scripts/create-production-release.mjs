import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(projectDir, 'production-release');
const buildDir = join(projectDir, `.production-release-${process.pid}`);
const markerName = '.production-release-manifest.json';
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: projectDir, encoding: 'utf8'
}).trim();
const files = [
  'server.mjs',
  'index.html',
  'campaign-presentation.html',
  'client-accounts.html',
  'client.html',
  'portal.html',
  'showcase.html',
  '.env.example',
  'DEPLOYMENT.md',
  'docs/DEPLOYMENT_RUNBOOK.md',
  'docs/LOGIN-OPERATIONS.md',
  'start-production.sh',
  'start-production.cmd',
  'scripts/create-first-admin.mjs',
  'scripts/create-production-admin.mjs',
  'scripts/sqlite-backup.mjs',
  'scripts/backup-offsite.sh',
  'scripts/restore-offsite.sh',
  'data-access/sqlite.mjs',
  'data-access/xlsx-workbook.mjs',
  'security/request-address.mjs',
  'deploy/nginx.conf.example',
  'deploy/fikratak.service.example',
  'deploy/fikratak-backup.service.example',
  'deploy/fikratak-backup.timer.example',
  'influencer-template.csv',
  'fikratak-influencers-template-3000.xlsx',
  'assets/cairo-OFL.txt',
  'assets/cairo-arabic.woff2',
  'assets/cairo-latin.woff2',
  'assets/country-locations.js',
  'assets/fikratak-design.css',
  'assets/fikratak-digital-logo.png',
  'assets/flag-saudi-arabia.png',
  'assets/follower-tiers.js',
  'assets/influencer-field-options.js',
  'assets/icons.js',
  'assets/icons/sprite.svg',
  'assets/password-visibility.js',
  'assets/admin.css',
  'assets/client-accounts.css',
  'assets/client.css',
  'assets/portal.css',
  'assets/presentation.css',
  'assets/ui.js',
  'assets/i18n.js',
  'assets/logo.png',
  'assets/platform-instagram.jpg',
  'assets/platform-snapchat.png',
  'assets/platform-tiktok.jpg',
  'assets/influencer-placeholder-male.svg',
  'assets/influencer-placeholder-female.svg',
  'assets/influencer-placeholder-neutral.svg',
  'assets/avatars/female.svg',
  'assets/avatars/female-hijab.svg',
  'assets/avatars/male.svg',
  'assets/avatars/neutral.svg',
  'assets/showcase.css',
  'assets/showcase.js'
];
const releasePackage = {
  name: 'fikratak-influencer-crm',
  version: '0.2.0',
  private: true,
  type: 'module',
  engines: { node: '>=24' },
  scripts: {
    start: 'sh ./start-production.sh',
    'start:windows': 'start-production.cmd',
    check: 'node --check server.mjs'
  }
};

async function copyReleaseFile(source) {
  const destination = join(buildDir, source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(projectDir, source), destination);
}

async function inspectRelease(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'data', 'test', 'tests', '__tests__'].includes(entry.name)) {
      throw new Error(`Unexpected sensitive or development directory in release: ${entry.name}`);
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await inspectRelease(path);
      continue;
    }
    if (/^(?!\.env\.example$)\.env(?:\.|$)/i.test(entry.name)
      || /\.(?:sqlite(?:-(?:shm|wal))?|db|log|map|bak|backup)$/i.test(entry.name)
      || /(?:verify-production-release\.mjs|verify-linux-operations\.sh|\.test\.[cm]?[jt]sx?$)/i.test(entry.name)) {
      throw new Error(`Unexpected sensitive or development file in release: ${relative(directory, path).split(sep).join('/')}`);
    }
    if (/\.(?:mjs|js|html|json|sh|cmd|md|csv|example|txt)$/i.test(entry.name)) {
      const contents = await readFile(path, 'utf8');
      const credentialPatterns = [
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
        /\b(?:password|passwd|secret|api[_-]?key|private[_-]?key|access[_-]?token)\b\s*[:=]\s*(['"])([^'"\r\n]{8,})\1/iu
      ];
      if (credentialPatterns.some((pattern) => pattern.test(contents))) {
        throw new Error(`Potential credential literal in release: ${relative(directory, path).split(sep).join('/')}`);
      }
    }
  }
}

async function releaseFiles(directory, relativeDirectory = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory
      ? join(relativeDirectory, entry.name).split(sep).join('/')
      : entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await releaseFiles(path, relativePath));
    else files.push({ path, relativePath });
  }
  return files;
}

let releaseExists = false;
try {
  await stat(releaseDir);
  releaseExists = true;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (releaseExists) {
  try {
    const marker = JSON.parse(await readFile(join(releaseDir, markerName), 'utf8'));
    if (marker.generatedBy !== 'scripts/create-production-release.mjs') throw new Error();
  } catch {
    throw new Error('production-release exists but is not a verified generated release; preserve it and resolve the directory manually.');
  }
}

await mkdir(buildDir);
try {
  for (const file of files) await copyReleaseFile(file);
  await writeFile(join(buildDir, 'README.md'), await readFile(join(projectDir, 'DEPLOYMENT.md')));
  await writeFile(join(buildDir, 'package.json'), `${JSON.stringify(releasePackage, null, 2)}\n`);
  await writeFile(join(buildDir, markerName), `${JSON.stringify({
    generatedBy: 'scripts/create-production-release.mjs',
    sourceCommit,
    outOfZipDocuments: ['HOSTING-SETUP-AR.md'],
    files: [...files, 'README.md', 'package.json', markerName]
  }, null, 2)}\n`);
  await chmod(join(buildDir, 'start-production.sh'), 0o750);
  await inspectRelease(buildDir);
  const releaseInventory = await releaseFiles(buildDir);
  const checksums = await Promise.all(releaseInventory
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'))
    .map(async ({ path, relativePath }) => {
      const hash = createHash('sha256').update(await readFile(path)).digest('hex');
      return `${hash}  ${relativePath}`;
    }));
  await writeFile(join(projectDir, 'SHA256SUMS.txt'),
    '# Generated by scripts/create-production-release.mjs; covers ZIP members and excludes the ZIP hash and HOSTING-SETUP-AR.md.\n'
    + checksums.map((line) => `${line}\n`).join(''));
  await writeFile(join(buildDir, 'HOSTING-SETUP-AR.md'),
    await readFile(join(projectDir, 'docs', 'HOSTING-SETUP-AR.md')));
  let previousDir = '';
  if (releaseExists) {
    previousDir = join(projectDir, `.production-release-previous-${process.pid}`);
    await rename(releaseDir, previousDir);
  }
  try {
    await rename(buildDir, releaseDir);
  } catch (error) {
    if (previousDir) await rename(previousDir, releaseDir);
    throw error;
  }
  if (previousDir) await rm(previousDir, { recursive: true, force: true });
  console.log(`Production release created at ${releaseDir}`);
  console.log(`${files.length + 3} runtime and deployment files included; database files, verification scripts, tests, dependencies, and backups excluded.`);
} catch (error) {
  await rm(buildDir, { recursive: true, force: true });
  throw error;
}
