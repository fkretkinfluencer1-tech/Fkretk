import { deflateRawSync, inflateRawSync } from 'node:zlib';

const maxRows = 1_048_576;
const maxColumns = 16_384;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function columnName(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function spreadsheetDate(value, header) {
  if (!/date|تاريخ/i.test(header)) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/);
  if (!match) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const serial = (timestamp - Date.UTC(1899, 11, 30)) / 86400000;
  return { value: serial, style: match[4] ? 4 : 2 };
}

function cellXml(value, header, reference, hyperlinkId, parseFollower) {
  if (value === null || value === undefined || value === '') return `<c r="${reference}"/>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (!Number.isSafeInteger(value) && Number.isInteger(value)) {
      return `<c r="${reference}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
    }
    return `<c r="${reference}"><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;

  const text = String(value);
  if (/followers?\s*count|عدد\s*المتابعين/i.test(header) && parseFollower) {
    const followerCount = parseFollower(text);
    if (Number.isFinite(followerCount)) return `<c r="${reference}" s="5"><v>${followerCount}</v></c>`;
  }
  const date = spreadsheetDate(text, header);
  if (date) return `<c r="${reference}" s="${date.style}"><v>${date.value}</v></c>`;
  const safeText = xmlEscape(text);
  const style = hyperlinkId ? ' s="3"' : '';
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${safeText}</t></is></c>`;
}

function hyperlinkTarget(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function worksheetXml(headers, rows, parseFollower) {
  const lastColumn = columnName(headers.length - 1);
  const lastRow = rows.length + 1;
  const widths = headers.map((header, column) => {
    let width = Math.min(42, Math.max(12, String(header).length + 2));
    for (const row of rows.slice(0, 100)) {
      const value = row[column];
      if (value !== null && value !== undefined) width = Math.min(42, Math.max(width, String(value).length + 2));
    }
    return `<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`;
  }).join('');
  const hyperlinks = [];
  const rowXml = [];
  const headerCells = headers.map((header, column) =>
    `<c r="${columnName(column)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(header)}</t></is></c>`
  ).join('');
  rowXml.push(`<row r="1">${headerCells}</row>`);

  rows.forEach((row, rowIndex) => {
    const excelRow = rowIndex + 2;
    const cells = headers.map((header, column) => {
      const value = row[column];
      const reference = `${columnName(column)}${excelRow}`;
      const hyperlinkId = hyperlinkTarget(value) && /(url|link|رابط)/i.test(header)
        ? `rId${hyperlinks.length + 1}` : '';
      if (hyperlinkId) hyperlinks.push({ reference, id: hyperlinkId, target: value });
      return cellXml(value, header, reference, hyperlinkId, parseFollower);
    }).join('');
    rowXml.push(`<row r="${excelRow}">${cells}</row>`);
  });

  const hyperlinkXml = hyperlinks.length
    ? `<hyperlinks>${hyperlinks.map((link) => `<hyperlink ref="${link.reference}" r:id="${link.id}"/>`).join('')}</hyperlinks>`
    : '';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
    + `<cols>${widths}</cols><sheetData>${rowXml.join('')}</sheetData>`
    + `<autoFilter ref="A1:${lastColumn}${lastRow}"/>${hyperlinkXml}</worksheet>`;
  const relationships = hyperlinks.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hyperlinks.map((link) => `<Relationship Id="${link.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(link.target)}" TargetMode="External"/>`).join('')}</Relationships>`
    : '';
  return { xml, relationships };
}

function workbookParts(headers, rows, parseFollower) {
  if (!headers.length || headers.length > maxColumns) throw new Error('عدد أعمدة Excel غير صالح.');
  if (rows.length + 1 > maxRows) throw new Error('عدد سجلات المعلنين يتجاوز الحد الأقصى لورقة Excel.');
  const sheet = worksheetXml(headers, rows, parseFollower);
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
  const rootRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="Influencers" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRelationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font><font><color rgb="FF0563C1"/><u/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF174A73"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`;
  const parts = [
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRelationships],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', workbookRelationships],
    ['xl/styles.xml', styles],
    ['xl/worksheets/sheet1.xml', sheet.xml]
  ];
  if (sheet.relationships) parts.push(['xl/worksheets/_rels/sheet1.xml.rels', sheet.relationships]);
  return parts;
}

