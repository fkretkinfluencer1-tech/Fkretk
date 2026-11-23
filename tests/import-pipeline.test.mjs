import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { createXlsxWorkbook } from '../data-access/xlsx-workbook.mjs';

const projectDir = new URL('..', import.meta.url);
const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-import-pipeline-'));
const dataDir = join(tempDir, 'data');
const databasePath = join(dataDir, 'fikratak.sqlite');
await mkdir(dataDir, { recursive: true });

const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once('error', reject);
  portProbe.listen(0, '127.0.0.1', resolve);
});
const port = portProbe.address().port;
await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));

const server = spawn(process.execPath, ['--no-warnings', 'server.mjs'], {
  cwd: projectDir,
  env: {
    ...process.env,
    PORT: String(port),
    FIKRATAK_DATA_DIR: dataDir,
    FIKRATAK_BACKUP_DIR: join(tempDir, 'backups'),
    FIKRATAK_ENABLE_ALIAS_NORMALIZATION: '1'
  },
  stdio: ['ignore', 'ignore', 'pipe']
});
let serverErrors = '';
server.stderr.on('data', chunk => { serverErrors += chunk.toString(); });
const baseUrl = `http://127.0.0.1:${port}`;

after(async () => {
  if (server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
  await rm(tempDir, { recursive: true, force: true });
});

let ready = false;
for (let attempt = 0; attempt < 300 && !ready; attempt += 1) {
  if (server.exitCode !== null) throw new Error(`Import test server stopped: ${serverErrors}`);
  try { ready = (await fetch(baseUrl)).status === 200; } catch {}
  if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
}
if (!ready) throw new Error(`Import test server did not start: ${serverErrors}`);

const setup = await fetch(`${baseUrl}/api/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'import-admin', password: 'Import-test-password-2026!' })
});
assert.equal(setup.status, 201);
const cookie = setup.headers.get('set-cookie')?.split(';')[0];

async function call(path, body, method = 'POST') {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

function importBody(rows, fileName = 'synthetic.csv') {
  const bytes = Buffer.from(`synthetic source: ${fileName}`);
  return { rows, fileName, fileBase64: bytes.toString('base64') };
}

async function preview(body) {
  const response = await call('/api/import/preview', body);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.preview;
}

async function importFile(body, approvals = {}) {
  const result = await preview(body);
  const response = await call('/api/import', {
    ...body,
    previewId: result.previewId,
    acknowledgeUnknownColumns: approvals.acknowledgeUnknownColumns === true,
    confirmAllNew: approvals.confirmAllNew === true,
    restoreArchivedMatches: approvals.restoreArchivedMatches === true,
    approveAccountMatches: approvals.approveAccountMatches === true
  });
  return { preview: result, ...response };
}

function db() {
  return new DatabaseSync(databasePath);
}

function query(sql, ...params) {
  const connection = db();
  try { return connection.prepare(sql).get(...params); }
  finally { connection.close(); }
}

test('normalized account matching, shared phones, conflicts, batch undo, and account uniqueness', { concurrency: false }, async t => {
  const unknownSource = importBody([{
    'الاسم': 'Synthetic Alias Creator',
    'Username Instagram': 'inst_alias_creator',
    'Mystery Column': 'must-block'
  }], 'unknown.csv');
  const unknownPreview = await preview(unknownSource);
  assert.deepEqual(unknownPreview.unknownColumns, ['Mystery Column']);
  assert.equal(unknownPreview.importBlocked, true);
  assert.equal((await call('/api/import', { ...unknownSource, previewId: unknownPreview.previewId })).status, 400);
  assert.equal(query('SELECT COUNT(*) AS count FROM influencers').count, 0);

  const whitespaceSeed = await importFile(importBody([{
    Name: 'Synthetic XLSX Whitespace Creator',
    Country: 'SyntheticCountry',
    Area: 'North',
    City: 'Before',
    'Username I': 'xlsx_whitespace_creator'
  }], 'xlsx-whitespace-seed.csv'), { confirmAllNew: true });
  assert.equal(whitespaceSeed.body.created, 1);
  const whitespaceWorkbook = createXlsxWorkbook(
    ['Name', 'Country', 'Area', 'City', 'Username I'],
    [[
      'Synthetic XLSX Whitespace Creator',
      ' \u00a0Synthetic\u00a0Country\u200b\u2060 ',
      '',
      'After',
      '\u00a0\u200b @  Xlsx_Whitespace_Creator \u2060 '
    ]]
  );
  const whitespaceImport = {
    fileName: 'xlsx-whitespace.xlsx',
    fileBase64: whitespaceWorkbook.toString('base64')
  };
  const whitespacePreview = await preview(whitespaceImport);
  assert.equal(whitespacePreview.integrity.matchedByAccount, 1, JSON.stringify(whitespacePreview));
  assert.equal(whitespacePreview.integrity.updates, 1);
  const importedWhitespace = await importFile(whitespaceImport);
  assert.equal(importedWhitespace.body.created, 0);
  assert.equal(importedWhitespace.body.updated, 1);
  const whitespaceRecord = JSON.parse(query(`SELECT record_json FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic XLSX Whitespace Creator'`).record_json);
  assert.equal(whitespaceRecord['Username I'], 'xlsx_whitespace_creator');
  assert.equal(whitespaceRecord.Country, 'SyntheticCountry');
  assert.equal(whitespaceRecord.Area, 'North');
  assert.equal(whitespaceRecord.City, 'After');
  const whitespaceUndo = await call(`/api/import/batches/${importedWhitespace.body.batchId}/undo`, {});
  assert.equal(whitespaceUndo.status, 200, JSON.stringify(whitespaceUndo.body));
  const seedUndo = await call(`/api/import/batches/${whitespaceSeed.body.batchId}/undo`, {});
  assert.equal(seedUndo.status, 200, JSON.stringify(seedUndo.body));

  const source = importBody([{
    'الاسم': 'Synthetic Alias Creator',
    Main_Username: 'independent_main_name',
    'رقم الجوال': '05 55010001',
    'Username Tiktok': '@  Test.Handle ',
    'Username Snapchat': 'snap_alias_creator',
    'Username Instagram': 'inst_alias_creator',
    'Followers Count Tiktok': '12000',
    'Followers Count Instagram': '25000',
    'Followers Count Snapchat': '0',
    'المدينة': 'Jeddah',
    'شهادة موثوق': 'Yes',
    'مصدر التأكيد': 'Synthetic import'
  }, ...Array.from({ length: 9 }, (_, index) => ({
    Name: `Synthetic Ten Row ${index + 2}`,
    'Username Instagram': `ten_row_${index + 2}`,
    'Followers Count I': String(1000 + index)
  }))]);
  const firstPreview = await preview(source);
  assert.equal(firstPreview.integrity.creates, 10);
  const first = await importFile(source);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(
    { created: first.body.created, updated: first.body.updated, unchanged: first.body.unchanged, failed: first.body.failed },
    { created: 10, updated: 0, unchanged: 0, failed: 0 }
  );
  const firstDb = db();
  const creator = firstDb.prepare(`SELECT id, record_json, phone_key FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic Alias Creator'`).get();
  const firstRecord = JSON.parse(creator.record_json);
  assert.equal(firstRecord['Username T'], 'test.handle', JSON.stringify(firstRecord));
  assert.equal(firstRecord['Followers Count T'], '12000');
  assert.equal(firstRecord['Followers Count I'], '25000');
  assert.equal(firstRecord['Followers Count S'], '0');
  assert.equal(firstRecord.City, 'Jeddah');
  assert.equal(firstRecord.Mawthouq, 'Yes');
  assert.equal(firstRecord['Confrmation Source'], 'Synthetic import');
  assert.equal(firstRecord['Influencer Type T'], 'Micro');
  assert.equal(creator.phone_key, '+966555010001');
  const batch = firstDb.prepare('SELECT file_name, file_sha256, created_count, row_results_json FROM import_batches WHERE id = ?')
    .get(first.body.batchId);
  assert.equal(batch.file_name, 'synthetic.csv');
  assert.equal(batch.file_sha256, createHash('sha256').update(Buffer.from(`synthetic source: synthetic.csv`)).digest('hex'));
  assert.equal(batch.created_count, 10);
  assert.equal(JSON.parse(batch.row_results_json).length, 10);
  assert.equal(JSON.parse(batch.row_results_json)[0].result, 'created');
  firstDb.close();

  const repeated = await importFile(source);
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.deepEqual(
    { created: repeated.body.created, updated: repeated.body.updated, unchanged: repeated.body.unchanged },
    { created: 0, updated: 0, unchanged: 10 }
  );

  const followerChange = importBody([{
    'Username Instagram': 'inst_alias_creator', 'Followers Count Instagram': '26000'
  }], 'follower-update.csv');
  const oneFollowerUpdate = await importFile(followerChange);
  assert.equal(oneFollowerUpdate.body.updated, 1);
  assert.equal(oneFollowerUpdate.body.created, 0);
  const updatedFollowers = db();
  const updatedCreator = JSON.parse(updatedFollowers.prepare('SELECT record_json FROM influencers WHERE id = ?').get(creator.id).record_json);
  assert.equal(updatedCreator['Followers Count I'], '26000');
  assert.equal(updatedCreator.Main_Username, 'independent_main_name');
  assert.equal(updatedFollowers.prepare(`SELECT json_extract(record_json, '$."Followers Count I"') AS count FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic Ten Row 2'`).get().count, '1000');
  updatedFollowers.close();

  const addedEleventh = await importFile(importBody([{
    Name: 'Synthetic Eleventh Creator', 'Username TikTok': 'eleventh_creator'
  }], 'eleventh.csv'), { confirmAllNew: true });
  assert.equal(addedEleventh.body.created, 1);
  assert.equal(query('SELECT COUNT(*) AS count FROM influencers').count, 11);

  const sharedNumber = importBody([
    { Name: 'Shared Number One', Number: '0555010123', 'Username Instagram': 'shared_number_one' },
    { Name: 'Shared Number Two', Number: '0555010123', 'Username TikTok': 'shared_number_two' }
  ], 'shared-number.csv');
  const sharedImport = await importFile(sharedNumber, { confirmAllNew: true });
  assert.equal(sharedImport.body.created, 2);
  assert.equal(sharedImport.body.sharedPhones, 2);
  const sharedRecords = db();
  for (const username of ['shared_number_one', 'shared_number_two']) {
    const record = JSON.parse(sharedRecords.prepare(`SELECT record_json FROM influencers
      WHERE json_extract(record_json, '$."Username I"') = ?
         OR json_extract(record_json, '$."Username T"') = ?`).get(username, username).record_json);
    assert.equal(record['Phone Shared'], 'رقم مشترك');
  }
  assert.equal(sharedRecords.prepare('SELECT COUNT(*) AS count FROM influencers WHERE phone_key = ?')
    .get('+966555010123').count, 2);
  sharedRecords.close();
  const phoneOnlyMatch = await importFile(importBody([{
    Name: 'Phone Is Not Identity', Number: '0555010123'
  }], 'phone-is-not-identity.csv'), { confirmAllNew: true });
  assert.equal(phoneOnlyMatch.body.created, 1);
  assert.equal(phoneOnlyMatch.body.matchedByAccount, 0);
  assert.equal(phoneOnlyMatch.body.sharedPhones, 1);
  assert.equal(query(`SELECT COUNT(*) AS count FROM influencers
    WHERE phone_key = '+966555010123'`).count, 3);

  const phoneLater = await importFile(importBody([{
    Name: 'Phone Added Later', 'Username Instagram': 'phone_added_later'
  }], 'phone-later-empty.csv'), { confirmAllNew: true });
  assert.equal(phoneLater.body.created, 1);
  const phoneLaterId = query(`SELECT id FROM influencers
    WHERE json_extract(record_json, '$."Username I"') = 'phone_added_later'`).id;
  assert.equal(query('SELECT phone_key FROM influencers WHERE id = ?', phoneLaterId).phone_key, null);
  const phoneAdded = await importFile(importBody([{
    'Username Instagram': 'PHONE_ADDED_LATER', Number: '0555010456'
  }], 'phone-later-added.csv'));
  assert.equal(phoneAdded.body.updated, 1);
  assert.equal(query('SELECT COUNT(*) AS count FROM influencers').count, 15);
  assert.equal(query('SELECT phone_key FROM influencers WHERE id = ?', phoneLaterId).phone_key, '+966555010456');

  const adjacentRows = importBody([
    { Name: 'Adjacent One', 'Username TikTok': 'adjacent_one_t', 'Username Instagram': 'adjacent_one_i', 'Followers Count Tiktok': '2500' },
    { Name: 'Adjacent Two', 'Username Snapchat': 'adjacent_two_s', 'Followers Count Snapchat': '7000' }
  ], 'adjacent-rows.csv');
  const adjacentImport = await importFile(adjacentRows, { confirmAllNew: true });
  assert.equal(adjacentImport.body.created, 2);
  const adjacentDb = db();
  const firstAdjacent = JSON.parse(adjacentDb.prepare(`SELECT record_json FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Adjacent One'`).get().record_json);
  const secondAdjacent = JSON.parse(adjacentDb.prepare(`SELECT record_json FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Adjacent Two'`).get().record_json);
  assert.equal(firstAdjacent['Username T'], 'adjacent_one_t');
  assert.equal(firstAdjacent['Username I'], 'adjacent_one_i');
  assert.equal(firstAdjacent['Username'] || '', '');
  assert.equal(firstAdjacent['Followers Count T'], '2500');
  assert.equal(secondAdjacent['Username'], 'adjacent_two_s');
  assert.equal(secondAdjacent['Username T'] || '', '');
  assert.equal(secondAdjacent['Followers Count S'], '7000');
  adjacentDb.close();

  const duplicateRowsInFile = importBody([
    { Name: 'Repeated Handle One', 'Username Instagram': 'repeated_file_handle' },
    { Name: 'Repeated Handle Two', 'Username Instagram': '@REPEATED_FILE_HANDLE' }
  ], 'duplicate-handle-rows.csv');
  const duplicateReview = await preview(duplicateRowsInFile);
  assert.equal(duplicateReview.integrity.needsReview, 2);
  assert.equal(duplicateReview.integrity.issues.filter(issue => issue.reason === 'duplicate-account-in-file').length, 2);
  const duplicateImport = await importFile(duplicateRowsInFile, { confirmAllNew: true });
  assert.equal(duplicateImport.body.created, 0);
  assert.equal(duplicateImport.body.failed, 2);

  const phoneVariant = importBody([{
    Full_Mobile_Number: '+966 5 5501 0001',
    'Username Instagram': 'INST_ALIAS_CREATOR',
    City: 'Jeddah'
  }], 'phone-variant.csv');
  const phoneUpdate = await importFile(phoneVariant, { confirmAllNew: true });
  assert.equal(phoneUpdate.status, 200, JSON.stringify(phoneUpdate.body));
  assert.equal(phoneUpdate.body.matchedByAccount, 1);
  assert.equal(phoneUpdate.body.unchanged, 1);
  const updatedDb = db();
  const updatedRecord = JSON.parse(updatedDb.prepare('SELECT record_json FROM influencers WHERE id = ?').get(creator.id).record_json);
  assert.equal(updatedRecord.City, 'Jeddah');
  assert.equal(updatedRecord.Number, '555010001');
  updatedDb.close();

  const arabicPhone = await importFile(importBody([{
    Name: 'Arabic Digit Phone',
    Number: '٠٥٥٥٠١٠٠٠٧',
    'Username Instagram': 'arabic_phone_creator'
  }], 'arabic-phone.csv'), { confirmAllNew: true });
  assert.equal(arabicPhone.body.created, 1);
  const arabicPhoneUpdate = await importFile(importBody([{
    Full_Mobile_Number: '+966555010007',
    'Username Instagram': 'ARABIC_PHONE_CREATOR',
    City: 'Riyadh'
  }], 'arabic-phone-variant.csv'));
  assert.equal(arabicPhoneUpdate.body.matchedByAccount, 1);
  assert.equal(arabicPhoneUpdate.body.updated, 1);

  const allNew = importBody([{ Name: 'All New Guard', Number: '0555010008', 'Username Instagram': 'all_new_guard' }], 'all-new.csv');
  const allNewPreview = await preview(allNew);
  assert.equal(allNewPreview.allNewConfirmationRequired, true);
  const blockedAllNew = await call('/api/import', { ...allNew, previewId: allNewPreview.previewId });
  assert.equal(blockedAllNew.status, 409);
  const allNewCommit = await importFile(allNew, { confirmAllNew: true });
  assert.equal(allNewCommit.body.created, 1);
  const allNewId = query(`SELECT id FROM influencers WHERE json_extract(record_json, '$.Name') = 'All New Guard'`).id;
  assert.equal((await call(`/api/influencers/${allNewId}`, {}, 'DELETE')).status, 200);
  const archivedMatch = importBody([{
    Full_Mobile_Number: '+966555010008', 'Username Instagram': 'all_new_guard', City: 'Restored City'
  }], 'archived-match.csv');
  const archivedPreview = await preview(archivedMatch);
  assert.equal(archivedPreview.restoreArchivedMatches, 1);
  assert.equal(archivedPreview.integrity.issues[0].reason, 'archived-match-needs-restore');
  const archivedBlocked = await call('/api/import', {
    ...archivedMatch, previewId: archivedPreview.previewId, confirmAllNew: true
  });
  assert.equal(archivedBlocked.body.created, 0);
  assert.equal(archivedBlocked.body.failed, 1);
  const restored = await importFile(archivedMatch, { restoreArchivedMatches: true });
  assert.equal(restored.body.updated, 1, JSON.stringify(restored.body));
  assert.equal(query('SELECT archived_at FROM influencers WHERE id = ?', allNewId).archived_at, null);

  const noIdentityFile = importBody([{ Name: '' }], 'empty-identity.csv');
  const emptyPreview = await preview(noIdentityFile);
  assert.equal(emptyPreview.identityRejected, true);
  assert.match(emptyPreview.identityError, /No rows contain a valid phone or social account/);
  const emptyCommit = await call('/api/import', { ...noIdentityFile, previewId: emptyPreview.previewId });
  assert.equal(emptyCommit.status, 400);
  assert.match(emptyCommit.body.error, /لا يحتوي الملف/);

  const accountOnly = importBody([{
    Name: 'Synthetic Alias Creator',
    'Username Instagram': '@  INST_ALIAS_CREATOR '
  }], 'account-only.csv');
  const accountPreview = await preview(accountOnly);
  assert.equal(accountPreview.integrity.matchedByAccount, 1);
  assert.equal(accountPreview.integrity.needsReview, 0);
  assert.equal(accountPreview.integrity.unchanged, 1);
  const accountCommit = await call('/api/import', { ...accountOnly, previewId: accountPreview.previewId });
  assert.equal(accountCommit.body.created, 0);
  assert.equal(accountCommit.body.updated, 0);
  assert.equal(accountCommit.body.failed, 0);

  const approvalSeed = importBody(Array.from({ length: 100 }, (_, index) => ({
    Name: `Synthetic Account Match ${index + 1}`,
    'Username Instagram': `approval_match_${index + 1}`,
    City: 'Old Synthetic City',
    Note: 'Keep this synthetic note'
  })), 'account-approval-seed.csv');
  const approvalSeedImport = await importFile(approvalSeed, { confirmAllNew: true });
  assert.equal(approvalSeedImport.status, 200, JSON.stringify(approvalSeedImport.body));
  assert.equal(approvalSeedImport.body.created, 100);
  const changedAccountRows = approvalSeed.rows.map(row => ({ ...row, City: 'New Synthetic City', Note: '' }));
  const accountReimport = importBody(changedAccountRows, 'account-approval-update.csv');
  const accountReimportPreview = await preview(accountReimport);
  assert.equal(accountReimportPreview.integrity.matchedByAccount, 100);
  assert.equal(accountReimportPreview.integrity.updates, 100);
  const approvedReimport = await importFile(accountReimport);
  assert.equal(approvedReimport.status, 200, JSON.stringify(approvedReimport.body));
  assert.equal(approvedReimport.body.updated, 100);
  assert.equal(approvedReimport.body.created, 0);
  assert.equal(approvedReimport.body.failed, 0);
  const updatedSynthetic = query(`SELECT record_json FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic Account Match 1'`);
  assert.equal(JSON.parse(updatedSynthetic.record_json).City, 'New Synthetic City');
  assert.equal(JSON.parse(updatedSynthetic.record_json).Note, 'Keep this synthetic note');
  const accountBatchUndo = await call(`/api/import/batches/${approvedReimport.body.batchId}/undo`, {});
  assert.equal(accountBatchUndo.status, 200, JSON.stringify(accountBatchUndo.body));
  assert.equal(accountBatchUndo.body.undone, 100);
  const restoredSynthetic = query(`SELECT record_json FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic Account Match 1'`);
  assert.equal(JSON.parse(restoredSynthetic.record_json).City, 'Old Synthetic City');

  const pairedOwners = importBody([
    { Name: 'Synthetic Owner One', Number: '0555010002', 'Username Tiktok': 'owner_one' },
    { Name: 'Synthetic Owner Two', Number: '0555010003', 'Username Instagram': 'owner_two' }
  ], 'owners.csv');
  const ownersImport = await importFile(pairedOwners, { confirmAllNew: true });
  assert.equal(ownersImport.body.created, 2);
  const crossOwnerSource = importBody([{
    'Username Tiktok': 'OWNER_ONE',
    'Username Instagram': 'owner_two'
  }], 'cross-owner.csv');
  const crossOwner = await preview(crossOwnerSource);
  assert.equal(crossOwner.integrity.needsReview, 1);
  assert.equal(crossOwner.integrity.issues[0].reason, 'identity-conflict');
  const approvedCrossOwner = await call('/api/import', {
    ...crossOwnerSource,
    previewId: crossOwner.previewId, approveAccountMatches: true, confirmAllNew: true
  });
  assert.equal(approvedCrossOwner.body.created, 0);
  assert.equal(approvedCrossOwner.body.updated, 0);
  assert.equal(approvedCrossOwner.body.failed, 1);

  const phoneAccountOwner = await importFile(importBody([{
    Name: 'Synthetic Phone Account Owner',
    Full_Mobile_Number: '+966555010011',
    'Username Instagram': 'phone_account_owner'
  }], 'phone-account-owner.csv'), { confirmAllNew: true });
  assert.equal(phoneAccountOwner.body.created, 1);
  const phoneAccountMismatch = importBody([{
    'Username Instagram': 'phone_account_owner',
    Full_Mobile_Number: '+966555010012',
    City: 'Must Stay Review'
  }], 'phone-account-mismatch.csv');
  const phoneMismatchPreview = await preview(phoneAccountMismatch);
  assert.equal(phoneMismatchPreview.integrity.issues[0].reason, 'phone-number-changed-needs-review');
  const approvedPhoneMismatch = await call('/api/import', {
    ...phoneAccountMismatch, previewId: phoneMismatchPreview.previewId,
    approveAccountMatches: true, confirmAllNew: true
  });
  assert.equal(approvedPhoneMismatch.body.created, 0);
  assert.equal(approvedPhoneMismatch.body.updated, 0);
  assert.equal(approvedPhoneMismatch.body.failed, 1);

  const duplicateRows = importBody([
    { Name: 'Duplicate Row One', Number: '0555010004', 'Username Snapchat': 'same_handle' },
    { Name: 'Duplicate Row Two', Number: '0555010005', 'Username Snapchat': '@ SAME_HANDLE ' }
  ], 'duplicate-account.csv');
  const duplicatePreview = await preview(duplicateRows);
  assert.equal(duplicatePreview.integrity.issues.filter(issue => issue.reason === 'duplicate-account-in-file').length, 2);
  const duplicateCommit = await call('/api/import', {
    ...duplicateRows, previewId: duplicatePreview.previewId, confirmAllNew: true, approveAccountMatches: true
  });
  assert.equal(duplicateCommit.body.created, 0);
  assert.equal(duplicateCommit.body.failed, 2);

  const freshRecord = importBody([{ Name: 'Undo Candidate', Number: '0555010006', 'Username Instagram': 'undo_candidate' }], 'undo.csv');
  const undoImport = await importFile(freshRecord, { confirmAllNew: true });
  assert.equal(undoImport.body.created, 1);
  const undoResponse = await call(`/api/import/batches/${undoImport.body.batchId}/undo`, {});
  assert.equal(undoResponse.status, 200, JSON.stringify(undoResponse.body));
  assert.equal(undoResponse.body.undone, 1);
  assert.equal(query(`SELECT COUNT(*) AS count FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Undo Candidate'`).count, 0);

  const linkedRecordImport = await importFile(importBody([{
    Name: 'Linked Undo Candidate', Number: '0555010009', 'Username Instagram': 'linked_undo_candidate'
  }], 'linked-undo.csv'), { confirmAllNew: true });
  const linkedDb = db();
  const linkedId = linkedDb.prepare(`SELECT id FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Linked Undo Candidate'`).get().id;
  linkedDb.prepare(`INSERT INTO influencer_profile_images
    (influencer_id, mime_type, image_data, content_hash, updated_at)
    VALUES (?, 'image/png', ?, 'synthetic-hash', ?)`)
    .run(linkedId, Buffer.from([1, 2, 3]), new Date().toISOString());
  linkedDb.close();
  const linkedUndo = await call(`/api/import/batches/${linkedRecordImport.body.batchId}/undo`, {});
  assert.equal(linkedUndo.body.undone, 0);
  assert.equal(linkedUndo.body.skipped, 1);
  assert.equal(linkedUndo.body.issues[0].reason, 'has-linked-data');

  const beforeUndoUpdate = importBody([{
    'Username Instagram': 'inst_alias_creator', City: 'First Imported City'
  }], 'undo-update-one.csv');
  const firstUpdate = await importFile(beforeUndoUpdate);
  const laterUpdate = await importFile(importBody([{
    'Username Instagram': 'inst_alias_creator', City: 'Later City'
  }], 'undo-update-two.csv'));
  assert.equal(firstUpdate.body.updated, 1);
  assert.equal(laterUpdate.body.updated, 1);
  const protectedUndo = await call(`/api/import/batches/${firstUpdate.body.batchId}/undo`, {});
  assert.equal(protectedUndo.body.undone, 0);
  assert.equal(protectedUndo.body.skipped, 1);
  assert.equal(protectedUndo.body.issues[0].reason, 'changed-after-import');
  const latest = query('SELECT record_json FROM influencers WHERE id = ?', creator.id);
  assert.equal(JSON.parse(latest.record_json).City, 'Later City');

  const uniqueDb = db();
  uniqueDb.function('account_username', { deterministic: true }, value =>
    String(value || '').normalize('NFKC').trim().replace(/^@+/, '').replace(/\s+/gu, '').toLocaleLowerCase('en-US'));
  uniqueDb.function('country_iso', { deterministic: true }, value =>
    ({ 'Saudi Arabia': 'SA', UAE: 'AE' }[String(value || '').trim()] || ''));
  uniqueDb.function('workflow_status', { deterministic: true }, value =>
    String(value || '').trim().toLocaleLowerCase('en-US'));
  uniqueDb.function('normalized_filter', { deterministic: true }, (_field, value) =>
    String(value || '').trim().toLocaleLowerCase('en-US'));
  const account = uniqueDb.prepare('SELECT platform, normalized_username FROM influencer_accounts LIMIT 1').get();
  assert.ok(account);
  const dummyId = 'f'.repeat(32);
  uniqueDb.prepare('INSERT INTO influencers (id, record_json) VALUES (?, ?)').run(dummyId, '{}');
  assert.throws(() => uniqueDb.prepare(`INSERT INTO influencer_accounts
    (influencer_id, platform, normalized_username) VALUES (?, ?, ?)`)
    .run(dummyId, account.platform, account.normalized_username), /UNIQUE constraint failed/);
  uniqueDb.prepare('INSERT INTO influencers (id, record_json, phone_key) VALUES (?, ?, ?)')
    .run('e'.repeat(32), '{}', creator.phone_key);
  assert.equal(uniqueDb.prepare('SELECT COUNT(*) AS count FROM influencers WHERE phone_key = ?')
    .get(creator.phone_key).count, 2);
  uniqueDb.prepare('DELETE FROM influencers WHERE id = ?').run(dummyId);
  uniqueDb.prepare('DELETE FROM influencers WHERE id = ?').run('e'.repeat(32));
  uniqueDb.close();

  const legacyDb = db();
  legacyDb.function('account_username', { deterministic: true }, value =>
    String(value || '').normalize('NFKC').trim().replace(/^@+/, '').replace(/\s+/gu, '').toLocaleLowerCase('en-US'));
  legacyDb.function('country_iso', { deterministic: true }, value =>
    ({ 'Saudi Arabia': 'SA', UAE: 'AE' }[String(value || '').trim()] || ''));
  legacyDb.function('workflow_status', { deterministic: true }, value =>
    String(value || '').trim().toLocaleLowerCase('en-US'));
  legacyDb.function('normalized_filter', { deterministic: true }, (_field, value) =>
    String(value || '').trim().toLocaleLowerCase('en-US'));
  const legacyRecord = JSON.parse(legacyDb.prepare('SELECT record_json FROM influencers WHERE id = ?').get(creator.id).record_json);
  legacyRecord['Username Tiktok'] = legacyRecord['Username T'];
  delete legacyRecord['Username T'];
  legacyDb.prepare('UPDATE influencers SET record_json = ? WHERE id = ?').run(JSON.stringify(legacyRecord), creator.id);
  legacyDb.prepare('INSERT INTO influencers (id, record_json) VALUES (?, ?)')
    .run('a'.repeat(32), JSON.stringify({ Name: 'Synthetic Alias Conflict', 'Username Tiktok': 'owner_one' }));
  legacyDb.close();
  const aliasPlan = await call('/api/import/legacy-account-aliases/preview', undefined, 'GET');
  assert.equal(aliasPlan.status, 200);
  assert.deepEqual({
    recordsToNormalize: aliasPlan.body.recordsToNormalize,
    fieldsCopied: aliasPlan.body.fieldsCopied,
    conflicts: aliasPlan.body.conflicts,
    conflictingAccountGroups: aliasPlan.body.conflictingAccountGroups,
    tiktok: aliasPlan.body.byPlatform.TikTok
  }, {
    recordsToNormalize: 1,
    fieldsCopied: 1,
    conflicts: 1,
    conflictingAccountGroups: 1,
    tiktok: 1
  });
  const aliasApply = await call('/api/import/legacy-account-aliases/normalize', {
    confirm: 'normalize-account-aliases'
  });
  assert.equal(aliasApply.status, 200, JSON.stringify(aliasApply.body));
  assert.equal(aliasApply.body.updatedRows, 1);
  const normalizedAliasRecord = JSON.parse(query('SELECT record_json FROM influencers WHERE id = ?', creator.id).record_json);
  assert.equal(normalizedAliasRecord['Username T'], 'test.handle');
  assert.equal(Object.hasOwn(normalizedAliasRecord, 'Username Tiktok'), false);
  assert.equal(query(`SELECT COUNT(*) AS count FROM influencer_accounts
    WHERE influencer_id = ? AND platform = 'TikTok' AND normalized_username = 'test.handle'`, creator.id).count, 1);
  t.diagnostic('Username identity matching, shared phone storage, batch undo, and platform-account uniqueness verified on isolated SQLite database.');
});

