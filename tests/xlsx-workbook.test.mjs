import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { createInfluencerPhotoTemplate, createXlsxWorkbook, validateXlsxWorkbook } from '../data-access/xlsx-workbook.mjs';

function unzipEntry(buffer, expectedName) {
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  assert.notEqual(endOffset, -1);
  let cursor = buffer.readUInt32LE(endOffset + 16);
  const count = buffer.readUInt16LE(endOffset + 10);
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name === expectedName) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const contentOffset = localOffset + 30 + localNameLength + localExtraLength;
      return inflateRawSync(buffer.subarray(contentOffset, contentOffset + compressedSize)).toString('utf8');
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Missing workbook part: ${expectedName}`);
}

test('creates and validates an Arabic-friendly full-data XLSX worksheet', () => {
  const workbook = createXlsxWorkbook(
    ['ID', 'Name', 'Main_Username', 'Followers Count I', 'Account Link', 'Updated Date', 'Note'],
    [['0000000000000000123', 'معلن تجريبي', '00123creator', '1,250,000', 'https://example.invalid/profile?a=1&b=2', '2026-10-19', '=1+1']],
    { parseFollower: (value) => Number(value.replaceAll(',', '')) }
  );

  assert.equal(validateXlsxWorkbook(workbook, 1), true);
  const sheet = unzipEntry(workbook, 'xl/worksheets/sheet1.xml');
  assert.match(sheet, /rightToLeft="1"/);
  assert.match(sheet, /state="frozen"/);
  assert.match(sheet, /autoFilter ref="A1:G2"/);
  assert.match(sheet, /معلن تجريبي/);
  assert.match(sheet, /00123creator/);
  assert.match(sheet, /<c r="D2" s="5"><v>1250000<\/v><\/c>/);
  assert.match(sheet, /<c r="F2" s="2"><v>/);
  assert.match(sheet, /<c r="G2" t="inlineStr"><is><t xml:space="preserve">=1\+1<\/t><\/is><\/c>/);
  assert.doesNotMatch(sheet, /<f>/);
  const relationships = unzipEntry(workbook, 'xl/worksheets/_rels/sheet1.xml.rels');
  assert.match(relationships, /Target="https:\/\/example.invalid\/profile\?a=1&amp;b=2"/);
});

test('rejects an Excel workbook with a mismatched record count', () => {
  const workbook = createXlsxWorkbook(['ID'], [['a']]);
  assert.throws(() => validateXlsxWorkbook(workbook, 0), /عدد الصفوف/);
});

test('photo template carries the ID-based image mapping columns', () => {
  const sheet = unzipEntry(createInfluencerPhotoTemplate(), 'xl/worksheets/sheet1.xml');
  for (const header of ['Influencer ID', 'Main Username', 'Influencer Name', 'Image File Name', 'Optional Notes']) {
    assert.ok(sheet.includes(`<t>${header}</t>`), `missing ${header}`);
  }
  assert.match(sheet, /autoFilter ref="A1:E51"/);
  assert.match(sheet, /rightToLeft="1"/);
});