function dosTimestamp(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function zipParts(parts) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  const timestamp = dosTimestamp();
  for (const [name, content] of parts) {
    const nameBytes = Buffer.from(name, 'utf8');
    const source = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(source);
    const checksum = crc32(source);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(timestamp.time, 10);
    local.writeUInt16LE(timestamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    localRecords.push(local, compressed);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(timestamp.time, 12);
    central.writeUInt16LE(timestamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralRecords.push(central);
    offset += local.length + compressed.length;
  }
  const centralSize = centralRecords.reduce((sum, record) => sum + record.length, 0);
  if (offset > 0xffffffff || centralSize > 0xffffffff) throw new Error('حجم ملف Excel يتجاوز الحد المدعوم.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, ...centralRecords, end]);
}

export function createXlsxWorkbook(headers, rows, { parseFollower } = {}) {
  return zipParts(workbookParts(headers, rows, parseFollower));
}

export function createInfluencerPhotoTemplate() {
  const rows = Array.from({ length: 51 }, (_, index) => {
    const row = index + 1;
    return `<row r="${row}"${row === 1 ? ' ht="28" customHeight="1"' : ' ht="82" customHeight="1"'}>`
      + (row === 1
        ? '<c r="A1" s="1" t="inlineStr"><is><t>Influencer ID</t></is></c><c r="B1" s="1" t="inlineStr"><is><t>Main Username</t></is></c><c r="C1" s="1" t="inlineStr"><is><t>Influencer Name</t></is></c><c r="D1" s="1" t="inlineStr"><is><t>Image File Name</t></is></c><c r="E1" s="1" t="inlineStr"><is><t>Optional Notes</t></is></c>'
        : `<c r="A${row}" s="2"/><c r="B${row}" s="2"/><c r="C${row}" s="2"/><c r="D${row}" s="2"/><c r="E${row}" s="2"/>`)
      + '</row>';
  }).join('');
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '</Types>';
  const rootRelationships = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<bookViews><workbookView/></bookViews><sheets><sheet name="Influencer Photos" sheetId="1" r:id="rId1"/></sheets>'
    + '</workbook>';
  const workbookRelationships = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>';
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF174A73"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf>'
    + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';
  const worksheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + '<cols><col min="1" max="1" width="38" customWidth="1"/><col min="2" max="2" width="30" customWidth="1"/><col min="3" max="3" width="28" customWidth="1"/><col min="4" max="4" width="34" customWidth="1"/><col min="5" max="5" width="32" customWidth="1"/></cols>'
    + `<sheetData>${rows}</sheetData><autoFilter ref="A1:E51"/></worksheet>`;
  return zipParts([
    ['[Content_Types].xml', contentTypes],
    ['_rels/.rels', rootRelationships],
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', workbookRelationships],
    ['xl/styles.xml', styles],
    ['xl/worksheets/sheet1.xml', worksheet]
  ]);
}

export function validateXlsxWorkbook(buffer, expectedDataRows) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('ملف Excel غير مكتمل.');
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 0xffff); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw new Error('ملف Excel غير صالح.');
  const count = buffer.readUInt16LE(endOffset + 10);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('فهرس ملف Excel غير صالح.');
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const sourceSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('بيانات ملف Excel غير صالحة.');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const source = method === 8 ? inflateRawSync(compressed) : method === 0 ? Buffer.from(compressed) : null;
    if (!source || source.length !== sourceSize || crc32(source) !== checksum) throw new Error('فشل التحقق من سلامة محتويات ملف Excel.');
    entries.set(name, source.toString('utf8'));
  }
  const workbook = entries.get('xl/workbook.xml');
  const sheet = entries.get('xl/worksheets/sheet1.xml');
  if (!workbook?.includes('name="Influencers"') || !sheet?.includes('<autoFilter ')
    || !sheet.includes('state="frozen"')) throw new Error('ملف Excel لا يحتوي على ورقة Influencers مكتملة.');
  const rows = (sheet.match(/<row r="/g) || []).length;
  if (rows !== expectedDataRows + 1) throw new Error('عدد الصفوف في ملف Excel لا يطابق عدد السجلات المصدّرة.');
  return true;
}