test('follower imports round suffixed values and warn without skipping invalid counts', { concurrency: false }, async () => {
  const roundedFollowerImport = await importFile(importBody([{
    Name: 'Synthetic Rounded Follower Creator',
    'Username Instagram': 'rounded_follower_creator',
    'Followers Count Instagram': '99.9999K'
  }]), { confirmAllNew: true });
  assert.equal(roundedFollowerImport.body.created, 1);
  assert.equal(roundedFollowerImport.body.failed, 0);
  assert.equal(query(`SELECT json_extract(record_json, '$."Followers Count I"') AS count FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic Rounded Follower Creator'`).count, '100000');

  const source = importBody([
    { Name: 'Synthetic Invalid Follower Creator', 'Username Instagram': 'invalid_follower_creator', 'Followers Count Instagram': '9.9' },
    { Name: 'Synthetic Valid Follower Creator', 'Username Instagram': 'valid_follower_creator', 'Followers Count Instagram': '10K' }
  ], 'invalid-follower.csv');
  const previewResult = await preview(source);
  assert.deepEqual(previewResult.integrity.warnings.map(({ row, reason }) => ({ row, reason })), [
    { row: 1, reason: 'invalid-follower-count' }
  ]);
  assert.deepEqual({
    creates: previewResult.integrity.creates,
    issues: previewResult.integrity.issues.length
  }, { creates: 2, issues: 0 });
  const imported = await importFile(source, { confirmAllNew: true });
  assert.equal(imported.body.created, 2);
  assert.equal(imported.body.failed, 0);
  assert.deepEqual(imported.body.warnings.map(({ row, reason }) => ({ row, reason })), [
    { row: 1, reason: 'invalid-follower-count' }
  ]);
  assert.equal(query(`SELECT json_extract(record_json, '$."Followers Count I"') AS count FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic Invalid Follower Creator'`).count, '');
  assert.equal(query(`SELECT json_extract(record_json, '$."Followers Count I"') AS count FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic Valid Follower Creator'`).count, '10000');
});

