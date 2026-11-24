import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = join(projectDir, 'production-release');
const buildDir = join(projectDir, `.production-release-${process.pid}`);
const zipPath = join(projectDir, 'production-release.zip');
const checksumsPath = join(projectDir, 'SHA256SUMS.txt');
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
const packageFiles = [...files, 'README.md', 'package.json', markerName];
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
const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

async function createZipBuffer(directory, names) {
  if (names.length > 0xffff) throw new Error('Production release exceeds the ZIP32 file-count limit.');
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const name of names) {
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error(`Unsafe ZIP path in release manifest: ${name}`);
    }
    const nameBytes = Buffer.from(name, 'utf8');
    const contents = await readFile(join(directory, name));
    const compressed = deflateRawSync(contents, { level: 9 });
    const checksum = crc32(contents);
    if (nameBytes.length > 0xffff || contents.length > 0xffffffff || compressed.length > 0xffffffff
      || localOffset > 0xffffffff) {
      throw new Error(`Production release file exceeds the ZIP32 size limit: ${name}`);
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0x0021, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0x0021, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBytes);
    localOffset += localHeader.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.length > 0xffffffff || localOffset > 0xffffffff) {
    throw new Error('Production release exceeds the ZIP32 archive-size limit.');
  }
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(names.length, 8);
  endRecord.writeUInt16LE(names.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  endRecord.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}

function readZipEntryNames(buffer) {
  const endSignature = 0x06054b50;
  const earliestOffset = Math.max(0, buffer.length - 22 - 0xffff);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= earliestOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === endSignature) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('ZIP end-of-central-directory record was not found.');
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  if (endOffset + 22 + commentLength !== buffer.length || centralOffset + centralSize !== endOffset) {
    throw new Error('ZIP central directory boundaries are invalid.');
  }
  const names = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP central directory entry is invalid.');
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (offset !== centralOffset + centralSize) throw new Error('ZIP central directory size does not match its entries.');
  return names;
}

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

await rm(buildDir, { recursive: true, force: true });
await rm(releaseDir, { recursive: true, force: true });
await rm(zipPath, { force: true });
await rm(checksumsPath, { force: true });
await mkdir(buildDir);
try {
  for (const file of files) await copyReleaseFile(file);
  await writeFile(join(buildDir, 'README.md'), await readFile(join(projectDir, 'DEPLOYMENT.md')));
  await writeFile(join(buildDir, 'package.json'), `${JSON.stringify(releasePackage, null, 2)}\n`);
  await writeFile(join(buildDir, markerName), `${JSON.stringify({
    generatedBy: 'scripts/create-production-release.mjs',
    sourceCommit,
    outOfZipDocuments: ['HOSTING-SETUP-AR.md'],
    files: packageFiles
  }, null, 2)}\n`);
  await chmod(join(buildDir, 'start-production.sh'), 0o750);
  await writeFile(join(buildDir, 'HOSTING-SETUP-AR.md'),
    await readFile(join(projectDir, 'docs', 'HOSTING-SETUP-AR.md')));
  await inspectRelease(buildDir);
  const zipBuffer = await createZipBuffer(buildDir, packageFiles);
  const archiveEntries = readZipEntryNames(zipBuffer);
  if (archiveEntries.length !== packageFiles.length
    || archiveEntries.some((name, index) => name !== packageFiles[index])) {
    throw new Error('ZIP members do not exactly match the release manifest.');
  }
  if (archiveEntries.some((name) => name.includes('\\') || name === 'production-release.zip' || name === 'SHA256SUMS.txt')) {
    throw new Error('ZIP contains an unexpected path separator or generated output file.');
  }
  await writeFile(zipPath, zipBuffer);
  await rename(buildDir, releaseDir);
  const checksums = await Promise.all(packageFiles
    .slice()
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map(async (name) => {
      const hash = createHash('sha256').update(await readFile(join(releaseDir, name))).digest('hex');
      return `${hash}  production-release/${name}`;
    }));
  const zipHash = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  checksums.push(`${zipHash}  production-release.zip`);
  await writeFile(checksumsPath,
    '# Generated after the ZIP; covers manifest-listed release files and production-release.zip. The hosting guide is outside the ZIP.\n'
    + checksums.map((line) => `${line}\n`).join(''));
  console.log(`Production release created at ${releaseDir}`);
  console.log(`Production release ZIP created at ${zipPath}`);
  console.log(`${packageFiles.length} manifest-listed files included; database files, verification scripts, tests, dependencies, and backups excluded.`);
} catch (error) {
  await rm(buildDir, { recursive: true, force: true });
  await rm(releaseDir, { recursive: true, force: true });
  await rm(zipPath, { force: true });
  await rm(checksumsPath, { force: true });
  throw error;
}