test('a unique account match takes precedence over a shared phone across repeated previews', { concurrency: false }, async () => {
  const phoneHolder = await importFile(importBody([{
    Name: 'Synthetic Shared Phone Holder',
    Number: '0555010777',
    'Username Instagram': 'shared_phone_holder'
  }], 'shared-phone-holder.csv'), { confirmAllNew: true });
  assert.equal(phoneHolder.body.created, 1);
  const owner = await importFile(importBody([{
    Name: 'Synthetic Account Without Phone',
    'Username Instagram': 'account_without_phone'
  }], 'account-without-phone.csv'), { confirmAllNew: true });
  assert.equal(owner.body.created, 1);

  const source = importBody([{
    'Username Instagram': 'account_without_phone',
    Number: '0555010777'
  }], 'account-shared-with-account.csv');
  const firstPreview = await preview(source);
  const secondPreview = await preview(source);
  for (const result of [firstPreview, secondPreview]) {
    assert.deepEqual({
      updates: result.integrity.updates,
      needsReview: result.integrity.needsReview,
      sharedPhoneRows: result.integrity.sharedPhoneRows,
      issues: result.integrity.issues
    }, { updates: 1, needsReview: 0, sharedPhoneRows: [1], issues: [] });
  }
  const imported = await importFile(source);
  assert.equal(imported.body.updated, 1);
  assert.equal(imported.body.failed, 0);
  assert.equal(imported.body.sharedPhones, 1);
  assert.equal(query(`SELECT json_extract(record_json, '$."Phone Shared"') AS shared FROM influencers
    WHERE json_extract(record_json, '$."Username I"') = 'account_without_phone'`).shared, 'رقم مشترك');
});

test('Campaign Ref is ignored while other unknown import columns remain blocked', { concurrency: false }, async () => {
  const accepted = importBody([{
    Name: 'Synthetic Campaign Ref Creator',
    'Username I': 'campaign_ref_creator',
    'Campaign Ref': 'synthetic-campaign-reference'
  }], 'campaign-ref.csv');
  const acceptedPreview = await preview(accepted);
  assert.deepEqual(acceptedPreview.unknownColumns, []);
  assert.equal(acceptedPreview.importBlocked, false);
  const imported = await importFile(accepted, { confirmAllNew: true });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.created, 1);
  const record = JSON.parse(query(`SELECT record_json FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic Campaign Ref Creator'`).record_json);
  assert.equal(Object.hasOwn(record, 'Campaign Ref'), false);

  const unknown = importBody([{
    Name: 'Synthetic Unknown Column Creator',
    'Username I': 'unknown_column_creator',
    'Campaign Ref': 'synthetic-campaign-reference',
    'Unrecognized Fixture Column': 'must-block'
  }], 'campaign-ref-with-unknown.csv');
  const unknownPreview = await preview(unknown);
  assert.deepEqual(unknownPreview.unknownColumns, ['Unrecognized Fixture Column']);
  assert.equal(unknownPreview.importBlocked, true);
});

test('alignment preview warns for Instagram and TikTok but not Snapchat', { concurrency: false }, async () => {
  const result = await preview(importBody([{
    Name: 'Synthetic Alignment Creator',
    'Username I': 'alignment_instagram',
    'Username T': 'alignment_tiktok',
    Username: 'alignment_snapchat'
  }], 'alignment.csv'));
  assert.deepEqual(result.alignmentWarnings.map((warning) => warning.platform).sort(), ['Instagram', 'TikTok']);
  assert.ok(result.alignmentWarnings.every((warning) => warning.reason === 'username-without-followers'));
});

test('short and country-code-only phones are missing and can be added later', { concurrency: false }, async () => {
  const phoneRows = [
    { Name: 'Synthetic Empty Phone', 'Country Code': '966', Number: '', 'Username I': 'missing_phone_empty' },
    { Name: 'Synthetic Short Phone', 'Country Code': '+974', Number: '123456', 'Username I': 'missing_phone_short' },
    ...['966', '974', '971', '965', '20'].map((dialCode, index) => ({
      Name: `Synthetic Dial Code Only ${index}`,
      'Country Code': `+${dialCode}`,
      Number: dialCode,
      'Username I': `missing_phone_dial_code_${index}`
    }))
  ];
  const body = importBody(phoneRows, 'missing-phones.csv');
  const previewResult = await preview(body);
  assert.equal(previewResult.integrity.creates, phoneRows.length);
  assert.equal(previewResult.integrity.sharedPhoneRows.length, 0);
  const imported = await importFile(body, { confirmAllNew: true });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.created, phoneRows.length);
  assert.equal(imported.body.sharedPhones, 0);

  const phoneDb = db();
  for (const row of phoneRows) {
    const saved = phoneDb.prepare(`SELECT id, record_json, phone_key FROM influencers
      WHERE json_extract(record_json, '$.Name') = ?`).get(row.Name);
    const record = JSON.parse(saved.record_json);
    assert.equal(saved.phone_key, null);
    assert.equal(record.Number, '');
    assert.equal(record.Full_Mobile_Number, '');
    assert.equal(Object.hasOwn(record, 'Phone Shared'), false);
  }
  const validFullNumber = '966555000123';
  const validBody = importBody([{
    Name: 'Synthetic Valid Full Phone',
    'Country Code': '+966',
    Full_Mobile_Number: validFullNumber,
    'Username I': 'valid_full_phone_creator'
  }], 'valid-full-phone.csv');
  const validImported = await importFile(validBody, { confirmAllNew: true });
  assert.equal(validImported.status, 200, JSON.stringify(validImported.body));
  const validSaved = phoneDb.prepare(`SELECT record_json FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic Valid Full Phone'`).get();
  assert.equal(JSON.parse(validSaved.record_json).Full_Mobile_Number, `+${validFullNumber}`);

  const latePhoneBody = importBody([{
    'Username I': 'missing_phone_empty',
    'Country Code': '+966',
    Number: '555000456'
  }], 'phone-added-later.csv');
  const latePhone = await importFile(latePhoneBody);
  assert.equal(latePhone.body.created, 0);
  assert.equal(latePhone.body.updated, 1);
  const laterSaved = phoneDb.prepare(`SELECT phone_key FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic Empty Phone'`).get();
  assert.equal(laterSaved.phone_key, '+966555000456');
  phoneDb.close();
});

test('dashboard blocks unknown columns and exposes the review download before batch undo', { concurrency: false }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(baseUrl);
    await page.locator('#login-username').fill('import-admin');
    await page.locator('#login-password').fill('Import-test-password-2026!');
    await page.locator('#login-form button[type="submit"]').click();
    await page.locator('#app-shell .app-topbar').waitFor();
    await page.locator('#database-tab').click();
    await page.locator('#import-data-input').setInputFiles({
      name: 'dashboard-import.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Name,Country Code,Number,Username I,Unknown Column\nDashboard Synthetic,+966,555010099,dashboard_synthetic,review-me')
    });
    await page.locator('#import-preview-button').click();
    await page.locator('#import-review-download:not([hidden])').waitFor();
    assert.equal(await page.locator('#import-start-button').isDisabled(), true);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#import-review-download').click();
    await downloadPromise;
    assert.equal(query(`SELECT COUNT(*) AS count FROM influencers
      WHERE json_extract(record_json, '$.Name') = 'Dashboard Synthetic'`).count, 0);
    await page.locator('#import-clear-button').click();
    await page.locator('#import-data-input').setInputFiles({
      name: 'dashboard-import-valid.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Name,Country Code,Number,Username I\nDashboard Synthetic,+966,555010099,dashboard_synthetic')
    });
    await page.locator('#import-preview-button').click();
    await page.locator('#import-preview:not([hidden])').waitFor();
    const allNewGate = page.locator('#import-all-new-wrap');
    if (await allNewGate.isVisible()) {
      assert.equal(await page.locator('#import-start-button').isDisabled(), true);
      await page.locator('#import-all-new-confirm').check();
    }
    assert.equal(await page.locator('#import-start-button').isDisabled(), false);
    await page.locator('#import-start-button').click();
    await page.locator('#import-report-dialog[open]').waitFor();
    assert.equal(await page.locator('#import-undo-button').isVisible(), true);
    await page.locator('#import-undo-button').click();
    await page.waitForFunction(() => !document.querySelector('#import-report-dialog').open);
    assert.equal(query(`SELECT COUNT(*) AS count FROM influencers
      WHERE json_extract(record_json, '$.Name') = 'Dashboard Synthetic'`).count, 0);
  } finally {
    await browser.close();
  }
});

test('admin header stays within desktop and mobile widths across languages and themes', { concurrency: false }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(baseUrl);
    await page.locator('#login-username').fill('import-admin');
    await page.locator('#login-password').fill('Import-test-password-2026!');
    await page.locator('#login-form button[type="submit"]').click();
    await page.locator('#app-shell .app-topbar').waitFor();
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 820 });
      for (const language of ['ar', 'en']) {
        const currentLanguage = await page.locator('html').getAttribute('lang');
        if (currentLanguage !== language) await page.locator('#app-language-toggle').click();
        for (const theme of ['light', 'dark']) {
          const currentTheme = await page.locator('html').getAttribute('data-theme');
          if (currentTheme !== theme) await page.locator('#app-theme-toggle').click();
          const layout = await page.evaluate(() => {
            const header = document.querySelector('#app-shell .app-topbar');
            const context = header.querySelector('.app-topbar-context').getBoundingClientRect();
            const tools = header.querySelector('.topbar-tools').getBoundingClientRect();
            return {
              viewport: document.documentElement.clientWidth,
              document: document.documentElement.scrollWidth,
              context: { left: context.left, right: context.right },
              tools: { left: tools.left, right: tools.right }
            };
          });
          assert.ok(layout.document <= layout.viewport, `Header overflows at ${width}px`);
          assert.ok(layout.context.right <= layout.tools.left || layout.tools.right <= layout.context.left,
            `Header controls overlap at ${width}px`);
        }
      }
    }
  } finally {
    await browser.close();
  }
});

test('3,051-row synthetic import, exact repeat, and 100 updates plus 50 new rows', { concurrency: false }, async t => {
  const initialCount = query('SELECT COUNT(*) AS count FROM influencers').count;
  const rows = Array.from({ length: 3051 }, (_, index) => {
    const suffix = String(index + 1).padStart(8, '0');
    return {
      Name: `Synthetic Scale ${suffix}`,
      'Country Code': '+966',
      Number: `5${suffix}`,
      'Username Tiktok': `scale_${suffix}`,
      'Followers Count T': String(10000 + index)
    };
  });
  const source = importBody(rows, 'synthetic-3051.csv');
  const started = performance.now();
  const imported = await importFile(source, { confirmAllNew: true });
  const firstDuration = performance.now() - started;
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.created, 3051);
  assert.equal(imported.body.failed, 0);
  const repeatStarted = performance.now();
  const repeated = await importFile(source);
  const repeatDuration = performance.now() - repeatStarted;
  assert.equal(repeated.body.created, 0);
  assert.equal(repeated.body.updated, 0);
  assert.equal(repeated.body.unchanged, 3051);
  const saved = db();
  assert.equal(saved.prepare(`SELECT COUNT(*) AS count FROM influencers
    WHERE json_extract(record_json, '$.Name') LIKE 'Synthetic Scale %'`).get().count, 3051);
  saved.close();

  const changedAndNew = rows.slice(0, 100).map(row => ({ ...row, City: 'Synthetic Updated City' }));
  changedAndNew.push(...Array.from({ length: 50 }, (_, index) => {
    const suffix = String(index + 4000).padStart(8, '0');
    return {
      Name: `Synthetic New ${suffix}`,
      'Country Code': '+966',
      Number: `5${suffix}`,
      'Username Tiktok': `new_${suffix}`,
      'Followers Count T': '5000'
    };
  }));
  const mixed = await importFile(importBody(changedAndNew, 'synthetic-mix.csv'));
  assert.equal(mixed.body.updated, 100);
  assert.equal(mixed.body.created, 50);
  assert.equal(mixed.body.failed, 0);
  const finalDb = db();
  assert.equal(finalDb.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, initialCount + 3051 + 50);
  assert.equal(finalDb.prepare(`SELECT COUNT(*) AS count FROM influencers
    WHERE json_extract(record_json, '$.City') = 'Synthetic Updated City'`).get().count, 100);
  finalDb.close();
  t.diagnostic(JSON.stringify({
    rows: 3051,
    firstImportMs: Math.round(firstDuration),
    repeatedImportMs: Math.round(repeatDuration),
    exactRepeatCreated: repeated.body.created,
    mixed: { updated: mixed.body.updated, created: mixed.body.created }
  }));
});
