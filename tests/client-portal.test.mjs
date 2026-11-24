import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { deflateRawSync, deflateSync } from 'node:zlib';
import test, { after } from 'node:test';
import { chromium } from 'playwright';
import { assertSafeDbPath } from './db-guard.mjs';

const projectDir = new URL('..', import.meta.url);
const tempDir = await mkdtemp(join(tmpdir(), 'fikratak-client-portal-test-'));
const dataDir = join(tempDir, 'data');
const databasePath = join(dataDir, 'fikratak.sqlite');
const fixedClockPreloadPath = join(tempDir, 'fixed-clock.mjs');
await writeFile(fixedClockPreloadPath, `
const NativeDate = globalThis.Date;
const fixedTime = NativeDate.parse(process.env.FIKRATAK_TEST_NOW || '');
if (Number.isFinite(fixedTime)) {
  globalThis.Date = class FixedDate extends NativeDate {
    constructor(...args) {
      if (args.length) super(...args);
      else super(fixedTime);
    }

    static now() {
      return fixedTime;
    }
  };
}
`, 'utf8');
assertSafeDbPath(databasePath, 'test database');
await mkdir(dataDir, { recursive: true });

const influencerIds = ['a'.repeat(32), 'b'.repeat(32)];
let companyWorkPresentationToken = '';
let companyWorkPresentationVideoIds = [];
const fixture = new DatabaseSync(databasePath);
fixture.exec(`CREATE TABLE influencers (id TEXT PRIMARY KEY, record_json TEXT NOT NULL, phone_key TEXT UNIQUE)`);
const insertInfluencer = fixture.prepare('INSERT INTO influencers (id, record_json) VALUES (?, ?)');
insertInfluencer.run(influencerIds[0], JSON.stringify({
  Name: 'Visit Creator', Main_Username: 'visit_main_username', 'Best Platform': 'Instagram',
  'Username I': 'visit_creator', 'Followers Count I': '15000', Number: '555123456',
  Full_Mobile_Number: '+966555123456', 'Phone Shared': 'رقم مشترك',
  Price: '1000', Note: 'staff-only note',
  'Internal Notes': 'confidential staff note', 'Paid or Voucher': 'Paid',
  City: 'Riyadh', Area: 'Olaya', Gender: 'Female', Hijab: 'Yes',
  'Categories 1': 'Health', 'Categories 2': 'Beauty',
  Verified: 'Yes', Mawthouq: 'Yes'
}));
insertInfluencer.run(influencerIds[1], JSON.stringify({
  Name: 'Delivery Creator', Main_Username: 'delivery_creator', 'Best Platform': 'TikTok',
  'Username T': 'delivery_creator', 'Followers Count T': '20000', Number: '555999999',
  Full_Mobile_Number: '+966555999999', Price: '2000', Note: 'another private note', Gender: 'Male'
}));
insertInfluencer.run('c'.repeat(32), JSON.stringify({
  Name: 'Manual Visit Creator', Main_Username: 'manual_main_name', 'Best Platform': 'Snapchat',
  Username: 'manual_snap', Country: 'Saudi Arabia', Number: '555888888',
  Full_Mobile_Number: '+966555888888', Price: '3000', Note: 'manual fixture private note',
  Gender: 'Female'
}));
fixture.close();

const portProbe = createServer();
await new Promise((resolve, reject) => {
  portProbe.once('error', reject);
  portProbe.listen(0, '127.0.0.1', resolve);
});
const port = portProbe.address().port;
await new Promise((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));

const serverOptions = {
  cwd: projectDir,
  env: {
    ...process.env,
    PORT: String(port),
    FIKRATAK_DATA_DIR: dataDir,
    FIKRATAK_BACKUP_DIR: join(tempDir, 'backups')
  },
  stdio: ['ignore', 'ignore', 'pipe']
};
let serverErrors = '';
let server = spawn(process.execPath, ['--no-warnings', 'server.mjs'], serverOptions);
server.stderr.on('data', (chunk) => { serverErrors += chunk.toString(); });

function restartTestServer() {
  serverErrors = '';
  server = spawn(process.execPath, ['--no-warnings', 'server.mjs'], serverOptions);
  server.stderr.on('data', (chunk) => { serverErrors += chunk.toString(); });
}

async function restartTestServerAt(instant) {
  if (server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
  serverErrors = '';
  server = spawn(process.execPath, [
    '--no-warnings', '--import', pathToFileURL(fixedClockPreloadPath).href, 'server.mjs'
  ], {
    ...serverOptions,
    env: { ...serverOptions.env, FIKRATAK_TEST_NOW: instant }
  });
  server.stderr.on('data', (chunk) => { serverErrors += chunk.toString(); });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Test server stopped after clock setup: ${serverErrors}`);
    try {
      if ((await fetch(baseUrl)).status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Test server did not start with the fixed clock: ${serverErrors}`);
}

after(async () => {
  if (server.exitCode === null) {
    server.kill();
    await once(server, 'exit');
  }
  await rm(tempDir, { recursive: true, force: true });
});

const baseUrl = `http://127.0.0.1:${port}`;
let ready = false;
for (let attempt = 0; attempt < 200 && !ready; attempt += 1) {
  if (server.exitCode !== null) throw new Error(`Test server stopped during startup: ${serverErrors}`);
  try { ready = (await fetch(baseUrl)).status === 200; } catch {}
  if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
}
if (!ready) throw new Error(`Test server did not start: ${serverErrors}`);

const setup = await fetch(`${baseUrl}/api/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'portal-admin', password: 'Portal-admin-pass-2026!' })
});
assert.equal(setup.status, 201);
const adminCookie = setup.headers.get('set-cookie')?.split(';')[0];
assert.ok(adminCookie);

async function call(path, { cookie = adminCookie, ...options } = {}) {
  let requestOptions = options;
  if (path === '/api/import' && String(options.method || 'GET').toUpperCase() === 'POST'
    && options.body && typeof options.body === 'object' && !options.body.previewId) {
    const previewResponse = await fetch(`${baseUrl}/api/import/preview`, {
      method: 'POST',
      body: JSON.stringify(options.body),
      headers: {
        ...(cookie ? { cookie } : {}),
        'content-type': 'application/json',
        ...options.headers
      }
    });
    const previewBody = await previewResponse.json().catch(() => ({}));
    if (!previewResponse.ok) return { response: previewResponse, body: previewBody };
    requestOptions = {
      ...options,
      body: {
        ...options.body, previewId: previewBody.preview.previewId,
        acknowledgeUnknownColumns: true, confirmAllNew: true
      }
    };
  }
  const response = await fetch(`${baseUrl}${path}`, {
    ...requestOptions,
    body: requestOptions.body && typeof requestOptions.body !== 'string' ? JSON.stringify(requestOptions.body) : requestOptions.body,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(requestOptions.body ? { 'content-type': 'application/json' } : {}),
      ...requestOptions.headers
    }
  });
  return { response, body: await response.json().catch(() => ({})) };
}

async function mustCall(path, options = {}) {
  const result = await call(path, options);
  assert.ok(result.response.ok, `${path}: ${result.response.status} ${JSON.stringify(result.body)} ${serverErrors}`);
  return result.body;
}

function assertNoClientInfluencerPrivateData(value) {
  const privateKey = /^(?:number|full_mobile_number|country_code|phone_key|recipientphone|couriercontact|price|note|internal_notes|password_hash|token)$/i;
  const visit = (item) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== 'object') {
      if (typeof item === 'string') {
        const normalized = item.trim();
        if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(normalized)) {
          assert.doesNotMatch(normalized, /^\+?\d[\d\s().-]{7,}\d$/, 'Phone-like data must not be sent in influencer presentations.');
        }
      }
      return;
    }
    for (const [key, nested] of Object.entries(item)) {
      assert.equal(privateKey.test(key), false, `Private influencer field ${key} must not be sent to clients.`);
      visit(nested);
    }
  };
  visit(value);
}

async function mustExport(path, options = {}) {
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body || {};
  return mustCall(path, {
    ...options,
    method: 'POST',
    body: {
      ...body,
      confirmationUsername: 'portal-admin',
      confirmationPassword: 'Portal-admin-pass-2026!'
    }
  });
}

function createXlsx(rows, { images = [], inCellImages = [] } = {}) {
  const xml = value => String(value ?? '').replace(/[<>&'"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]);
  const columnName = number => {
    let result = '';
    while (number > 0) { number -= 1; result = String.fromCharCode(65 + number % 26) + result; number = Math.floor(number / 26); }
    return result;
  };
  const inCellRows = new Map(inCellImages.map((image, index) => [image.row, index]));
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
    const rowNumber = r + 1;
    if (c === 3 && inCellRows.has(rowNumber)) {
      return `<c r="D${rowNumber}" t="e" vm="${inCellRows.get(rowNumber) + 1}"><v>#VALUE!</v></c>`;
    }
    return `<c r="${columnName(c + 1)}${rowNumber}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const drawing = images.length
    ? '<drawing r:id="rIdDrawing"/>'
    : '';
  const entries = [
    ['xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Import" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', `<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${sheetRows}</sheetData>${drawing}</worksheet>`]
  ];
  if (images.length) {
    entries.push(
      ['xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rIdDrawing" Target="../drawings/drawing1.xml"/></Relationships>'],
      ['xl/drawings/drawing1.xml', `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${images.map((image, index) => {
        const row = image.row - 1;
        const column = image.column ?? 3;
        const toRow = image.toRow ?? row + 1;
        const toColumn = image.toColumn ?? column + 1;
        return `<xdr:twoCellAnchor><xdr:from><xdr:col>${column}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${toColumn}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:blipFill><a:blip r:embed="rId${index + 1}"/></xdr:blipFill></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;
      }).join('')}</xdr:wsDr>`],
      ['xl/drawings/_rels/drawing1.xml.rels', `<Relationships>${images.map((image, index) => `<Relationship Id="rId${index + 1}" Target="../media/image${index + 1}.${image.extension || 'png'}"/>`).join('')}</Relationships>`],
      ...images.map((image, index) => [`xl/media/image${index + 1}.${image.extension || 'png'}`, image.data])
    );
  }
  if (inCellImages.length) {
    entries.push(
      ['xl/cellimages.xml', `<etc:cellImages xmlns:etc="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${inCellImages.map((_, index) => `<etc:cellImage><xdr:pic><xdr:blipFill><a:blip r:embed="cellImage${index + 1}"/></xdr:blipFill></xdr:pic></etc:cellImage>`).join('')}</etc:cellImages>`],
      ['xl/_rels/cellimages.xml.rels', `<Relationships>${inCellImages.map((_, index) => `<Relationship Id="cellImage${index + 1}" Target="media/inCellImage${index + 1}.png"/>`).join('')}</Relationships>`],
      ['xl/richData/richValueRel.xml', `<richValueRels>${inCellImages.map((_, index) => `<rel r:id="rId${index + 1}"/>`).join('')}</richValueRels>`],
      ['xl/richData/_rels/richValueRel.xml.rels', `<Relationships>${inCellImages.map((_, index) => `<Relationship Id="rId${index + 1}" Target="../media/inCellImage${index + 1}.png"/>`).join('')}</Relationships>`],
      ['xl/richData/richValueData.xml', `<rvData>${inCellImages.map((_, index) => `<rv s="0"><v>${index}</v></rv>`).join('')}</rvData>`],
      ['xl/metadata.xml', `<metadata><metadataTypes><metadataType name="XLRICHVALUE"/></metadataTypes><futureMetadata name="XLRICHVALUE">${inCellImages.map((_, index) => `<bk><extLst><rvb i="${index}"/></extLst></bk>`).join('')}</futureMetadata><cellMetadata>${inCellImages.map((_, index) => `<bk><rc t="1" v="${index}"/></bk>`).join('')}</cellMetadata></metadata>`],
      ...inCellImages.map((image, index) => [`xl/media/inCellImage${index + 1}.png`, image.data])
    );
  }
  const zipEntries = entries.map(([name, value]) => ({ name: Buffer.from(name), data: Buffer.from(value) }));
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    return value >>> 0;
  });
  const crc32 = data => data.reduce((crc, byte) => crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8), 0xffffffff) ^ 0xffffffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of zipEntries) {
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data) >>> 0;
    const local = Buffer.alloc(30 + entry.name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(entry.name.length, 26); entry.name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + entry.name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(entry.name.length, 28);
    central.writeUInt32LE(offset, 42); entry.name.copy(central, 46);
    centrals.push(central); offset += local.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, central) => sum + central.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);   end.writeUInt16LE(zipEntries.length, 8);
  end.writeUInt16LE(zipEntries.length, 10); end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function createZip(files) {
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    return value >>> 0;
  });
  const crc32 = data => data.reduce((crc, byte) => crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8), 0xffffffff) ^ 0xffffffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [fileName, dataValue] of files) {
    const name = Buffer.from(fileName);
    const data = Buffer.from(dataValue);
    const compressed = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); name.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42); name.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, central) => sum + central.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function createPng(seed = 1) {
  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    return value >>> 0;
  });
  const crc32 = data => data.reduce((crc, byte) => crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8), 0xffffffff) ^ 0xffffffff;
  const chunk = (type, data) => {
    const typeBuffer = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  const pixel = Buffer.from([0, seed, seed, seed, 255]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixel)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function createJpeg(seed = 1) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, seed,
    0xff, 0xd9
  ]);
}

function createWebp(seed = 1) {
  const chunk = Buffer.alloc(18);
  chunk.write('VP8 ', 0, 'ascii');
  chunk.writeUInt32LE(10, 4);
  chunk[11] = 0x9d; chunk[12] = 0x01; chunk[13] = 0x2a;
  chunk.writeUInt16LE(1, 14); chunk.writeUInt16LE(seed || 1, 16);
  const buffer = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), chunk]);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  return buffer;
}

const editor = (await mustCall('/api/users', {
  method: 'POST',
  body: { username: 'portal-editor', role: 'editor', password: 'Portal-editor-pass-2026!' }
})).user;
const viewer = (await mustCall('/api/users', {
  method: 'POST',
  body: { username: 'portal-viewer', role: 'viewer', password: 'Portal-viewer-pass-2026!' }
})).user;
async function login(username, password, endpoint = '/api/login') {
  const result = await call(endpoint, { method: 'POST', cookie: '', body: { username, password } });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.response.headers.get('set-cookie')?.split(';')[0];
}
async function loginClient(email, password) {
  const result = await call('/api/client-portal/login', { method: 'POST', cookie: '', body: { email, password } });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.response.headers.get('set-cookie')?.split(';')[0];
}
const editorCookie = await login('portal-editor', 'Portal-editor-pass-2026!');
const viewerCookie = await login('portal-viewer', 'Portal-viewer-pass-2026!');

const period = { startDate: '2026-10-11', endDate: '2026-10-20' };
const visitCampaign = (await mustCall('/api/campaigns', {
  method: 'POST',
  body: {
    campaignName: 'Visit campaign', companyName: 'Client One Ltd', campaignType: 'visit',
    serviceType: 'influencer', ...period,
    targets: [{
      id: influencerIds[0], visitDate: '2026-10-14', visitTime: '15:30',
      visitCity: 'Riyadh', visitBranch: 'Test branch', visitAddress: 'Test visit address',
      visitStatus: 'pending_confirmation', visitNotes: 'Arrive on time', coverageNotes: 'Share the event'
    }]
  }
})).campaign;
const deliveryCampaign = (await mustCall('/api/campaigns', {
  method: 'POST',
  body: {
    campaignName: 'Delivery campaign', companyName: 'Client Two Ltd', campaignType: 'delivery',
    serviceType: 'ugc', ...period,
    targets: [{
      id: influencerIds[1], recipientName: 'Test Recipient', recipientPhone: '5551234567',
      courierContact: '5557654321', deliveryCity: 'Riyadh', deliveryDistrict: 'North',
      deliveryAddress: 'Test shipping address', deliveryMapLink: 'https://maps.example.test/place',
      orderDetails: 'Test items',
      shippingStatus: 'in_progress', shippingCarrier: 'Local Courier',
      trackingNumber: 'TRACK-123', deliveryDate: '2026-10-18'
    }]
  }
})).campaign;

const clientOne = (await mustCall('/api/client-accounts', {
  method: 'POST',
  body: {
    username: 'client-one', email: 'client.one@example.test', internalNotes: 'Internal test note', clientName: 'Client One', companyName: 'Client One Ltd',
    password: 'Client-one-pass-2026!', campaignIds: [visitCampaign.id],
    portalConfig: {
      template: 'visit-schedule', status: 'published', sections: ['requestApproval', 'visitSchedule', 'campaignReport'],
      fields: {
        requestApproval: ['name', 'username', 'platform', 'followers', 'decision'],
        visitSchedule: ['name', 'username', 'visitDate', 'visitTime', 'visitCity', 'visitBranch', 'visitAddress', 'visitStatus', 'visitNotes', 'coverageNotes'],
        deliveryCampaign: [],
        campaignReport: ['campaignSummary', 'targetCount', 'visitSummary']
      },
      actions: { allowDecisions: true, allowRevert: true, allowVisitConfirmation: true, allowVisitChangeRequest: true, allowShippingFollowUp: false }
    }
  }
})).account;
const clientTwo = (await mustCall('/api/client-accounts', {
  method: 'POST',
  body: {
    username: 'client-two', email: 'client.two@example.test', clientName: 'Client Two', companyName: 'Client Two Ltd',
    password: 'Client-two-pass-2026!', campaignIds: [deliveryCampaign.id],
    portalConfig: {
      template: 'delivery-campaign', status: 'published', sections: ['requestApproval', 'deliveryCampaign', 'campaignReport'],
      fields: {
        requestApproval: ['name', 'username', 'platform', 'followers', 'decision'],
        visitSchedule: [],
        deliveryCampaign: ['recipientName', 'recipientPhone', 'courierContact', 'deliveryCity', 'deliveryDistrict', 'deliveryAddress', 'deliveryMapLink', 'orderDetails', 'shippingStatus', 'shippingCarrier', 'trackingNumber', 'deliveryDate'],
        campaignReport: ['campaignSummary', 'targetCount', 'deliverySummary']
      },
      actions: { allowDecisions: true, allowRevert: true, allowVisitConfirmation: false, allowVisitChangeRequest: false, allowShippingFollowUp: true }
    }
  }
})).account;
const clientOneCookie = await login('client-one', 'Client-one-pass-2026!', '/api/client-portal/login');
const clientTwoCookie = await login('client-two', 'Client-two-pass-2026!', '/api/client-portal/login');
const emailLogin = await call('/api/client-portal/login', {
  method: 'POST', cookie: '', body: { email: 'CLIENT.ONE@example.test', password: 'Client-one-pass-2026!' }
});
assert.equal(emailLogin.response.status, 200);
const clientOneEmailCookie = emailLogin.response.headers.get('set-cookie')?.split(';')[0];
const legacyInputLogin = await call('/api/client-portal/login', {
  method: 'POST', cookie: '', body: { email: 'client-one', password: 'Client-one-pass-2026!' }
});
assert.equal(legacyInputLogin.response.status, 200);

test('portal pages and account-password session authentication are available', async () => {
  const portalPage = await fetch(`${baseUrl}/portal?preview=${clientOne.id}`);
  assert.equal(portalPage.status, 200);
  assert.match(await portalPage.text(), /<!doctype html>/i);
  assert.equal(portalPage.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(portalPage.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
  const clientPreviewPage = await fetch(`${baseUrl}/client-preview?catalog=${'a'.repeat(32)}`);
  assert.equal(clientPreviewPage.status, 200);
  assert.match(clientPreviewPage.headers.get('content-security-policy') || '', /frame-src https:\/\/www\.youtube-nocookie\.com/);
  assert.match(clientPreviewPage.headers.get('content-security-policy') || '', /img-src 'self' data: https:\/\/i\.ytimg\.com/);
  const showcasePage = await fetch(`${baseUrl}/showcase`);
  assert.equal(showcasePage.status, 200);
  assert.match(await showcasePage.text(), /id="login-form"/);
  assert.match(showcasePage.headers.get('content-security-policy') || '', /script-src 'self'/);
  for (const asset of ['/assets/showcase.css', '/assets/showcase.js']) {
    assert.equal((await fetch(`${baseUrl}${asset}`)).status, 200);
  }
  for (const [id, avatarPath] of [
    [influencerIds[0], '/assets/avatars/female-hijab.svg'],
    [influencerIds[1], '/assets/avatars/male.svg'],
    ['c'.repeat(32), '/assets/avatars/female.svg']
  ]) {
    const imageResponse = await fetch(`${baseUrl}/profile-images/${id}`);
    const expectedResponse = await fetch(`${baseUrl}${avatarPath}`);
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get('content-type') || '', /image\/svg\+xml/);
    assert.equal(await imageResponse.text(), await expectedResponse.text());
  }
  assert.equal((await fetch(`${baseUrl}/profile-images/${'d'.repeat(32)}`)).status, 404);
  const accountPage = await fetch(`${baseUrl}/client-accounts`);
  assert.equal(accountPage.status, 200);
  assert.match(await accountPage.text(), /<!doctype html>/i);
  assert.equal(accountPage.headers.get('x-frame-options'), 'DENY');
  assert.match(accountPage.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  const unauthenticated = await call('/api/client-portal/campaigns', { cookie: '' });
  assert.equal(unauthenticated.response.status, 401);
  const wrongPassword = await call('/api/client-portal/login', {
    method: 'POST', cookie: '', body: { username: 'client-one', password: 'wrong-password' }
  });
  assert.equal(wrongPassword.response.status, 401);
  const status = await mustCall('/api/client-portal/session', { cookie: clientOneCookie });
  assert.equal(status.account.companyName, 'Client One Ltd');
  const emailStatus = await mustCall('/api/client-portal/session', { cookie: clientOneEmailCookie });
  assert.equal(emailStatus.account.email, 'client.one@example.test');
  const duplicateEmail = await call('/api/client-accounts', {
    method: 'POST',
    body: {
      username: 'different-client', email: 'CLIENT.ONE@example.test', clientName: 'Duplicate', companyName: 'Duplicate Ltd',
      password: 'Different-client-pass-2026!', campaignIds: []
    }
  });
  assert.equal(duplicateEmail.response.status, 409);
});

test('client workspace scopes campaigns, visits, internal notes, and decision history to the selected customer', async () => {
  const workspace = await mustCall(`/api/client-accounts/${clientOne.id}/workspace`);
  assert.equal(workspace.account.internalNotes, 'Internal test note');
  assert.deepEqual(workspace.campaigns.map((campaign) => campaign.id), [visitCampaign.id]);
  assert.equal(workspace.visits.length, 1);
  assert.equal(workspace.visits[0].branch, 'Test branch');
  assert.equal(workspace.decisionHistory.length, 0);
  const customerData = await mustCall('/api/client-portal/campaigns', { cookie: clientOneCookie });
  assert.doesNotMatch(JSON.stringify(customerData), /Internal test note|client\.one@example\.test|Phone Shared|رقم مشترك/);
  const editorWorkspace = await mustCall(`/api/client-accounts/${clientOne.id}/workspace`, { cookie: editorCookie });
  assert.deepEqual(editorWorkspace.campaigns.map((campaign) => campaign.id), [visitCampaign.id]);
  const otherWorkspace = await mustCall(`/api/client-accounts/${clientTwo.id}/workspace`);
  assert.deepEqual(otherWorkspace.campaigns.map((campaign) => campaign.id), [deliveryCampaign.id]);
  const denied = await call(`/api/client-accounts/${clientOne.id}/workspace`, { cookie: viewerCookie });
  assert.equal(denied.response.status, 403);
  const missing = await call(`/api/client-accounts/${'f'.repeat(32)}/workspace`);
  assert.equal(missing.response.status, 404);
  await mustCall(`/api/campaigns/${visitCampaign.id}/targets/${influencerIds[0]}`, {
    method: 'PATCH',
    body: { visitDate: '2026-10-16', visitTime: '16:00', visitBranch: 'Updated branch' }
  });
  const updated = await mustCall(`/api/client-accounts/${clientOne.id}/workspace`);
  assert.equal(updated.visits[0].visitDate, '2026-10-16');
  assert.equal(updated.visits[0].branch, 'Updated branch');
  assert.ok(updated.activity.some(entry => entry.eventType === 'visit_updated'));
  await mustCall(`/api/campaigns/${visitCampaign.id}/targets/${influencerIds[0]}`, {
    method: 'PATCH', body: { visitDate: '2026-10-14', visitTime: '15:30', visitBranch: 'Test branch' }
  });
});

test('campaign internal workspace files, operations, and scoped client presentations stay separated', async () => {
  const filteredCandidates = await mustCall('/api/influencers?scope=campaign&platform=Instagram&minFollowers=10000');
  assert.ok(filteredCandidates.rows.some((row) => row.id === influencerIds[0]), JSON.stringify(filteredCandidates));
  const cityCandidates = await mustCall('/api/influencers?scope=campaign&city=Riyadh');
  assert.ok(cityCandidates.rows.some((row) => row.id === influencerIds[0]), JSON.stringify(cityCandidates));
  const categoryCandidates = await mustCall('/api/influencers?scope=campaign&classification=Health');
  assert.ok(categoryCandidates.rows.some((row) => row.id === influencerIds[0]), JSON.stringify(categoryCandidates));
  const higherThreshold = await mustCall('/api/influencers?scope=campaign&platform=Instagram&minFollowers=16000');
  assert.equal(higherThreshold.rows.some((row) => row.id === influencerIds[0]), false);
  const workspacePath = `/api/campaigns/${visitCampaign.id}/workspace`;
  const forbiddenViewer = await call(workspacePath, { cookie: viewerCookie });
  assert.equal(forbiddenViewer.response.status, 403);
  assert.equal((await call(workspacePath, { cookie: '' })).response.status, 401);
  const content = {
    briefAr: 'تفاصيل داخلية للحملة', briefEn: 'Internal campaign brief',
    invitationAr: 'رسالة دعوة', invitationEn: 'Invitation', creatorBriefAr: 'تعليمات منشئ المحتوى',
    creatorBriefEn: '', afterConfirmationAr: 'بعد التأكيد', afterConfirmationEn: '', instructionsAr: '', instructionsEn: ''
  };
  const savedWorkspace = await mustCall(workspacePath, { method: 'PATCH', body: { content } });
  assert.equal(savedWorkspace.content.briefEn, 'Internal campaign brief');
  await mustCall(`/api/campaigns/${visitCampaign.id}/targets/${influencerIds[0]}`, {
    method: 'PATCH', body: { afterConfirmation: 'تعليمات قديمة خاصة بالمؤثر' }
  });
  const migratedWorkspace = await mustCall(workspacePath);
  assert.match(migratedWorkspace.content.invitationCards[0].body, /رسالة دعوة/);
  assert.match(migratedWorkspace.content.invitationCards[0].body, /Invitation/);
  assert.ok(migratedWorkspace.content.afterConfirmationCards.some(card => card.body === 'تعليمات قديمة خاصة بالمؤثر'));
  const invitationCards = [
    { id: 'invitation-riyadh', title: 'دعوة الرياض', body: 'دعوة الرياض — mixed English text' },
    { id: 'invitation-jeddah', title: 'دعوة جدة', body: 'دعوة جدة' },
    { id: 'invitation-delivery', title: '', body: 'دعوة التوصيل' }
  ];
  const afterConfirmationCards = [
    { id: 'instructions-one', title: 'بعد التأكيد 1', body: 'أرسل رابط المحتوى' },
    { id: 'instructions-two', title: '', body: 'Keep the receipt' }
  ];
  await mustCall(workspacePath, { method: 'PATCH', body: { content: { invitationCards, afterConfirmationCards } } });
  const savedCards = await mustCall(workspacePath);
  assert.deepEqual(savedCards.content.invitationCards, invitationCards);
  assert.deepEqual(savedCards.content.afterConfirmationCards, afterConfirmationCards);
  await mustCall(workspacePath, { method: 'PATCH', body: {
    content: {
      invitationCards: invitationCards.filter(card => card.id !== 'invitation-jeddah').map(card =>
        card.id === 'invitation-riyadh' ? { ...card, body: 'دعوة معدلة' } : card),
      afterConfirmationCards: afterConfirmationCards.slice(0, 1)
    }
  } });
  const editedCards = await mustCall(workspacePath);
  assert.equal(editedCards.content.invitationCards.length, 2);
  assert.equal(editedCards.content.invitationCards[0].body, 'دعوة معدلة');
  assert.equal(editedCards.content.afterConfirmationCards.length, 1);
  assert.equal(editedCards.content.invitationAr, 'رسالة دعوة');
  assert.equal(editedCards.content.afterConfirmationAr, 'بعد التأكيد');
  const badCards = await call(workspacePath, { method: 'PATCH', body: { content: {
    invitationCards: [{ id: 'duplicate', title: '', body: 'one' }, { id: 'duplicate', title: '', body: 'two' }]
  } } });
  assert.equal(badCards.response.status, 400);
  const unauthenticatedNote = await call(`/api/campaigns/${visitCampaign.id}/influencer-notes/${influencerIds[0]}`, {
    cookie: '', method: 'PUT', body: { noteText: 'Private selected-influencer note' }
  });
  assert.equal(unauthenticatedNote.response.status, 401);
  const viewerNote = await call(`/api/campaigns/${visitCampaign.id}/influencer-notes/${influencerIds[0]}`, {
    cookie: viewerCookie, method: 'PUT', body: { noteText: 'Private selected-influencer note' }
  });
  assert.equal(viewerNote.response.status, 403);
  await mustCall(`/api/campaigns/${visitCampaign.id}/influencer-notes/${influencerIds[0]}`, {
    cookie: editorCookie, method: 'PUT', body: { noteText: 'INTERNAL SELECTED INFLUENCER NOTE' }
  });
  const staffCampaign = (await mustCall('/api/campaigns')).campaigns.find(campaign => campaign.id === visitCampaign.id);
  assert.equal(staffCampaign.targets[0].campaignInfluencerNote, 'INTERNAL SELECTED INFLUENCER NOTE');
  const viewerCampaignsWithNote = await mustCall('/api/campaigns', { cookie: viewerCookie });
  assert.equal(viewerCampaignsWithNote.campaigns.find(campaign => campaign.id === visitCampaign.id).targets[0].campaignInfluencerNote, '');
  await mustCall(`/api/campaigns/${visitCampaign.id}/influencer-notes/${influencerIds[0]}`, {
    cookie: editorCookie, method: 'PUT', body: { noteText: 'UPDATED INTERNAL SELECTED NOTE' }
  });
  assert.equal((await mustCall('/api/campaigns')).campaigns.find(campaign => campaign.id === visitCampaign.id).targets[0].campaignInfluencerNote, 'UPDATED INTERNAL SELECTED NOTE');
  const updatedOps = await mustCall(`/api/campaigns/${visitCampaign.id}/targets/${influencerIds[0]}`, {
    method: 'PATCH', body: { contactStatus: 'responded', participationStatus: 'confirmed', campaignPrice: '1500 SAR', operationsNotes: 'Private operations note' }
  });
  assert.equal(updatedOps.target.contactStatus, 'responded');
  assert.equal(updatedOps.target.participationStatus, 'confirmed');
  assert.equal(updatedOps.target.campaignPrice, '1500 SAR');
  const viewerCampaigns = await mustCall('/api/campaigns', { cookie: viewerCookie });
  assert.equal(viewerCampaigns.campaigns.find((campaign) => campaign.id === visitCampaign.id).targets[0].operationsNotes, '');
  assert.equal(viewerCampaigns.campaigns.find((campaign) => campaign.id === visitCampaign.id).targets[0].campaignPrice, '');

  const imageBase64 = Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64');
  const upload = await mustCall(`${workspacePath}/evidence`, { method: 'POST', body: {
    fileName: 'before.png', mimeType: 'image/png', dataBase64: imageBase64,
    platform: 'Instagram', phase: 'before', captureDate: '2026-10-12', note: 'Private image note'
  } });
  assert.equal(upload.file.phase, 'before');
  const internalFile = await fetch(`${baseUrl}${upload.file.url}`, { headers: { cookie: adminCookie } });
  assert.equal(internalFile.status, 200);
  assert.equal(internalFile.headers.get('content-type'), 'image/png');
  const viewerFile = await fetch(`${baseUrl}${upload.file.url}`, { headers: { cookie: viewerCookie } });
  assert.equal(viewerFile.status, 403);

  const anonymousLibrary = await call('/api/company-work-videos', { cookie: '' });
  assert.equal(anonymousLibrary.response.status, 401);
  assert.deepEqual((await mustCall('/api/company-work-videos', { cookie: viewerCookie })).videos, []);
  const invalidLibraryVideo = await call('/api/company-work-videos', { method: 'POST', body: {
    url: 'https://youtube.com.evil.example/watch?v=QAtest00004', title: 'Invalid'
  } });
  assert.equal(invalidLibraryVideo.response.status, 400);
  const libraryVideoOne = (await mustCall('/api/company-work-videos', { method: 'POST', cookie: editorCookie, body: {
    url: 'https://youtu.be/QAtest00004', title: 'Fikratak campaign sample one'
  } })).video;
  const libraryVideoTwo = (await mustCall('/api/company-work-videos', { method: 'POST', body: {
    url: 'https://www.youtube.com/watch?v=QAtest00005', title: 'Fikratak campaign sample two'
  } })).video;
  const queryStringVideo = (await mustCall('/api/company-work-videos', { method: 'POST', body: {
    url: 'https://www.youtube.com/watch?v=QAtest00006&feature=share', title: 'Fikratak query-string sample'
  } })).video;
  const shortQueryVideo = (await mustCall('/api/company-work-videos', { method: 'POST', body: {
    url: 'https://www.youtube.com/shorts/QAtest00007?feature=share', title: 'Fikratak Shorts sample'
  } })).video;
  assert.equal(libraryVideoOne.videoId, 'QAtest00004');
  assert.equal(libraryVideoTwo.videoId, 'QAtest00005');
  assert.equal(queryStringVideo.videoId, 'QAtest00006');
  assert.equal(shortQueryVideo.videoId, 'QAtest00007');
  const duplicateLibraryVideo = await call('/api/company-work-videos', { method: 'POST', body: {
    url: 'https://youtube.com/shorts/QAtest00004', title: 'Duplicate'
  } });
  assert.equal(duplicateLibraryVideo.response.status, 409);
  const viewerLibraryEdit = await call(`/api/company-work-videos/${libraryVideoOne.id}`, {
    cookie: viewerCookie, method: 'PATCH', body: { title: 'Not allowed' }
  });
  assert.equal(viewerLibraryEdit.response.status, 403);
  const editorLibraryEdit = await mustCall(`/api/company-work-videos/${libraryVideoOne.id}`, {
    cookie: editorCookie, method: 'PATCH', body: { title: 'Fikratak campaign sample one edited' }
  });
  assert.equal(editorLibraryEdit.video.title, 'Fikratak campaign sample one edited');
  const editorLibraryDelete = await call(`/api/company-work-videos/${libraryVideoTwo.id}`, {
    cookie: editorCookie, method: 'DELETE'
  });
  assert.equal(editorLibraryDelete.response.status, 403);

  const created = await mustCall(`/api/campaigns/${visitCampaign.id}/presentations`, { method: 'POST', body: {
    brandId: 'fkretk',
    clientAccountId: clientOne.id,
    influencerIds: [influencerIds[0]],
    fields: ['name', 'platform', 'username', 'visitDate', 'visitTime', 'visitBranch', 'followers', 'price'],
    displayOptions: {
      showInfluencerDetails: true, showSocialAccounts: true, showFollowers: true,
      showAdditionalDetails: true, showCompanyWork: true
    },
    companyWorkVideoIds: [libraryVideoOne.id, libraryVideoTwo.id],
    videoReferences: [
      { url: 'https://youtu.be/QAtest00001', title: 'Sample video one' },
      { url: 'https://www.youtube.com/watch?v=QAtest00002', title: 'Sample video two' },
      { url: 'https://youtube.com/shorts/QAtest00003', title: 'Sample short' }
    ]
  } });
  companyWorkPresentationToken = created.token;
  companyWorkPresentationVideoIds = [libraryVideoTwo.id];
  const wrongCustomer = await call(`/api/campaigns/${visitCampaign.id}/presentations`, { method: 'POST', body: {
    clientAccountId: clientTwo.id, influencerIds: [influencerIds[0]], fields: ['name', 'visitDate']
  } });
  assert.equal(wrongCustomer.response.status, 400);
  assert.match(created.url, /^\/campaign-presentation\/[A-Za-z0-9_-]{40,60}$/);
  const page = await fetch(`${baseUrl}${created.url}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.match(page.headers.get('content-security-policy') || '', /frame-src https:\/\/www\.youtube-nocookie\.com/);
  assert.match(page.headers.get('content-security-policy') || '', /script-src .*https:\/\/www\.youtube\.com/);
  const presentationCss = await fetch(`${baseUrl}/assets/presentation.css?v=2.0.0`);
  assert.equal(presentationCss.status, 200);
  const presentationHtml = `${await page.text()}\n${await presentationCss.text()}`;
  assert.match(presentationHtml, /بعض أعمال فكرتك الرقمية مع صُنّاع المحتوى والمؤثرين/);
  assert.match(presentationHtml, /videoFallback/);
  assert.match(presentationHtml, /\[\.\.\.\(result\.companyWorkVideos \|\| \[\]\), \.\.\.\(result\.videoReferences \|\| \[\]\)\]/);
  assert.match(presentationHtml, /companyWorkVideos/);
  assert.match(presentationHtml, /videoReferences/);
  assert.match(presentationHtml, /https:\/\/www\.youtube\.com\/iframe_api/);
  assert.match(presentationHtml, /new youtube\.Player/);
  assert.match(presentationHtml, /playerVars: \{ autoplay: 1, controls: 1, disablekb: 0/);
  assert.match(presentationHtml, /onError: \(event\) =>/);
  assert.match(presentationHtml, /className = 'video-grid'/);
  assert.match(presentationHtml, /grid-auto-columns: clamp\(340px,44vw,600px\)/);
  assert.match(presentationHtml, /host: 'https:\/\/www\.youtube-nocookie\.com'/);
  assert.match(presentationHtml, /scrollbar-width: none/);
  assert.match(presentationHtml, /track\.tabIndex = 0/);
  assert.match(presentationHtml, /grid-auto-columns: 100%/);
  assert.match(presentationHtml, /scrollBy\(\{/);
  assert.match(presentationHtml, /pointermove/);
  assert.match(presentationHtml, /image\.loading = 'lazy'/);
  assert.match(presentationHtml, /object-fit: contain/);
  assert.match(presentationHtml, /openVideoPreview\(video, card, words\)/);
  assert.doesNotMatch(presentationHtml, /work-orbit-track|work-orbit-spin|work-player-link/);
  assert.match(presentationHtml, /@media \(max-width:480px\)/);
  assert.doesNotMatch(presentationHtml, /youtube-nocookie\.com\/embed/);
  assert.match(presentationHtml, /language-toggle/);
  const publicData = await (await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`)).json();
  assert.ok(publicData.presentation, `Missing presentation metadata in ${JSON.stringify(Object.keys(publicData))}`);
  assert.doesNotMatch(JSON.stringify(publicData), /Phone Shared|رقم مشترك/);
  assert.equal(publicData.presentation.mode, 'selecting');
  assert.equal(publicData.targets[0].name, 'Visit Creator');
  assert.equal(publicData.targets[0].username, 'visit_creator');
  assert.equal(publicData.targets[0].visitBranch, 'Test branch');
  assert.equal(publicData.targets[0].price, '1500 SAR');
  assert.equal(publicData.videoReferences.length, 3);
  assert.equal(publicData.videoReferences[0].videoId, 'QAtest00001');
  assert.equal(publicData.displayOptions.showCompanyWork, true);
  assert.deepEqual(publicData.companyWorkVideos.map(video => video.id), [libraryVideoOne.id, libraryVideoTwo.id]);
  assert.equal(publicData.companyWorkVideos[0].title, 'Fikratak campaign sample one edited');
  assert.equal('campaignPrice' in publicData.targets[0], false);
  assert.equal('operationsNotes' in publicData.targets[0], false);
  assert.doesNotMatch(JSON.stringify(publicData), /555123456|staff-only note|Private image note|INTERNAL SELECTED INFLUENCER NOTE|UPDATED INTERNAL SELECTED NOTE/);
  const listedPresentations = await mustCall(`/api/campaigns/${visitCampaign.id}/presentations`);
  const listedVideos = listedPresentations.presentations.find(item => item.id === created.id).videoReferences;
  assert.equal(listedVideos.length, 3);
  const reorderedVideos = await mustCall(`/api/campaigns/${visitCampaign.id}/presentations/${created.id}`, {
    method: 'PATCH',
    body: { videoReferences: [
      { ...listedVideos[2], title: 'Edited sample short' },
      listedVideos[0]
    ] }
  });
  assert.equal(reorderedVideos.active, true);
  const reorderedPublic = await (await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`)).json();
  assert.deepEqual(reorderedPublic.videoReferences.map(video => video.videoId), ['QAtest00003', 'QAtest00001']);
  assert.equal(reorderedPublic.videoReferences[0].title, 'Edited sample short');
  await mustCall(`/api/campaigns/${visitCampaign.id}/presentations/${created.id}`, {
    method: 'PATCH',
    body: {
      displayOptions: {
        showInfluencerDetails: false, showSocialAccounts: false, showFollowers: false,
        showAdditionalDetails: true, showCompanyWork: true
      },
      companyWorkVideoIds: [libraryVideoTwo.id]
    }
  });
  const refreshedPresentation = await (await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`)).json();
  assert.equal(refreshedPresentation.targets[0].name, '');
  assert.equal(refreshedPresentation.targets[0].username, '');
  assert.equal(refreshedPresentation.targets[0].platform, '');
  assert.equal(refreshedPresentation.targets[0].followers, '');
  assert.equal(refreshedPresentation.targets[0].price, '1500 SAR');
  assert.deepEqual(refreshedPresentation.companyWorkVideos.map(video => video.id), [libraryVideoTwo.id]);
  assert.equal(refreshedPresentation.displayOptions.showSocialAccounts, false);
  await mustCall(`/api/campaigns/${visitCampaign.id}/presentations/${created.id}`, {
    method: 'PATCH',
    body: {
      displayOptions: {
        showInfluencerDetails: true, showSocialAccounts: true, showFollowers: true,
        showAdditionalDetails: false, showCompanyWork: true
      }
    }
  });
  const noAdditionalDetails = await (await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`)).json();
  assert.equal(noAdditionalDetails.targets[0].name, 'Visit Creator');
  assert.equal(noAdditionalDetails.targets[0].username, 'visit_creator');
  assert.equal(noAdditionalDetails.targets[0].followers, '15000');
  assert.equal(noAdditionalDetails.targets[0].price, '');
  assert.equal(noAdditionalDetails.targets[0].visitBranch, '');
  await mustCall(`/api/campaigns/${visitCampaign.id}/presentations/${created.id}`, {
    method: 'PATCH',
    body: { displayOptions: { showCompanyWork: false } }
  });
  const hiddenWork = await (await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`)).json();
  assert.deepEqual(hiddenWork.companyWorkVideos, []);
  await mustCall(`/api/campaigns/${visitCampaign.id}/presentations/${created.id}`, {
    method: 'PATCH',
    body: { displayOptions: { showCompanyWork: true } }
  });
  const restoredWork = await (await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`)).json();
  assert.deepEqual(restoredWork.companyWorkVideos.map(video => video.id), [libraryVideoTwo.id]);
  await mustCall(`/api/company-work-videos/${libraryVideoTwo.id}`, { method: 'PATCH', body: { active: false } });
  const disabledWork = await (await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`)).json();
  assert.deepEqual(disabledWork.companyWorkVideos, []);
  await mustCall(`/api/company-work-videos/${libraryVideoTwo.id}`, { method: 'PATCH', body: { active: true } });
  const enabledWork = await (await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`)).json();
  assert.deepEqual(enabledWork.companyWorkVideos.map(video => video.id), [libraryVideoTwo.id]);
  await mustCall(`/api/company-work-videos/${libraryVideoOne.id}`, { method: 'DELETE' });
  const invalidVideo = await call(`/api/campaigns/${visitCampaign.id}/presentations/${created.id}`, {
    method: 'PATCH', body: { videoReferences: [{ url: 'https://youtube.com.evil.example/watch?v=QAtest00004', title: 'Invalid' }] }
  });
  assert.equal(invalidVideo.response.status, 400);
  const viewerVideoEdit = await call(`/api/campaigns/${visitCampaign.id}/presentations/${created.id}`, {
    method: 'PATCH', cookie: viewerCookie, body: { videoReferences: [] }
  });
  assert.equal(viewerVideoEdit.response.status, 403);
  const unauthenticatedVideoEdit = await call(`/api/campaigns/${visitCampaign.id}/presentations/${created.id}`, {
    method: 'PATCH', cookie: '', body: { videoReferences: [] }
  });
  assert.equal(unauthenticatedVideoEdit.response.status, 401);
  const noVideoPresentation = await mustCall(`/api/campaigns/${visitCampaign.id}/presentations`, {
    method: 'POST', body: { brandId: 'fkretk', clientAccountId: clientOne.id, influencerIds: [influencerIds[0]], fields: ['name', 'visitDate'] }
  });
  const noVideoPublic = await (await fetch(`${baseUrl}/api/campaign-presentations/${noVideoPresentation.token}`)).json();
  assert.deepEqual(noVideoPublic.videoReferences, []);
  assert.deepEqual(noVideoPublic.companyWorkVideos, []);
  const ryfaqPresentation = await mustCall(`/api/campaigns/${visitCampaign.id}/presentations`, {
    method: 'POST',
    body: {
      brandId: 'ryfaq', clientAccountId: clientOne.id, influencerIds: [influencerIds[0]],
      fields: ['name', 'visitDate'],
      displayOptions: {
        showInfluencerDetails: true, showSocialAccounts: false, showFollowers: false,
        showAdditionalDetails: true, showCompanyWork: false
      }
    }
  });
  const ryfaqPublic = await (await fetch(`${baseUrl}/api/campaign-presentations/${ryfaqPresentation.token}`)).json();
  assert.equal(ryfaqPublic.brand.id, 'ryfaq');
  assert.equal(ryfaqPublic.brand.primaryColor, '#427E60');
  assert.deepEqual(ryfaqPublic.videoReferences, []);
  assert.deepEqual(ryfaqPublic.companyWorkVideos, []);
  assert.doesNotMatch(presentationHtml, /1500 SAR|555123456|staff-only note/);
  const savedInternalData = new DatabaseSync(databasePath, { readOnly: true });
  const savedWorkspaceContent = JSON.parse(savedInternalData.prepare('SELECT content_json FROM campaign_workspaces WHERE campaign_id = ?').get(visitCampaign.id).content_json);
  assert.equal(savedWorkspaceContent.invitationAr, 'رسالة دعوة');
  assert.equal(savedWorkspaceContent.invitationCards[0].body, 'دعوة معدلة');
  assert.equal(savedInternalData.prepare('SELECT note_text FROM campaign_influencer_notes WHERE campaign_id = ? AND influencer_id = ?').get(visitCampaign.id, influencerIds[0]).note_text, 'UPDATED INTERNAL SELECTED NOTE');
  assert.equal(savedInternalData.prepare('SELECT after_confirmation FROM campaign_targets WHERE campaign_id = ? AND influencer_id = ?').get(visitCampaign.id, influencerIds[0]).after_confirmation, 'تعليمات قديمة خاصة بالمؤثر');
  savedInternalData.close();
  await mustCall(`/api/campaigns/${visitCampaign.id}/influencer-notes/${influencerIds[0]}`, { method: 'DELETE' });
  assert.equal((await mustCall('/api/campaigns')).campaigns.find(campaign => campaign.id === visitCampaign.id).targets[0].campaignInfluencerNote, '');
  assert.equal((await call(workspacePath, { cookie: '' })).response.status, 401);
  const changedToken = `${created.token.slice(0, -1)}${created.token.endsWith('A') ? 'B' : 'A'}`;
  assert.equal((await fetch(`${baseUrl}/api/campaign-presentations/${changedToken}`)).status, 404);

  const disabled = await mustCall(`/api/campaigns/${visitCampaign.id}/presentations/${created.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal(disabled.active, false);
  assert.equal((await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`)).status, 404);
  const reissued = await mustCall(`/api/campaigns/${visitCampaign.id}/presentations/${created.id}/reissue`, { method: 'POST', body: {} });
  assert.equal((await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/campaign-presentations/${reissued.token}`)).status, 200);
  companyWorkPresentationToken = reissued.token;
  const forbiddenPresentationDelete = await call(`/api/campaigns/${visitCampaign.id}/presentations/${noVideoPresentation.id}`, {
    method: 'DELETE', cookie: editorCookie
  });
  assert.equal(forbiddenPresentationDelete.response.status, 403);
  await mustCall(`/api/campaigns/${visitCampaign.id}/presentations/${noVideoPresentation.id}`, { method: 'DELETE' });
  assert.equal((await fetch(`${baseUrl}/api/campaign-presentations/${noVideoPresentation.token}`)).status, 404);
  const presentationsAfterDelete = await mustCall(`/api/campaigns/${visitCampaign.id}/presentations`);
  assert.equal(presentationsAfterDelete.presentations.some(item => item.id === noVideoPresentation.id), false);
  const libraryAfterPresentationDelete = await mustCall('/api/company-work-videos');
  assert.equal(libraryAfterPresentationDelete.videos.some(video => video.id === libraryVideoTwo.id), true);
  const deliveryPresentation = await call(`/api/campaigns/${deliveryCampaign.id}/presentations`, { method: 'GET' });
  assert.equal(deliveryPresentation.response.status, 409);
});

test('visit-only presentations hide undated visits and amounts and scope client logos to the active link', async () => {
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const campaign = (await mustCall('/api/campaigns', { method: 'POST', body: {
    campaignName: 'Synthetic visits presentation', companyName: 'Synthetic Visits Company',
    campaignType: 'visit', serviceType: 'influencer', startDate: today, endDate: today,
    targets: [
      { id: influencerIds[0], visitDate: today, visitTime: '00:00', visitCity: 'Riyadh', visitBranch: 'Early visit' },
      { id: influencerIds[1], visitDate: today, visitTime: '', visitCity: 'Jeddah', visitBranch: 'Time pending' },
      { id: 'c'.repeat(32), visitDate: today, visitTime: '09:00', visitCity: 'Dammam', visitBranch: 'Undated visit' }
    ]
  } })).campaign;
  const visitClient = (await mustCall('/api/client-accounts', { method: 'POST', body: {
    username: 'synthetic-visits-client', email: 'synthetic.visits@example.test',
    clientName: 'Synthetic Logo Client', companyName: 'Synthetic Visits Company',
    password: 'Synthetic-visits-pass-2026!', campaignIds: [campaign.id]
  } })).account;
  const readOnlyDb = new DatabaseSync(databasePath);
  for (const id of influencerIds.slice(0, 2)) {
    readOnlyDb.prepare('UPDATE campaign_targets SET campaign_price = ? WHERE campaign_id = ? AND influencer_id = ?')
      .run('SYNTHETIC_AMOUNT_NEVER_CLIENT', campaign.id, id);
  }
  readOnlyDb.prepare(`UPDATE campaign_targets SET visit_date = NULL, visit_time = '09:00'
    WHERE campaign_id = ? AND influencer_id = ?`).run(campaign.id, 'c'.repeat(32));
  readOnlyDb.close();

  const path = `/api/campaigns/${campaign.id}/presentations`;
  const logo = { mimeType: 'image/png', dataBase64: createPng(23).toString('base64') };
  const presentationBody = {
    brandId: 'fkretk', clientAccountId: visitClient.id,
    influencerIds: [influencerIds[0], influencerIds[1], 'c'.repeat(32)],
    fields: ['name', 'visitDate', 'visitTime', 'visitCity', 'visitBranch', 'price'],
    presentationMode: 'visits', headerTitle: 'Synthetic visit schedule',
    headerTagline: 'Synthetic client tagline', packageVisitsCount: 4,
    displayOptions: {
      showInfluencerDetails: true, showSocialAccounts: true, showFollowers: true,
      showAdditionalDetails: false, showCompanyWork: true
    },
    companyWorkVideoIds: companyWorkPresentationVideoIds,
    videoReferences: [{ url: 'https://youtu.be/QAtest00011', title: 'Synthetic schedule library sample' }]
  };
  const viewerUpload = await call(path, { cookie: viewerCookie, method: 'POST', body: { ...presentationBody, clientLogo: logo } });
  assert.equal(viewerUpload.response.status, 403);
  const unauthenticatedUpload = await call(path, { cookie: '', method: 'POST', body: { ...presentationBody, clientLogo: logo } });
  assert.equal(unauthenticatedUpload.response.status, 401);

  const unsupportedType = await call(path, { method: 'POST', body: {
    ...presentationBody, clientLogo: { fileName: 'vector.svg', mimeType: 'image/svg+xml', dataBase64: Buffer.from('<svg></svg>').toString('base64') }
  } });
  assert.equal(unsupportedType.response.status, 400);
  const oversizedLogo = await call(path, { method: 'POST', body: {
    ...presentationBody, clientLogo: { fileName: 'oversized.png', mimeType: 'image/png', dataBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }
  } });
  assert.equal(oversizedLogo.response.status, 413);
  const fakePng = await call(path, { method: 'POST', body: {
    ...presentationBody, clientLogo: { fileName: 'spoofed-image.png', mimeType: 'image/png', dataBase64: Buffer.from('<svg>not a PNG</svg>').toString('base64') }
  } });
  assert.equal(fakePng.response.status, 400);

  const created = await mustCall(path, { cookie: editorCookie, method: 'POST', body: { ...presentationBody, clientLogo: logo } });
  const publicResponse = await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`);
  assert.equal(publicResponse.status, 200);
  const publicData = await publicResponse.json();
  assert.equal(publicData.presentation.mode, 'visits');
  assert.doesNotMatch(JSON.stringify(publicData), /Phone Shared|رقم مشترك/);
  assert.equal(publicData.presentation.title, 'Synthetic visit schedule');
  assert.equal(publicData.presentation.tagline, 'Synthetic client tagline');
  assert.equal(publicData.presentation.packageVisitsCount, 4);
  assert.equal(publicData.presentation.packageVisitsCompleted, 1);
  assert.equal(publicData.targets.length, 2);
  assert.equal(publicData.targets.some((target) => target.influencerId === 'c'.repeat(32)), false);
  assert.ok(publicData.targets.some((target) => target.visitTime === ''));
  assert.ok(publicData.targets.every((target) => !('price' in target)));
  assert.ok(!JSON.stringify(publicData).includes('SYNTHETIC_AMOUNT_NEVER_CLIENT'));
  assertNoClientInfluencerPrivateData(publicData);
  assert.match(publicData.presentation.clientLogoUrl, /^\/api\/campaign-presentations\/[A-Za-z0-9_-]+\/client-logo$/);

  const presentationPage = await fetch(`${baseUrl}${created.url}`);
  assert.equal(presentationPage.status, 200);
  assert.match(presentationPage.headers.get('x-robots-tag') || '', /noindex/);
  const pageHtml = await presentationPage.text();
  assert.match(pageHtml, /name="robots" content="noindex, nofollow, noarchive"/);
  assert.match(pageHtml, /visit-date-navigation/);
  assert.match(pageHtml, /timeLater/);

  const logoResponse = await fetch(`${baseUrl}${publicData.presentation.clientLogoUrl}`);
  assert.equal(logoResponse.status, 200);
  assert.equal(logoResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await logoResponse.arrayBuffer()), Buffer.from(logo.dataBase64, 'base64'));

  const listed = await mustCall(path);
  const savedLink = listed.presentations.find((item) => item.id === created.id);
  assert.equal(savedLink.presentationMode, 'visits');
  assert.equal(savedLink.hasClientLogo, true);
  const otherLink = await mustCall(path, { method: 'POST', body: {
    ...presentationBody, brandId: 'ryfaq', presentationMode: 'visits',
    packageVisitsCount: null, headerTitle: 'Synthetic Ryfaq schedule',
    influencerIds: [influencerIds[0]], videoReferences: [], companyWorkVideoIds: [],
    displayOptions: {
      showInfluencerDetails: true, showSocialAccounts: false, showFollowers: false,
      showAdditionalDetails: true, showCompanyWork: false
    }
  } });
  assert.equal((await fetch(`${baseUrl}/api/campaign-presentations/${otherLink.token}/client-logo`)).status, 404);
  const changedLogoToken = `${created.token.slice(0, -1)}${created.token.endsWith('A') ? 'B' : 'A'}`;
  assert.equal((await fetch(`${baseUrl}/api/campaign-presentations/${changedLogoToken}/client-logo`)).status, 404);

  const browser = await chromium.launch({ headless: true });
  let uiCreatedPresentationId = '';
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}${created.url}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.visit-schedule').waitFor();
    assert.equal(await page.locator('#client-brand-logo').isVisible(), true);
    assert.equal(await page.locator('#client-brand-logo').evaluate((image) => image.naturalWidth > 0), true);
    assert.equal(await page.locator('h1').textContent(), 'Synthetic visit schedule');
    assert.match(await page.locator('.intro-meta').textContent(), /تمّت ١ من ٤ زيارات|تمّت 1 من 4 زيارات/);
    assert.ok((await page.locator('.date-group h3').allTextContents()).includes('00:00'));
    assert.ok((await page.locator('.date-group h3').allTextContents()).includes('الوقت يُحدد لاحقًا'));
    assert.equal(await page.locator('.visit-card').count(), 2);
    assert.equal(await page.locator('button').filter({ hasText: /قبول|رفض|تأكيد الاختيارات|Accept|Reject/ }).count(), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /SYNTHETIC_AMOUNT_NEVER_CLIENT|التكلفة|Cost/);
    assert.equal(await page.locator('.visit-schedule').evaluate((schedule) =>
      Boolean(schedule.compareDocumentPosition(document.querySelector('.work-showcase')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    const mobileSize = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    assert.ok(mobileSize.document <= mobileSize.viewport + 1, JSON.stringify(mobileSize));
    await page.setViewportSize({ width: 1440, height: 1000 });
    const desktopSize = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    assert.ok(desktopSize.document <= desktopSize.viewport + 1, JSON.stringify(desktopSize));

    const ryfaqPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await ryfaqPage.addInitScript(() => localStorage.setItem('ryfaq-campaign-presentation-theme', 'dark'));
    await ryfaqPage.goto(`${baseUrl}/campaign-presentation/${otherLink.token}`, { waitUntil: 'domcontentloaded' });
    await ryfaqPage.locator('.visit-schedule').waitFor();
    assert.equal(await ryfaqPage.locator('#theme-toggle').isVisible(), true);
    assert.equal(await ryfaqPage.locator('body').getAttribute('data-theme'), 'dark');
    assert.equal(await ryfaqPage.locator('#client-brand-name').isVisible(), true);
    assert.equal(await ryfaqPage.locator('.work-showcase').count(), 0);
    await ryfaqPage.setViewportSize({ width: 1440, height: 1000 });
    await ryfaqPage.close();
    await page.close();

    const adminPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await adminPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await adminPage.locator('#login-username').fill('portal-admin');
    await adminPage.locator('#login-password').fill('Portal-admin-pass-2026!');
    await adminPage.locator('#login-form button[type="submit"]').click();
    await adminPage.locator('#campaigns-tab').waitFor({ state: 'visible' });
    await adminPage.locator('#campaigns-tab').click();
    const campaignCard = adminPage.locator('#campaign-list .campaign-card').filter({ hasText: campaign.campaignName });
    const workspace = campaignCard.locator('details.campaign-workspace-panel');
    await workspace.locator('summary').click();
    const extras = workspace.locator('details.campaign-workspace-extras');
    await extras.locator('summary').waitFor();
    await extras.locator('summary').click();
    const visitsEditorTab = workspace.locator('[data-presentation-tab="visits"]');
    await visitsEditorTab.waitFor();
    await visitsEditorTab.click();
    assert.match(await workspace.locator('[data-presentation-missing-dates]').textContent(), /بلا تاريخ/);
    await workspace.locator('[data-presentation-tab="settings"]').click();
    await workspace.locator('[data-presentation-account]').selectOption(visitClient.id);
    await workspace.locator('select[data-presentation-mode]').selectOption('visits');
    assert.equal(await workspace.locator('[data-presentation-package-label]').isVisible(), true);
    await workspace.locator('[data-presentation-header-title]').fill('UI-created visit schedule');
    await workspace.locator('[data-presentation-header-tagline]').fill('UI-created client tagline');
    await workspace.locator('[data-presentation-package-count]').fill('3');
    await workspace.locator('[data-presentation-client-logo]').setInputFiles({
      name: 'synthetic-logo.png', mimeType: 'image/png', buffer: createPng(37)
    });
    await workspace.locator('[data-action="create-presentation"]').click();
    await workspace.locator('[data-presentation-link] a').first().waitFor();
    const uiCreatedLink = (await mustCall(path)).presentations.find((item) => item.headerTitle === 'UI-created visit schedule');
    assert.ok(uiCreatedLink);
    assert.equal(uiCreatedLink.presentationMode, 'visits');
    assert.equal(uiCreatedLink.hasClientLogo, true);
    uiCreatedPresentationId = uiCreatedLink.id;
    await adminPage.close();
  } finally {
    await browser.close();
  }

  const previousDate = new Date(`${today}T12:00:00Z`);
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  const yesterdayDate = previousDate.toISOString().slice(0, 10);
  const dateUpdate = new DatabaseSync(databasePath);
  dateUpdate.prepare('UPDATE campaign_targets SET visit_date = ? WHERE campaign_id = ? AND influencer_id = ?')
    .run(yesterdayDate, campaign.id, influencerIds[1]);
  dateUpdate.close();
  const completedAfterEndOfDay = await (await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`)).json();
  assert.equal(completedAfterEndOfDay.presentation.packageVisitsCompleted, 2);

  const editorDelete = await call(`/api/campaigns/${campaign.id}/presentations/${created.id}`, {
    cookie: editorCookie, method: 'DELETE'
  });
  assert.equal(editorDelete.response.status, 403);
  await mustCall(`/api/campaigns/${campaign.id}/presentations/${created.id}`, { method: 'DELETE' });
  assert.equal((await fetch(`${baseUrl}/api/campaign-presentations/${created.token}/client-logo`)).status, 404);
  const logoDb = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(logoDb.prepare('SELECT COUNT(*) AS count FROM campaign_presentation_client_logos WHERE presentation_id = ?').get(created.id).count, 0);
  logoDb.close();
  if (uiCreatedPresentationId) {
    await mustCall(`/api/campaigns/${campaign.id}/presentations/${uiCreatedPresentationId}`, { method: 'DELETE' });
  }
  await mustCall(`/api/campaigns/${campaign.id}/presentations/${otherLink.id}`, { method: 'DELETE' });
  const cleanupDb = new DatabaseSync(databasePath);
  cleanupDb.prepare('DELETE FROM client_account_campaigns WHERE account_id = ?').run(visitClient.id);
  cleanupDb.prepare('DELETE FROM campaigns WHERE id = ?').run(campaign.id);
  cleanupDb.prepare('DELETE FROM client_accounts WHERE id = ?').run(visitClient.id);
  cleanupDb.close();
});

test('two client accounts only receive their assigned campaigns and sanitized visit/delivery fields', async () => {
  const first = await mustCall('/api/client-portal/campaigns', { cookie: clientOneCookie });
  const second = await mustCall('/api/client-portal/campaigns', { cookie: clientTwoCookie });
  assert.doesNotMatch(JSON.stringify(first), /Phone Shared|رقم مشترك/);
  assert.doesNotMatch(JSON.stringify(second), /Phone Shared|رقم مشترك/);
  assert.deepEqual(first.campaigns.map((campaign) => campaign.id), [visitCampaign.id]);
  assert.deepEqual(second.campaigns.map((campaign) => campaign.id), [deliveryCampaign.id]);
  const visit = first.campaigns[0];
  assert.equal(visit.campaignType, 'visit');
  assert.equal(visit.targets[0].visitDate, undefined);
  assert.equal(visit.targets[0].visitTime, undefined);
  assert.equal(visit.targets[0].visitAddress, undefined);
  assert.equal(visit.targets[0].visitBranch, undefined);
  assert.equal(visit.targets[0].visitNotes, undefined);
  assert.equal(visit.targets[0].coverageNotes, undefined);
  assert.equal(first.portal.template, 'visit-schedule');
  assert.ok(!visit.sections.includes('visitSchedule'));
  assert.ok(visit.sections.includes('campaignReport'));
  assert.equal('shippingStatus' in visit.targets[0], false);
  const delivery = second.campaigns[0];
  assert.equal(delivery.campaignType, 'delivery');
  assert.equal(delivery.targets[0].shippingStatus, 'shipped');
  assert.equal(delivery.targets[0].recipientName, 'Test Recipient');
  assert.equal(delivery.targets[0].recipientPhone, '5551234567');
  assert.equal(delivery.targets[0].courierContact, '5557654321');
  assert.equal(delivery.targets[0].deliveryCity, 'Riyadh');
  assert.equal(delivery.targets[0].deliveryDistrict, 'North');
  assert.equal(delivery.targets[0].deliveryAddress, 'Test shipping address');
  assert.equal(delivery.targets[0].deliveryMapLink, 'https://maps.example.test/place');
  assert.equal(delivery.targets[0].orderDetails, 'Test items');
  assert.equal(delivery.targets[0].shippingCarrier, 'Local Courier');
  assert.equal(delivery.targets[0].trackingNumber, 'TRACK-123');
  assert.equal(delivery.targets[0].deliveryDate, '2026-10-18');
  assert.equal(second.portal.template, 'delivery-campaign');
  assert.equal(delivery.targets[0].profile.name, 'Delivery Creator');
  assert.equal('visitDate' in delivery.targets[0], false);
  for (const payload of [first, second]) {
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /555999999|staff-only note|another private note|password_hash|checkinToken|Phone Shared|رقم مشترك/);
  }
  const crossClientDecision = await call(
    `/api/client-portal/campaigns/${deliveryCampaign.id}/targets/${influencerIds[1]}/decision`,
    { method: 'POST', cookie: clientOneCookie, body: { decision: 'accepted' } }
  );
  assert.equal(crossClientDecision.response.status, 404);
});

test('accept, reject, and revert update only that client decision and preserve audit history', async () => {
  const decisionPath = `/api/client-portal/campaigns/${visitCampaign.id}/targets/${influencerIds[0]}/decision`;
  for (const decision of ['accepted', 'rejected', 'reverted']) {
    const result = await mustCall(decisionPath, { method: 'POST', cookie: clientOneCookie, body: { decision } });
    assert.equal(result.decision, decision === 'reverted' ? 'pending' : decision);
  }
  const presentation = await mustCall('/api/client-portal/campaigns', { cookie: clientOneCookie });
  const target = presentation.campaigns[0].targets[0];
  assert.equal(target.decision, 'pending');
  assert.deepEqual(target.history.map((event) => event.eventType), ['accepted', 'rejected', 'reverted']);
  assert.equal(target.history[1].previousDecision, 'accepted');
  assert.equal(target.history[2].previousDecision, 'rejected');
  const other = await mustCall('/api/client-portal/campaigns', { cookie: clientTwoCookie });
  assert.equal(other.campaigns[0].targets[0].decision, 'pending');
  assert.equal(other.campaigns[0].targets[0].history.length, 0);
  const invalid = await call(decisionPath, { method: 'POST', cookie: clientOneCookie, body: { decision: 'maybe' } });
  assert.equal(invalid.response.status, 400);
});

test('admin/editor/viewer permissions protect account management and shipping/visit edits', async () => {
  const accountListForEditor = await mustCall('/api/client-accounts', { cookie: editorCookie });
  assert.equal(accountListForEditor.accounts.length, 2);
  const viewerList = await call('/api/client-accounts', { cookie: viewerCookie });
  assert.equal(viewerList.response.status, 403);
  const editorCreate = await call('/api/client-accounts', {
    method: 'POST', cookie: editorCookie,
    body: { username: 'not-allowed', clientName: 'No', companyName: 'No', password: 'Password-2026-long!', campaignIds: [] }
  });
  assert.equal(editorCreate.response.status, 403);
  const editorVisit = await mustCall(`/api/campaigns/${visitCampaign.id}/targets/${influencerIds[0]}`, {
    method: 'PATCH', cookie: editorCookie,
    body: { visitDate: '2026-10-16', visitTime: '10:45', visitLocation: 'Jeddah studio' }
  });
  assert.equal(editorVisit.target.visitDate, '2026-10-16');
  assert.equal(editorVisit.target.visitTime, '10:45');
  assert.equal(editorVisit.target.visitLocation, 'Jeddah studio');
  const editorDelivery = await mustCall(`/api/campaigns/${deliveryCampaign.id}/targets/${influencerIds[1]}`, {
    method: 'PATCH', cookie: editorCookie,
    body: { shippingStatus: 'delivered', shippingCarrier: 'Courier B', trackingNumber: 'TRACK-456', deliveryDate: '2026-10-19' }
  });
  assert.equal(editorDelivery.target.shippingStatus, 'delivered');
  assert.equal(editorDelivery.target.shippingCarrier, 'Courier B');
  assert.equal(editorDelivery.target.trackingNumber, 'TRACK-456');
  assert.equal(editorDelivery.target.deliveryDate, '2026-10-19');
  const viewerEdit = await call(`/api/campaigns/${visitCampaign.id}/targets/${influencerIds[0]}`, {
    method: 'PATCH', cookie: viewerCookie, body: { visitTime: '12:00' }
  });
  assert.equal(viewerEdit.response.status, 403);
  const invalidVisit = await call(`/api/campaigns/${visitCampaign.id}/targets/${influencerIds[0]}`, {
    method: 'PATCH', cookie: editorCookie, body: { visitTime: '25:99' }
  });
  assert.equal(invalidVisit.response.status, 400);
  const wrongDeliveryField = await call(`/api/campaigns/${visitCampaign.id}/targets/${influencerIds[0]}`, {
    method: 'PATCH', cookie: editorCookie, body: { trackingNumber: 'wrong-kind' }
  });
  assert.equal(wrongDeliveryField.response.status, 400);
  const viewerAccountUpdate = await call(`/api/client-accounts/${clientOne.id}`, {
    method: 'PATCH', cookie: viewerCookie, body: { active: false }
  });
  assert.equal(viewerAccountUpdate.response.status, 403);
});

test('decision audit remains durable when a campaign target is later replaced', async () => {
  const updated = await mustCall(`/api/campaigns/${visitCampaign.id}`, {
    method: 'PATCH',
    body: {
      campaignName: 'Visit campaign', companyName: 'Client One Ltd', campaignType: 'visit',
      serviceType: 'influencer', ...period,
      targetIds: [influencerIds[1]],
      targets: [{ id: influencerIds[1], visitDate: '2026-10-15', visitTime: '11:00', visitBranch: 'Replacement branch' }]
    }
  });
  assert.deepEqual(updated.campaign.targets.map((target) => target.id), [influencerIds[1]]);
  const stored = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(stored.prepare('SELECT COUNT(*) AS count FROM client_decision_history WHERE campaign_id = ? AND influencer_id = ?')
    .get(visitCampaign.id, influencerIds[0]).count, 3);
  stored.close();
});

test('schema migration preserves existing influencer data and legacy catalog workflows', async () => {
  const legacy = await mustCall('/api/client-catalogs', {
    method: 'POST', body: { brandId: 'fkretk', clientName: 'Legacy client', companyName: 'Legacy Ltd', influencerIds: [influencerIds[0]] }
  });
  const legacyToken = legacy.url.split('/').at(-1);
  const originalCatalog = await mustCall(`/api/client-catalog/${legacyToken}`);
  assertNoClientInfluencerPrivateData(originalCatalog);
  assert.doesNotMatch(JSON.stringify(originalCatalog), /Phone Shared|رقم مشترك/);
  assert.equal(originalCatalog.influencers[0].name, 'Visit Creator');
  assert.equal('Number' in originalCatalog.influencers[0].details, false);
  assert.equal('Full_Mobile_Number' in originalCatalog.influencers[0].details, false);
  const internalPreview = await mustCall(`/api/client-catalogs/${legacy.catalog.id}/client-preview`);
  assert.equal(internalPreview.previewMode, true);
  assert.equal(internalPreview.decisionsEnabled, false);
  assert.deepEqual(internalPreview.influencers, originalCatalog.influencers);
  const unauthorizedPreview = await call(`/api/client-catalogs/${legacy.catalog.id}/client-preview`, { cookie: '' });
  assert.equal(unauthorizedPreview.response.status, 401);
  const previewPage = await fetch(`${baseUrl}/client-preview?catalog=${legacy.catalog.id}`);
  assert.equal(previewPage.status, 200);
  assert.match(await previewPage.text(), /previewCatalogId/);
  await mustCall(`/api/client-catalog/${legacyToken}/decision`, {
    method: 'POST', cookie: '',
    body: { influencerId: influencerIds[0], decision: 'accepted' }
  });
  const afterDecision = await mustCall(`/api/client-catalog/${legacyToken}`);
  assert.equal(afterDecision.influencers[0].decision, 'accepted');
  const catalogSummary = (await mustCall('/api/client-catalogs')).catalogs.find((catalog) => catalog.id === legacy.catalog.id);
  assert.equal(catalogSummary.acceptedInfluencerRecords[0].accounts[0].username, 'visit_creator');
  const stored = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(stored.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, 3);
  assert.equal(stored.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(stored.prepare('SELECT COUNT(*) AS count FROM client_accounts').get().count, 2);
  const passwordHash = stored.prepare('SELECT password_hash FROM client_accounts WHERE id = ?').get(clientOne.id).password_hash;
  assert.notEqual(passwordHash, 'Client-one-pass-2026!');
  assert.match(passwordHash, /^[a-f0-9]{128}$/);
  assert.deepEqual(
    stored.prepare('PRAGMA table_info(campaign_targets)').all().map((column) => column.name).filter((name) => ['visit_time', 'visit_location', 'shipping_carrier', 'tracking_number', 'delivery_date'].includes(name)).sort(),
    ['delivery_date', 'shipping_carrier', 'tracking_number', 'visit_location', 'visit_time']
  );
  stored.close();
});

test('client share links expire and access logs retain no visitor identity', async () => {
  const expiryDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const offer = await mustCall('/api/client-catalogs', {
    method: 'POST',
    body: {
      brandId: 'fkretk',
      companyName: 'Synthetic Expiring Company',
      offerName: 'Synthetic expiring share',
      expiresAt: expiryDate,
      influencerIds: [influencerIds[0]]
    }
  });
  const token = offer.url.split('/').at(-1);
  assert.equal(offer.catalog.expiresAt.slice(0, 10), expiryDate);
  assert.equal((await mustCall(`/api/client-catalog/${token}`, { cookie: '' })).influencers.length, 1);
  let stored = new DatabaseSync(databasePath, { readOnly: true });
  const accessColumns = stored.prepare('PRAGMA table_info(client_catalog_access_events)').all().map(row => row.name);
  assert.deepEqual(accessColumns, ['id', 'catalog_id', 'event_type', 'accessed_at']);
  assert.deepEqual(stored.prepare(`SELECT event_type FROM client_catalog_access_events
    WHERE catalog_id = ? ORDER BY id`).all(offer.catalog.id).map(row => row.event_type), ['view']);
  stored.close();

  stored = new DatabaseSync(databasePath);
  stored.prepare('UPDATE client_catalogs SET expires_at = ? WHERE id = ?')
    .run('2000-01-01T23:59:59.999Z', offer.catalog.id);
  stored.close();
  const expired = await fetch(`${baseUrl}/api/client-catalog/${token}`);
  assert.equal(expired.status, 410);
  stored = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(stored.prepare(`SELECT event_type FROM client_catalog_access_events
    WHERE catalog_id = ? ORDER BY id`).all(offer.catalog.id).map(row => row.event_type), ['view', 'expired']);
  const summary = (await mustCall('/api/client-catalogs')).catalogs.find(row => row.id === offer.catalog.id);
  assert.equal(summary.accessCount, 2);
  assert.ok(summary.lastAccessedAt);
  stored.close();
});

test('public client decisions confirm together, keep their history dates, and greet the client by name', async () => {
  const offer = await mustCall('/api/client-catalogs', {
    method: 'POST',
    body: {
      brandId: 'fkretk',
      clientName: 'Synthetic Target Client',
      companyName: 'Synthetic Target Company',
      offerName: 'Test shortlist',
      offerStatus: 'published',
      influencerIds: [influencerIds[0], influencerIds[1]]
    }
  });
  const token = offer.url.split('/').at(-1);
  const published = await mustCall(`/api/client-catalog/${token}`, { cookie: '' });
  assertNoClientInfluencerPrivateData(published);
  assert.equal(published.clientName, 'Synthetic Target Client');
  const clientPage = await fetch(`${baseUrl}/client/${token}`);
  const clientHtml = await clientPage.text();
  assert.equal(clientPage.status, 200);
  assert.doesNotMatch(clientHtml, /creator-search|creator-platform-filter|client-filter-toolbar/);
  assert.match(clientHtml, /تأكيد الاختيارات/);
  assert.match(clientHtml, /decision-progress-label/);

  const submitted = await mustCall(`/api/client-catalog/${token}/decisions`, {
    method: 'POST', cookie: '',
    body: { decisions: [
      { influencerId: influencerIds[0], decision: 'accepted' },
      { influencerId: influencerIds[1], decision: 'rejected' }
    ] }
  });
  assertNoClientInfluencerPrivateData(submitted);
  assert.equal(submitted.decisions.length, 2);
  assert.ok(submitted.decisions.every((decision) => Number.isFinite(Date.parse(decision.createdAt))));
  const readOnly = new DatabaseSync(databasePath, { readOnly: true });
  const saved = readOnly.prepare(`SELECT influencer_id, decision, created_at FROM client_catalog_decisions
    WHERE catalog_id = ? ORDER BY influencer_id`).all(offer.catalog.id);
  const history = readOnly.prepare(`SELECT influencer_id, event_type, decision, created_at
    FROM client_catalog_decision_history WHERE catalog_id = ? ORDER BY created_at, rowid`).all(offer.catalog.id);
  assert.equal(saved.length, 2);
  assert.equal(history.length, 2);
  assert.ok(saved.every((decision) => Number.isFinite(Date.parse(decision.created_at))));
  assert.ok(history.every((event) => Number.isFinite(Date.parse(event.created_at))));
  readOnly.close();

  const invalidBatch = await call(`/api/client-catalog/${token}/decisions`, {
    method: 'POST', cookie: '',
    body: { decisions: [
      { influencerId: influencerIds[0], decision: 'reverted' },
      { influencerId: 'f'.repeat(32), decision: 'accepted' }
    ] }
  });
  assert.equal(invalidBatch.response.status, 400);
  assert.equal((await mustCall(`/api/client-catalog/${token}`, { cookie: '' })).influencers[0].decision, 'accepted');
});

test('client showcase stays readable across languages, themes, and screen sizes and submits staged decisions', async () => {
  const extraCreator = await mustCall('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic creator with a deliberately long bilingual profile name صانع محتوى تجريبي طويل جدًا',
    'Username I': 'qa_showcase_long_profile', 'Followers Count I': '25000'
  } });
  const clientName = 'Synthetic bilingual client name for layout verification عميل تجريبي طويل للاختبار';
  const offer = await mustCall('/api/client-catalogs', {
    method: 'POST',
    body: {
      brandId: 'fkretk',
      clientName,
      companyName: 'Synthetic Showcase Company',
      offerName: 'Responsive showcase test',
      offerStatus: 'published',
      influencerIds: [influencerIds[0], influencerIds[1], extraCreator.record.id]
    }
  });
  const token = offer.url.split('/').at(-1);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${baseUrl}/client/${token}`);
    await page.locator('.card').first().waitFor();
    assert.equal(await page.locator('#creator-search').count(), 0);
    assert.equal(await page.locator('.filter-toolbar, #creator-filters').count(), 0);
    assert.equal((await page.locator('#company-identity').textContent()).trim(), `عرض مُعدّ خصيصًا لـ ${clientName}`);
    assert.equal(await page.locator('#send-decisions').textContent().then((text) => text.trim()), 'تأكيد الاختيارات');
    assert.match(await page.locator('#decision-progress-label').textContent(), /٪|%/);
    assert.equal(await page.locator('.decision-progress').getAttribute('aria-valuenow'), '0');
    assert.equal(await page.locator('.card').count(), 3);

    const assertNoHorizontalOverflow = async () => {
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth
      }));
      assert.ok(dimensions.document <= dimensions.viewport + 1, JSON.stringify(dimensions));
      const names = await page.locator('.card h3').evaluateAll((elements) =>
        elements.map((element) => ({ width: element.clientWidth, content: element.scrollWidth })));
      assert.ok(names.every((item) => item.content <= item.width + 1), JSON.stringify(names));
    };
    await assertNoHorizontalOverflow();

    const firstCard = page.locator(`.card[data-influencer-id="${influencerIds[0]}"]`);
    const secondCard = page.locator(`.card[data-influencer-id="${influencerIds[1]}"]`);
    await firstCard.locator('[data-action="accept"]').click();
    assert.equal((await firstCard.locator('[data-action="revert"]').textContent()).trim(), 'تغيير القرار');
    await firstCard.locator('[data-action="revert"]').click();
    await page.locator('#decision-confirm').click();
    assert.equal(await firstCard.locator('[data-action="accept"]').count(), 1);
    await secondCard.locator('[data-action="reject"]').click();
    await page.locator('#decision-confirm').click();
    assert.equal((await secondCard.locator('[data-action="revert"]').textContent()).trim(), 'تغيير القرار');
    await secondCard.locator('[data-action="revert"]').click();
    await page.locator('#decision-confirm').click();
    assert.equal(await secondCard.locator('[data-action="reject"]').count(), 1);

    await page.locator('#client-theme-toggle').click();
    assert.equal(await page.locator('body').getAttribute('data-theme'), 'dark');
    await page.locator('#client-language-toggle').click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.equal((await page.locator('#company-identity').textContent()).trim(), `Prepared especially for ${clientName}`);
    assert.equal((await page.locator('#send-decisions').textContent()).trim(), 'Confirm selections');
    await assertNoHorizontalOverflow();

    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoHorizontalOverflow();
    await page.locator('#client-theme-toggle').click();
    assert.equal(await page.locator('body').getAttribute('data-theme'), 'light');
    await assertNoHorizontalOverflow();
    await page.locator('#client-theme-toggle').click();
    await page.locator('#client-language-toggle').click();
    assert.equal(await page.locator('html').getAttribute('lang'), 'ar');
    await assertNoHorizontalOverflow();

    await firstCard.locator('[data-action="accept"]').click();
    await secondCard.locator('[data-action="reject"]').click();
    await page.locator('#decision-confirm').click();
    await page.locator('#send-decisions').click();
    await page.locator('#decision-toast').filter({ hasText: 'تم إرسال اختياراتك بنجاح.' }).waitFor();
    const savedCatalog = await mustCall(`/api/client-catalog/${token}`, { cookie: '' });
    assert.deepEqual(savedCatalog.influencers.map((item) => item.decision), ['accepted', 'rejected', 'pending']);
    const historyDb = new DatabaseSync(databasePath, { readOnly: true });
    const history = historyDb.prepare(`SELECT decision, created_at FROM client_catalog_decision_history
      WHERE catalog_id = ? ORDER BY rowid`).all(offer.catalog.id);
    historyDb.close();
    assert.deepEqual(history.map((item) => item.decision), ['accepted', 'rejected']);
    assert.ok(history.every((item) => Number.isFinite(Date.parse(item.created_at))));
  } finally {
    await browser.close();
  }
});

test('independent client catalogs publish only their selected company work videos', async () => {
  const videos = [];
  for (let index = 1; index <= 10; index += 1) {
    const videoId = `FKwork${String(index).padStart(5, '0')}`;
    videos.push((await mustCall('/api/company-work-videos', {
      method: 'POST',
      body: { url: `https://youtu.be/${videoId}`, title: `Synthetic sample ${index}` }
    })).video);
  }
  assert.equal((await mustCall('/api/company-work-videos')).videos.length >= 10, true);
  const selectedIds = [videos[1].id, videos[4].id, videos[8].id];
  const offer = await mustCall('/api/client-catalogs', {
    method: 'POST',
    body: {
      brandId: 'fkretk',
      clientName: 'Synthetic client',
      companyName: 'Synthetic company',
      offerName: 'Synthetic client presentation',
      offerStatus: 'published',
      influencerIds: [influencerIds[0]],
      showCompanyWork: true,
      workVideoIds: selectedIds
    }
  });
  const ryfaqOffer = await mustCall('/api/client-catalogs', {
    method: 'POST',
    body: {
      brandId: 'ryfaq', offerName: 'Ryfaq shortlist', companyName: 'Ryfaq client',
      offerStatus: 'published', influencerIds: [influencerIds[0]]
    }
  });
  const ryfaqCatalog = await mustCall(`/api/client-catalog/${ryfaqOffer.url.split('/').at(-1)}`);
  assert.equal(ryfaqCatalog.brand.id, 'ryfaq');
  assert.equal(ryfaqCatalog.brand.primaryColor, '#427E60');
  assert.equal(ryfaqCatalog.showCompanyWork, false);
  const ryfaqClientPassword = 'Ryfaq-client-pass-2026!';
  await mustCall('/api/client-accounts', {
    method: 'POST',
    body: {
      username: 'ryfaq-brand-client', email: 'ryfaq.brand@example.test',
      clientName: 'Ryfaq Brand Client', companyName: 'Ryfaq Client Company',
      password: ryfaqClientPassword, clientType: 'prospective',
      catalogIds: [ryfaqOffer.catalog.id],
      portalConfig: {
        template: 'request-approval', status: 'published', sections: ['requestApproval'],
        fields: { requestApproval: ['name', 'username'], visitSchedule: [], deliveryCampaign: [], campaignReport: [] },
        actions: { allowDecisions: false, allowRevert: false, allowVisitConfirmation: false, allowVisitChangeRequest: false, allowShippingFollowUp: false }
      }
    }
  });
  const ryfaqClientCookie = await loginClient('ryfaq.brand@example.test', ryfaqClientPassword);
  const ryfaqPortal = await mustCall('/api/client-portal/campaigns', { cookie: ryfaqClientCookie });
  assert.equal(ryfaqPortal.brand.id, 'ryfaq');
  assert.equal(ryfaqPortal.brand.primaryColor, '#427E60');
  const token = offer.url.split('/').at(-1);
  const clientPage = await fetch(`${baseUrl}/client/${token}`);
  assert.equal(clientPage.status, 200);
  assert.match(clientPage.headers.get('content-security-policy') || '', /script-src .*https:\/\/www\.youtube\.com/);
  assert.match(clientPage.headers.get('content-security-policy') || '', /frame-src https:\/\/www\.youtube-nocookie\.com/);
  const clientPageHtml = await clientPage.text();
  assert.match(clientPageHtml, /id="brand-favicon" rel="icon" type="image\/png"/);
  assert.match(clientPageHtml, /favicon\.href = '\/assets\/fikratak-digital-logo\.png'/);
  assert.match(clientPageHtml, /<dialog id="work-video-dialog"/);
  assert.match(clientPageHtml, /id="work-video-close"/);
  assert.match(clientPageHtml, /card\.addEventListener\('click', \(\) => openWorkVideo\(video\)\)/);
  assert.match(clientPageHtml, /new URL\(`https:\/\/www\.youtube\.com\/embed\/\$\{encodeURIComponent\(video\.videoId\)\}`\)/);
  assert.match(clientPageHtml, /playerVars: \{ autoplay: 1, controls: 1/);
  assert.match(clientPageHtml, /\[101, 150\]\.includes\(event\.data\)/);
  assert.match(clientPageHtml, /autoplay; encrypted-media; picture-in-picture; fullscreen/);
  assert.match(clientPageHtml, /iframe\.allowFullscreen = true/);
  assert.match(clientPageHtml, /code === 153/);
  assert.match(clientPageHtml, /videoNoEmbed/);
  assert.match(clientPageHtml, /company-work-grid/);
  assert.match(clientPageHtml, /id="work-video-youtube-link"[^>]*hidden/);
  assert.doesNotMatch(clientPageHtml, /window\.open\([^)]*youtube/);
  assert.doesNotMatch(clientPageHtml, /work-player-start/);
  const publicOffer = await mustCall(`/api/client-catalog/${token}`);
  assert.equal(publicOffer.showCompanyWork, true);
  assert.deepEqual(publicOffer.companyWorkVideos.map((video) => video.id), selectedIds);

  const hidden = await mustCall(`/api/client-catalogs/${offer.catalog.id}`, {
    method: 'PATCH',
    body: { showCompanyWork: false, workVideoIds: selectedIds }
  });
  assert.equal(hidden.catalog.showCompanyWork, false);
  const hiddenPublic = await mustCall(`/api/client-catalog/${token}`);
  assert.equal(hiddenPublic.showCompanyWork, false);
  assert.deepEqual(hiddenPublic.companyWorkVideos, []);

  await mustCall(`/api/client-catalogs/${offer.catalog.id}`, {
    method: 'PATCH',
    body: { showCompanyWork: true, workVideoIds: [] }
  });
  const emptySelection = await mustCall(`/api/client-catalog/${token}`);
  assert.equal(emptySelection.showCompanyWork, true);
  assert.deepEqual(emptySelection.companyWorkVideos, []);

  await mustCall(`/api/client-catalogs/${offer.catalog.id}`, {
    method: 'PATCH',
    body: { showCompanyWork: true, workVideoIds: [selectedIds[2]] }
  });
  const restored = await mustCall(`/api/client-catalog/${token}`);
  assert.equal(restored.showCompanyWork, true);
  assert.deepEqual(restored.companyWorkVideos.map((video) => video.id), [selectedIds[2]]);
  assert.deepEqual((await mustCall('/api/client-catalogs')).catalogs
    .find((catalog) => catalog.id === offer.catalog.id).workVideoIds, [selectedIds[2]]);

  const invalidVideo = await call(`/api/client-catalogs/${offer.catalog.id}`, {
    method: 'PATCH', body: { workVideoIds: ['a'.repeat(32)] }
  });
  assert.equal(invalidVideo.response.status, 400);
  const editorCannotEdit = await call(`/api/client-catalogs/${offer.catalog.id}`, {
    method: 'PATCH', cookie: editorCookie, body: { showCompanyWork: false, workVideoIds: [] }
  });
  assert.equal(editorCannotEdit.response.status, 403);
});

test('admin account updates rehash passwords and revoke disabled or changed-password sessions', async () => {
  await mustCall(`/api/client-accounts/${clientTwo.id}`, {
    method: 'PATCH',
    body: { companyName: 'Client Two Updated Ltd', password: 'Client-two-new-pass-2026!' }
  });
  const revokedSession = await call('/api/client-portal/campaigns', { cookie: clientTwoCookie });
  assert.equal(revokedSession.response.status, 401);
  const oldPassword = await call('/api/client-portal/login', {
    method: 'POST', cookie: '', body: { username: 'client-two', password: 'Client-two-pass-2026!' }
  });
  assert.equal(oldPassword.response.status, 401);
  const newCookie = await login('client-two', 'Client-two-new-pass-2026!', '/api/client-portal/login');
  const updatedClient = await mustCall('/api/client-portal/campaigns', { cookie: newCookie });
  assert.equal(updatedClient.client.companyName, 'Client Two Updated Ltd');
  await mustCall(`/api/client-accounts/${clientTwo.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal((await call('/api/client-portal/campaigns', { cookie: newCookie })).response.status, 401);
  assert.equal((await call('/api/client-portal/login', {
    method: 'POST', cookie: '', body: { username: 'client-two', password: 'Client-two-new-pass-2026!' }
  })).response.status, 401);
});

test('portal templates, admin preview, and field visibility are enforced and reusable', async () => {
  const preview = await mustCall(`/api/client-accounts/${clientOne.id}/preview`);
  assert.equal(preview.portal.template, 'visit-schedule');
  assert.equal(preview.campaigns[0].targets[0].visitBranch, undefined);
  assert.equal('recipientPhone' in preview.campaigns[0].targets[0], false);
  const editorPreview = await call(`/api/client-accounts/${clientOne.id}/preview`, { cookie: editorCookie });
  assert.equal(editorPreview.response.status, 403);

  const config = {
    template: 'custom-view', status: 'draft',
    sections: ['campaignReport', 'visitSchedule'],
    fields: {
      requestApproval: [], visitSchedule: ['name', 'visitDate', 'visitBranch'],
      deliveryCampaign: [], campaignReport: ['targetCount', 'visitSummary']
    },
    actions: {
      allowDecisions: false, allowRevert: true, allowVisitConfirmation: false,
      allowVisitChangeRequest: false, allowShippingFollowUp: false
    }
  };
  const savedTemplate = await mustCall('/api/client-portal-templates', {
    method: 'POST', body: { name: 'Visit schedule template', config }
  });
  assert.equal(savedTemplate.template.config.status, 'draft');
  const templates = await mustCall('/api/client-portal-templates');
  assert.ok(templates.templates.some(template => template.id === savedTemplate.template.id));
  const forbiddenTemplate = await call('/api/client-portal-templates', {
    method: 'POST', cookie: editorCookie, body: { name: 'Not allowed', config }
  });
  assert.equal(forbiddenTemplate.response.status, 403);

  const updated = await mustCall(`/api/client-accounts/${clientOne.id}`, {
    method: 'PATCH', body: { portalConfig: config, campaignIds: [visitCampaign.id] }
  });
  assert.equal(updated.account.portalStatus, 'draft');
  const draftLogin = await call('/api/client-portal/campaigns', { cookie: clientOneCookie });
  assert.equal(draftLogin.response.status, 403);
  const draftPreview = await mustCall(`/api/client-accounts/${clientOne.id}/preview`);
  assert.equal(draftPreview.portal.status, 'draft');
  assert.equal(draftPreview.campaigns[0].targets[0].visitTime, undefined);
});

test('client visit and shipping actions honor per-page settings and avoid duplicate visit confirmation', async () => {
  await mustCall(`/api/client-accounts/${clientOne.id}`, {
    method: 'PATCH',
    body: {
      portalConfig: {
        template: 'visit-schedule', status: 'published', sections: ['requestApproval', 'visitSchedule'],
        fields: {
          requestApproval: ['name', 'username', 'decision'],
          visitSchedule: ['name', 'visitDate', 'visitStatus'],
          deliveryCampaign: [], campaignReport: []
        },
        actions: { allowDecisions: true, allowRevert: true, allowVisitConfirmation: true, allowVisitChangeRequest: true, allowShippingFollowUp: false }
      },
      campaignIds: [visitCampaign.id]
    }
  });
  await mustCall(`/api/client-accounts/${clientTwo.id}`, {
    method: 'PATCH',
    body: {
      portalConfig: {
        template: 'delivery-campaign', status: 'published', sections: ['requestApproval', 'deliveryCampaign'],
        fields: {
          requestApproval: ['name', 'username', 'decision'], visitSchedule: [],
          deliveryCampaign: ['recipientName', 'shippingStatus'], campaignReport: []
        },
        actions: { allowDecisions: true, allowRevert: true, allowVisitConfirmation: false, allowVisitChangeRequest: false, allowShippingFollowUp: true }
      },
      campaignIds: [deliveryCampaign.id],
      active: true
    }
  });
  const refreshedClientTwoCookie = await login('client-two', 'Client-two-new-pass-2026!', '/api/client-portal/login');
  const visitActionPath = `/api/client-portal/campaigns/${visitCampaign.id}/targets/${influencerIds[1]}/action`;
  const confirmed = await call(visitActionPath, {
    method: 'POST', cookie: clientOneCookie, body: { action: 'visit_confirmed' }
  });
  assert.equal(confirmed.response.status, 403);
  const deliveryActionPath = `/api/client-portal/campaigns/${deliveryCampaign.id}/targets/${influencerIds[1]}/action`;
  await mustCall(deliveryActionPath, {
    method: 'POST', cookie: refreshedClientTwoCookie,
    body: { action: 'shipping_followup', details: 'Confirm delivery window' }
  });
  const crossClientAction = await call(deliveryActionPath, {
    method: 'POST', cookie: clientOneCookie, body: { action: 'shipping_followup' }
  });
  assert.equal(crossClientAction.response.status, 403);
  const result = await mustCall('/api/client-portal/campaigns', { cookie: clientOneCookie });
  assert.equal(result.campaigns[0].targets[0].visitStatus, undefined);
  assert.equal(result.campaigns[0].targets[0].clientActions.length, 0);
});

test('offers link independently to portal accounts and preserve read-only legacy links', async () => {
  const offer = await mustCall('/api/client-catalogs', {
    method: 'POST',
    body: {
      brandId: 'fkretk',
      offerName: 'Approval shortlist', clientName: 'Prospect', companyName: 'Prospect Ltd',
      offerStatus: 'published', influencerIds: [influencerIds[0]]
    }
  });
  const offerToken = offer.url.split('/').at(-1);
  const { account } = await mustCall('/api/client-accounts', {
    method: 'POST',
    body: {
      username: 'prospective-client', email: 'prospect@example.test', clientName: 'Prospect', companyName: 'Prospect Ltd',
      clientType: 'prospective', password: 'Prospective-pass-2026!', catalogIds: [offer.catalog.id],
      portalConfig: {
        template: 'request-approval', status: 'published', sections: ['requestApproval'],
        fields: {
          requestApproval: ['username', 'platform'], visitSchedule: [],
          deliveryCampaign: [], campaignReport: []
        },
        actions: { allowDecisions: true, allowRevert: true, allowVisitConfirmation: false, allowVisitChangeRequest: false, allowShippingFollowUp: false }
      }
    }
  });
  assert.equal(account.clientType, 'prospective');
  assert.equal(account.campaignCount, 0);
  assert.equal(account.offers[0].id, offer.catalog.id);
  const clientCookie = await login('prospective-client', 'Prospective-pass-2026!', '/api/client-portal/login');
  const portal = await mustCall('/api/client-portal/campaigns', { cookie: clientCookie });
  assertNoClientInfluencerPrivateData(portal);
  const presented = portal.offers[0].influencers[0];
  assert.equal(presented.mainUsername, 'visit_main_username');
  assert.equal(presented.platform, 'Instagram');
  assert.equal('mainPlatform' in presented, false);
  assert.equal(presented.name, 'Visit Creator');
  assert.equal('followers' in presented, false);
  assert.equal('price' in presented, false);
  assert.equal('accountLink' in presented, false);
  assert.equal(presented.profiles[0].platform, 'Instagram');
  assert.match(presented.profiles[0].profileUrl, /instagram\.com\/visit_creator/);
  assert.equal(presented.decision, 'pending');
  assert.equal(portal.campaigns.length, 0);
  assert.doesNotMatch(JSON.stringify(portal), /555123456|staff-only note|1000/);
  const forbiddenDecision = await call(`/api/client-portal/offers/${offer.catalog.id}/targets/${influencerIds[0]}/decision`, {
    method: 'POST', cookie: clientCookie, body: { decision: 'accepted' }
  });
  assert.equal(forbiddenDecision.response.status, 403);
  const legacyOffer = await mustCall(`/api/client-catalog/${offerToken}`);
  assert.equal(legacyOffer.decisionsEnabled, false);
  const legacyDecision = await call(`/api/client-catalog/${offerToken}/decision`, {
    method: 'POST', cookie: '', body: { influencerId: influencerIds[0], decision: 'accepted' }
  });
  assert.equal(legacyDecision.response.status, 403);
  await mustCall(`/api/client-accounts/${account.id}`, { method: 'PATCH', body: { catalogIds: [] } });
  const unlinkedDecision = await call(`/api/client-catalog/${offerToken}/decision`, {
    method: 'POST', cookie: '', body: { influencerId: influencerIds[0], decision: 'accepted' }
  });
  assert.equal(unlinkedDecision.response.status, 403);

  const currentOffer = await mustCall('/api/client-catalogs', {
    method: 'POST',
    body: { brandId: 'fkretk', offerName: 'Current client shortlist', companyName: 'Client One Ltd', influencerIds: [influencerIds[0]] }
  });
  await mustCall(`/api/client-accounts/${clientOne.id}`, {
    method: 'PATCH', body: { catalogIds: [currentOffer.catalog.id] }
  });
  const portalOffers = await mustCall('/api/client-portal/campaigns', { cookie: clientOneCookie });
  assert.equal(portalOffers.offers[0].id, currentOffer.catalog.id);
  const offerDecisionPath = `/api/client-portal/offers/${currentOffer.catalog.id}/targets/${influencerIds[0]}/decision`;
  await mustCall(offerDecisionPath, { method: 'POST', cookie: clientOneCookie, body: { decision: 'accepted' } });
  await mustCall(offerDecisionPath, { method: 'POST', cookie: clientOneCookie, body: { decision: 'rejected' } });
  await mustCall(offerDecisionPath, { method: 'POST', cookie: clientOneCookie, body: { decision: 'reverted' } });
  const decidedOffer = (await mustCall('/api/client-portal/campaigns', { cookie: clientOneCookie })).offers[0].influencers[0];
  assert.equal(decidedOffer.decision, 'pending');
  assert.deepEqual(decidedOffer.history.map((event) => event.eventType), ['accepted', 'rejected', 'reverted']);
  assert.equal(decidedOffer.history[1].previousDecision, 'accepted');
  assert.equal(decidedOffer.history[2].previousDecision, 'rejected');
  assert.equal(decidedOffer.history[0].actor, 'client-one');
});

test('mixed campaigns assign exactly one execution type per target and QR requires authenticated confirmation', async () => {
  const mixed = (await mustCall('/api/campaigns', {
    method: 'POST',
    body: {
      campaignName: 'Mixed campaign', companyName: 'Mixed Client', campaignType: 'mix',
      qrEnabled: true, serviceType: 'mix', ...period,
      targets: [
        { id: influencerIds[0], executionType: 'visit', visitDate: '2026-10-15', visitTime: '14:00' },
        { id: influencerIds[1], executionType: 'delivery', recipientName: 'Test Receiver', recipientPhone: '5557654321' }
      ]
    }
  })).campaign;
  assert.equal(mixed.campaignType, 'mix');
  assert.equal(mixed.targets[0].executionType, 'visit');
  assert.equal(mixed.targets[1].executionType, 'delivery');
  const invalidMixed = await call('/api/campaigns', {
    method: 'POST',
    body: {
      campaignName: 'Invalid mixed campaign', companyName: 'Mixed Client', campaignType: 'mix',
      serviceType: 'mix', ...period,
      targets: [{ id: influencerIds[1], executionType: 'delivery' }]
    }
  });
  assert.equal(invalidMixed.response.status, 400);
  const stored = new DatabaseSync(databasePath, { readOnly: true });
  const mixedTypes = stored.prepare('SELECT campaign_type, execution_mode FROM campaigns WHERE id = ?').get(mixed.id);
  assert.equal(mixedTypes.campaign_type, 'visit');
  assert.equal(mixedTypes.execution_mode, 'mix');
  assert.deepEqual(
    stored.prepare('SELECT execution_type FROM campaign_targets WHERE campaign_id = ? ORDER BY position').all(mixed.id).map(row => row.execution_type),
    ['visit', 'delivery']
  );
  stored.close();
  await mustCall('/api/client-accounts', {
    method: 'POST',
    body: {
      username: 'mixed-client', email: 'mixed@example.test', clientName: 'Mixed Client', companyName: 'Mixed Client',
      password: 'Mixed-client-pass-2026!', campaignIds: [mixed.id],
      portalConfig: {
        template: 'custom-view', status: 'published',
        sections: ['requestApproval', 'visitSchedule', 'deliveryCampaign'],
        fields: {
          requestApproval: ['name', 'username'], visitSchedule: ['visitDate', 'visitTime'],
          deliveryCampaign: ['recipientName', 'shippingStatus'], campaignReport: []
        },
        actions: { allowDecisions: true, allowRevert: true, allowVisitConfirmation: false, allowVisitChangeRequest: false, allowShippingFollowUp: false }
      }
    }
  });
  const mixedCookie = await login('mixed-client', 'Mixed-client-pass-2026!', '/api/client-portal/login');
  const mixedPortal = await mustCall('/api/client-portal/campaigns', { cookie: mixedCookie });
  const presentedTargets = mixedPortal.campaigns[0].targets;
  assert.deepEqual(presentedTargets.map(target => target.executionType), ['visit', 'delivery']);
  assert.equal(presentedTargets[0].visitDate, undefined);
  assert.equal('recipientName' in presentedTargets[0], false);
  assert.equal(presentedTargets[1].recipientName, 'Test Receiver');
  assert.equal('visitDate' in presentedTargets[1], false);

  const qrExportPath = `/api/campaigns/${mixed.id}/targets/${influencerIds[0]}/qr-export`;
  const qrWithoutConfirmation = await call(qrExportPath, { method: 'POST', body: {} });
  assert.equal(qrWithoutConfirmation.response.status, 403);
  assert.equal('checkinPath' in qrWithoutConfirmation.body, false);
  const qrAsAnotherUser = await call(qrExportPath, {
    method: 'POST',
    body: { confirmationUsername: 'another-admin', confirmationPassword: 'Portal-admin-pass-2026!' }
  });
  assert.equal(qrAsAnotherUser.response.status, 403);
  assert.equal('checkinPath' in qrAsAnotherUser.body, false);
  const qr = await mustCall(qrExportPath, {
    method: 'POST',
    body: { confirmationUsername: 'portal-admin', confirmationPassword: 'Portal-admin-pass-2026!' }
  });
  const qrUrl = qr.checkinPath;
  assert.match(qrUrl, /^\/campaign-checkin\/[A-Za-z0-9_-]+$/);
  const qrApiPath = qrUrl.replace('/campaign-checkin/', '/api/campaign-checkin/');
  assert.equal('checkinToken' in mixed.targets[0], false);
  const page = await fetch(`${baseUrl}${qrUrl}`);
  const pageHtml = await page.text();
  assert.match(pageHtml, /لا يسجل أي إجراء/);
  assert.match(pageHtml, /addEventListener\('click'/);
  const before = new DatabaseSync(databasePath, { readOnly: true });
  const visitsBefore = before.prepare('SELECT visited_at FROM campaign_targets WHERE campaign_id = ? AND influencer_id = ?').get(mixed.id, influencerIds[0]).visited_at;
  before.close();
  assert.equal(visitsBefore, null);
  const anonymous = await call(qrApiPath, { method: 'POST', cookie: '', body: { action: 'visit' } });
  assert.equal(anonymous.response.status, 401);
  const viewerCheckin = await call(qrApiPath, { method: 'POST', cookie: viewerCookie, body: { action: 'visit' } });
  assert.equal(viewerCheckin.response.status, 403);
  const checked = await mustCall(qrApiPath, { method: 'POST', body: { action: 'visit' } });
  assert.equal(checked.action, 'visit');
  const duplicate = await call(qrApiPath, { method: 'POST', body: { action: 'visit' } });
  assert.equal(duplicate.response.status, 409);
  await mustCall(qrApiPath, { method: 'POST', body: { action: 'coverage' } });
  const disabledQr = await call(`/api/campaigns/${visitCampaign.id}/targets/${influencerIds[0]}/qr-export`, {
    method: 'POST',
    body: { confirmationUsername: 'portal-admin', confirmationPassword: 'Portal-admin-pass-2026!' }
  });
  assert.equal(disabledQr.response.status, 404);
});

test('Excel offer imports match existing usernames safely and client decisions remain portal-managed', async () => {
  const offer = await mustCall('/api/client-catalogs', {
    method: 'POST',
    body: { brandId: 'fkretk', offerName: 'Excel review', companyName: 'Excel Client', offerStatus: 'published', influencerIds: [influencerIds[0]] }
  });
  const listWorkbook = createXlsx([
    ['Influencer ID', 'Username', 'Platform', 'Decision'],
    ['', 'delivery_creator', 'TikTok', ''],
    ['', 'missing_creator', 'Instagram', ''],
    [influencerIds[1], '', '', ''],
    [influencerIds[0], '', '', '']
  ]);
  const base64 = listWorkbook.toString('base64');
  const beforePreview = new DatabaseSync(databasePath, { readOnly: true });
  const originalItems = beforePreview.prepare('SELECT COUNT(*) AS n FROM client_catalog_items WHERE catalog_id = ?').get(offer.catalog.id).n;
  beforePreview.close();
  const viewerPreview = await call('/api/client-catalogs/import-preview', {
    method: 'POST', cookie: viewerCookie,
    body: { fileName: 'influencers.xlsx', fileBase64: base64, catalogId: offer.catalog.id }
  });
  assert.equal(viewerPreview.response.status, 403);
  const preview = await mustCall('/api/client-catalogs/import-preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'influencers.xlsx', fileBase64: base64, catalogId: offer.catalog.id }
  });
  assert.deepEqual(preview.counts, { matched: 1, unmatched: 1, duplicate: 1, invalid: 0, 'already-in-offer': 1 });
  const arabicWorkbook = createXlsx([
    ['اسم المستخدم', 'المنصة'],
    ['delivery_creator', 'تيك توك']
  ]);
  const arabicPreview = await mustCall('/api/client-catalogs/import-preview', {
    method: 'POST',
    body: { fileName: 'influencers-ar.xlsx', fileBase64: arabicWorkbook.toString('base64'), catalogId: offer.catalog.id }
  });
  assert.equal(arabicPreview.counts.matched, 1);
  const usernameOnlyWorkbook = createXlsx([
    ['Username'],
    ['delivery_creator'],
    ['missing_creator']
  ]);
  const usernameOnlyPreview = await mustCall('/api/client-catalogs/import-preview', {
    method: 'POST',
    body: { fileName: 'usernames.xlsx', fileBase64: usernameOnlyWorkbook.toString('base64'), catalogId: offer.catalog.id }
  });
  assert.equal(usernameOnlyPreview.counts.matched, 1);
  assert.equal(usernameOnlyPreview.counts.unmatched, 1);
  const ambiguous = await mustCall('/api/influencers', {
    method: 'POST',
    body: { Name: 'Ambiguous test account', 'Username T': 'visit_creator' }
  });
  const ambiguousWorkbook = createXlsx([['Username'], ['visit_creator']]);
  const ambiguousPreview = await mustCall('/api/client-catalogs/import-preview', {
    method: 'POST',
    body: { fileName: 'ambiguous.xlsx', fileBase64: ambiguousWorkbook.toString('base64'), catalogId: offer.catalog.id }
  });
  assert.equal(ambiguousPreview.counts.invalid, 1);
  assert.match(ambiguousPreview.rows[0].reason, /أكثر من منصة أو سجل/);
  assert.deepEqual(ambiguousPreview.rows[0].candidateAccounts.map((account) => account.platform), ['Instagram', 'TikTok']);
  await mustCall(`/api/influencers/${ambiguous.record.id}`, {
    method: 'DELETE'
  });
  const largeWorkbook = createXlsx([
    ['Influencer ID'],
    ...Array.from({ length: 500 }, (_, index) => [`missing-${index}`])
  ]);
  const largePreview = await mustCall('/api/client-catalogs/import-preview', {
    method: 'POST',
    body: { fileName: 'large-list.xlsx', fileBase64: largeWorkbook.toString('base64'), catalogId: offer.catalog.id }
  });
  assert.equal(largePreview.counts.unmatched, 500);
  const afterPreview = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(afterPreview.prepare('SELECT COUNT(*) AS n FROM client_catalog_items WHERE catalog_id = ?').get(offer.catalog.id).n, originalItems);
  afterPreview.close();
  const added = await mustCall('/api/client-catalogs/import-confirm', {
    method: 'POST', cookie: editorCookie, body: { previewId: preview.previewId }
  });
  assert.equal(added.added, 1);
  const replay = await call('/api/client-catalogs/import-confirm', { method: 'POST', body: { previewId: preview.previewId } });
  assert.equal(replay.response.status, 410);
  const duplicateAdd = await mustCall(`/api/client-catalogs/${offer.catalog.id}/influencers`, {
    method: 'POST', body: { influencerIds: influencerIds }
  });
  assert.equal(duplicateAdd.added, 0);
  assert.equal(duplicateAdd.alreadyInOffer, 2);

  const { account } = await mustCall('/api/client-accounts', {
    method: 'POST',
    body: {
      email: 'excel@example.test', clientName: 'Excel Client', companyName: 'Excel Client',
      password: 'Excel-client-pass-2026!', clientType: 'current', catalogIds: [offer.catalog.id],
      portalConfig: {
        template: 'request-approval', status: 'published', sections: ['requestApproval'],
        fields: {
          requestApproval: ['name', 'username', 'decision'], visitSchedule: [],
          deliveryCampaign: [], campaignReport: []
        },
        actions: { allowDecisions: true, allowRevert: true, allowVisitConfirmation: false, allowVisitChangeRequest: false, allowShippingFollowUp: false }
      }
    }
  });
  assert.equal(account.username, 'excel');
  const clientCookie = await loginClient('excel@example.test', 'Excel-client-pass-2026!');
  const decisionPath = `/api/client-portal/offers/${offer.catalog.id}/targets/${influencerIds[0]}/decision`;
  await mustCall(decisionPath, { method: 'POST', cookie: clientCookie, body: { decision: 'accepted' } });
  const approved = await mustExport(`/api/client-catalogs/${offer.catalog.id}/export`, { body: { scope: 'approved' } });
  assert.equal(approved.rows.length, 1);
  assert.equal(approved.rows[0]['اسم المستخدم'], 'visit_main_username');
  const all = await mustExport(`/api/client-catalogs/${offer.catalog.id}/export`, { body: { scope: 'all' } });
  assert.equal(all.rows.length, 2);
  assert.ok(all.rows.every(row => row['Influencer ID'] && row['المنصة']));

  await mustCall(`/api/client-accounts/${account.id}`, { method: 'PATCH', body: { active: false } });
  const disabledAccount = (await mustCall('/api/client-accounts')).accounts.find(item => item.id === account.id);
  assert.equal(disabledAccount.active, false);
  assert.equal(disabledAccount.offers[0].id, offer.catalog.id);
  assert.equal(disabledAccount.decisionHistoryCount, 1);
  const revokedSession = await call('/api/client-portal/campaigns', { cookie: clientCookie });
  assert.equal(revokedSession.response.status, 401);
  await mustCall(`/api/client-accounts/${account.id}`, { method: 'PATCH', body: { active: true } });

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const audit = database.prepare(`SELECT actor_label, event_type, previous_decision, decision
    FROM client_catalog_decision_history WHERE catalog_id = ? AND influencer_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(offer.catalog.id, influencerIds[0]);
  assert.equal(audit.event_type, 'accepted');
  assert.equal(audit.previous_decision, null);
  assert.equal(audit.decision, 'accepted');
  database.close();
});

test('display modes, isolated offer decisions, and private published client visit schedules', async () => {
  const offer = await mustCall('/api/client-catalogs', {
    method: 'POST',
    body: {
      brandId: 'fkretk',
      offerName: 'Mode workflow offer', companyName: 'Mode workflow company',
      influencerIds: influencerIds
    }
  });
  const created = await mustCall('/api/client-accounts', {
    method: 'POST',
    body: {
      username: 'mode-workflow-client', email: 'mode.workflow@example.test',
      clientName: 'Mode workflow', companyName: 'Mode workflow company',
      password: 'Mode-workflow-pass-2026!', displayMode: 'prospective',
      catalogIds: [offer.catalog.id],
      portalConfig: {
        template: 'request-approval', status: 'published', sections: ['requestApproval', 'visitSchedule'],
        fields: {
          requestApproval: ['name', 'username', 'platform', 'accountLink', 'price', 'campaignNotes'],
          visitSchedule: ['name', 'visitDate'], deliveryCampaign: [], campaignReport: []
        },
        actions: { allowDecisions: false, allowRevert: false, allowVisitConfirmation: true, allowVisitChangeRequest: true, allowShippingFollowUp: true }
      }
    }
  });
  let cookie = await login('mode-workflow-client', 'Mode-workflow-pass-2026!', '/api/client-portal/login');
  let portal = await mustCall('/api/client-portal/campaigns', { cookie });
  assert.equal(portal.client.displayMode, 'prospective');
  assert.equal(portal.offers[0].decisionsEnabled, false);
  assert.equal(portal.campaigns.length, 0);
  assert.equal(portal.visits, null);
  assert.equal(portal.offers[0].influencers[0].name, 'Visit Creator');
  assert.equal(portal.offers[0].influencers[0].profiles[0].platform, 'Instagram');
  assert.equal('price' in portal.offers[0].influencers[0], false);
  assert.equal('campaignNotes' in portal.offers[0].influencers[0], false);
  assert.doesNotMatch(JSON.stringify(portal), /555123456|staff-only note|Phone Shared|رقم مشترك/);
  assert.equal((await call('/api/client-portal/visits', { cookie })).response.status, 403);
  assert.equal((await call(`/api/client-accounts/${created.account.id}/display-mode`, {
    method: 'PATCH', cookie: editorCookie, body: { displayMode: 'not-a-mode' }
  })).response.status, 400);
  assert.equal((await call(`/api/client-accounts/${created.account.id}/visits`)).response.status, 409);
  const offerDecisionPath = `/api/client-portal/offers/${offer.catalog.id}/targets/${influencerIds[0]}/decision`;
  assert.equal((await call(offerDecisionPath, { method: 'POST', cookie, body: { decision: 'accepted' } })).response.status, 403);

  let modeResult = await mustCall(`/api/client-accounts/${created.account.id}/display-mode`, {
    method: 'PATCH', cookie: editorCookie, body: { displayMode: 'selecting' }
  });
  assert.equal(modeResult.account.displayMode, 'selecting');
  await call('/api/client-portal/logout', { method: 'POST', cookie, body: {} });
  cookie = await login('mode-workflow-client', 'Mode-workflow-pass-2026!', '/api/client-portal/login');
  portal = await mustCall('/api/client-portal/campaigns', { cookie });
  assert.equal(portal.client.displayMode, 'selecting');
  assert.doesNotMatch(JSON.stringify(portal), /Phone Shared|رقم مشترك/);
  assert.equal(portal.offers[0].decisionsEnabled, true);
  assert.ok(!portal.campaigns.some(campaign => campaign.sections.includes('visitSchedule')));
  for (const [decision, expected] of [
    ['accepted', 'accepted'], ['reverted', 'pending'],
    ['rejected', 'rejected'], ['reverted', 'pending'],
    ['accepted', 'accepted']
  ]) {
    await mustCall(offerDecisionPath, { method: 'POST', cookie, body: { decision } });
    portal = await mustCall('/api/client-portal/campaigns', { cookie });
    assert.equal(portal.offers[0].influencers[0].decision, expected);
  }
  assert.equal(portal.offers[0].influencers[0].history.length, 5);

  modeResult = await mustCall(`/api/client-accounts/${created.account.id}/display-mode`, {
    method: 'PATCH', body: { displayMode: 'existing' }
  });
  assert.equal(modeResult.account.displayMode, 'existing');
  const listed = (await mustCall('/api/client-accounts')).accounts.find(item => item.id === created.account.id);
  assert.equal(listed.displayMode, 'existing');
  portal = await mustCall('/api/client-portal/campaigns', { cookie });
  assert.equal(portal.client.displayMode, 'existing');
  assert.doesNotMatch(JSON.stringify(portal), /Phone Shared|رقم مشترك/);
  assert.equal(portal.offers.length, 0);
  assert.equal(portal.campaigns.length, 0);
  assert.equal(portal.clientInfluencers.length, 2);
  assert.equal(portal.visits, null);
  assert.equal((await call(offerDecisionPath, { method: 'POST', cookie, body: { decision: 'rejected' } })).response.status, 403);
  await mustCall(`/api/client-accounts/${created.account.id}/display-mode`, {
    method: 'PATCH', body: { displayMode: 'selecting' }
  });
  portal = await mustCall('/api/client-portal/campaigns', { cookie });
  assert.equal(portal.offers[0].influencers[0].decision, 'accepted');
  assert.equal(portal.offers[0].influencers[0].history.length, 5);
  await mustCall(`/api/client-accounts/${created.account.id}/display-mode`, {
    method: 'PATCH', body: { displayMode: 'existing' }
  });
  assert.equal((await call(`/api/client-accounts/${created.account.id}/visits`, {
    method: 'POST', cookie, body: { influencerId: influencerIds[0], visitDate: '2026-10-18', visitTime: '12:00' }
  })).response.status, 401);

  const importFile = {
    fileName: 'visits.xlsx',
    fileBase64: createXlsx([
      ['Influencer Name', 'Username', 'Platform', 'Profile URL', 'Visit Date', 'Visit Time', 'City', 'Branch'],
      ['Visit Creator', 'visit_creator', 'Instagram', '', '2026-10-18', '12:30', 'Riyadh', 'North'],
      ['Visit Creator', 'visit_creator', 'Instagram', '', '2026-10-19', '13:30', 'Riyadh', 'Duplicate'],
      ['Delivery Creator', 'manual-review-needed', 'TikTok', '', '2026-10-20', '14:00', 'Jeddah', 'West']
    ]).toString('base64')
  };
  const preview = await mustCall(`/api/client-accounts/${created.account.id}/visits/import-preview`, {
    method: 'POST', cookie: editorCookie, body: importFile
  });
  assert.equal(preview.rows[0].status, 'matched');
  assert.equal(preview.rows[1].status, 'duplicate');
  assert.equal(preview.rows[2].status, 'unmatched');
  assert.ok(preview.rows[2].candidates.some(candidate => candidate.id === influencerIds[1]));
  assert.equal(preview.validRows, 1);
  assert.equal(preview.issues.duplicateRows, 1);
  assert.equal(preview.issues.unmatchedRows, 1);
  const arabicPreview = await mustCall(`/api/client-accounts/${created.account.id}/visits/import-preview`, {
    method: 'POST', cookie: editorCookie,
    body: {
      fileName: 'arabic-visits.xlsx',
      fileBase64: createXlsx([
        ['اسم المعلن', 'اسم المستخدم', 'المنصة', 'تاريخ الزيارة', 'وقت الزيارة', 'المدينة', 'الفرع'],
        ['Visit Creator', 'visit_creator', 'Instagram', '2026-10-18', '12:30', 'Riyadh', 'North'],
        ['Visit Creator', 'visit_creator', 'Instagram', '2026-02-30', '12:30', 'Riyadh', 'Invalid']
      ]).toString('base64')
    }
  });
  assert.equal(arabicPreview.rows[0].status, 'matched');
  assert.equal(arabicPreview.rows[1].status, 'invalid');
  assert.equal(arabicPreview.issues.invalidRows, 1);
  const imported = await mustCall(`/api/client-accounts/${created.account.id}/visits/import-confirm`, {
    method: 'POST', cookie: editorCookie,
    body: {
      previewToken: preview.previewToken, replaceExisting: true,
      rows: [
        { rowNumber: 2, influencerId: influencerIds[0], visitDate: '2026-10-18', visitTime: '12:30', city: 'Riyadh', branch: 'North' },
        { rowNumber: 4, influencerId: influencerIds[1], visitDate: '2026-10-20', visitTime: '14:00', city: 'Jeddah', branch: 'West' }
      ]
    }
  });
  assert.deepEqual(imported.changes, { added: 2, updated: 0, unchanged: 0, removed: 0, rejectedRows: 1 });
  const manualSearch = await mustCall(`/api/client-accounts/${created.account.id}/visits/influencer-search?q=manual_snap`, { cookie: editorCookie });
  assert.equal(manualSearch.influencers[0].id, 'c'.repeat(32));
  const manual = await mustCall(`/api/client-accounts/${created.account.id}/visits`, {
    method: 'POST', cookie: editorCookie,
    body: { influencerId: 'c'.repeat(32), visitDate: '2026-10-21', visitTime: '10:15', city: 'Dammam', branch: 'East' }
  });
  await mustCall(`/api/client-accounts/${created.account.id}/visits/${manual.id}`, {
    method: 'PATCH', cookie: editorCookie,
    body: { influencerId: 'c'.repeat(32), visitDate: '2026-10-22', visitTime: '11:45', city: 'Dammam', branch: 'Updated East' }
  });
  let internalVisits = await mustCall(`/api/client-accounts/${created.account.id}/visits`, { cookie: editorCookie });
  assert.equal(internalVisits.schedule.status, 'draft');
  assert.equal(internalVisits.visits.length, 3);
  const correctionPreview = await mustCall(`/api/client-accounts/${created.account.id}/visits/import-preview`, {
    method: 'POST', cookie: editorCookie,
    body: {
      fileName: 'corrected-visits.xlsx',
      fileBase64: createXlsx([
        ['Username', 'Platform', 'Visit Date', 'Visit Time'],
        ['visit_creator', 'Instagram', '2026-10-23', '15:00']
      ]).toString('base64')
    }
  });
  assert.equal(correctionPreview.existingSchedule, true);
  const silentOverwrite = await call(`/api/client-accounts/${created.account.id}/visits/import-confirm`, {
    method: 'POST', cookie: editorCookie,
    body: {
      previewToken: correctionPreview.previewToken, replaceExisting: false,
      rows: [{ rowNumber: 2, influencerId: influencerIds[0], visitDate: '2026-10-23', visitTime: '15:00' }]
    }
  });
  assert.equal(silentOverwrite.response.status, 409);
  assert.equal((await mustCall('/api/client-portal/visits', { cookie })).schedule, null);
  assert.equal((await call(`/api/client-accounts/${created.account.id}/visits/publish`, {
    method: 'POST', cookie: viewerCookie, body: {}
  })).response.status, 403);

  await mustCall(`/api/client-accounts/${created.account.id}/visits/publish`, { method: 'POST', cookie: editorCookie, body: {} });
  const publicSchedule = await mustCall('/api/client-portal/visits', { cookie });
  assert.equal(publicSchedule.schedule.visits.length, 3);
  assert.equal(publicSchedule.schedule.visits[0].name, 'Visit Creator');
  assert.doesNotMatch(JSON.stringify(publicSchedule), /Phone Shared|رقم مشترك/);
  assert.ok(publicSchedule.schedule.visits[0].profiles[0].profileUrl.includes('instagram.com'));
  assert.doesNotMatch(JSON.stringify(publicSchedule), /555123456|staff-only note|1000|visitNotes/);
  assert.equal(publicSchedule.schedule.visits.find(visit=>visit.name==='Manual Visit Creator').branch, 'Updated East');
  await mustCall(`/api/client-accounts/${created.account.id}/visits/unpublish`, {
    method: 'POST', cookie: editorCookie, body: {}
  });
  assert.equal((await mustCall('/api/client-portal/visits', { cookie })).schedule, null);
  await mustCall(`/api/client-accounts/${created.account.id}/visits/publish`, { method: 'POST', cookie: editorCookie, body: {} });
  assert.equal((await call('/api/client-accounts/' + created.account.id + '/visits', {
    method: 'DELETE', cookie, body: {}
  })).response.status, 401);
  const scheduleId = internalVisits.visits[0].id;
  await mustCall(`/api/client-accounts/${created.account.id}/visits/${scheduleId}`, { method: 'DELETE', cookie: editorCookie });
  assert.equal((await mustCall('/api/client-portal/visits', { cookie })).schedule, null);
  const adminInfluencer = await mustCall('/api/influencers/by-ids', {
    method: 'POST', body: { ids: [influencerIds[0]] }
  });
  assert.equal(adminInfluencer.rows[0]['Phone Shared'], 'رقم مشترك');
  const stored = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(stored.prepare('SELECT status FROM client_visit_schedules WHERE client_account_id = ?').get(created.account.id).status, 'draft');
  assert.equal(stored.prepare('SELECT COUNT(*) AS count FROM client_catalog_decision_history WHERE catalog_id = ? AND influencer_id = ?')
    .get(offer.catalog.id, influencerIds[0]).count, 5);
  stored.close();
  await mustCall(`/api/client-accounts/${clientTwo.id}/display-mode`, { method: 'PATCH', body: { displayMode: 'existing' } });
  const otherClientCookie = await login('client-two', 'Client-two-new-pass-2026!', '/api/client-portal/login');
  assert.equal((await mustCall('/api/client-portal/visits', { cookie: otherClientCookie })).schedule, null);
});

test('client showcase is account-scoped, paginated, sanitized, and persists shortlist feedback', async () => {
  assert.equal((await call('/api/client-portal/showcases', { cookie: '' })).response.status, 401);
  const created = await mustCall('/api/client-accounts', {
    method: 'POST',
    body: {
      username: 'showcase-client', email: 'showcase@example.test', clientName: 'Showcase Client',
      companyName: 'Showcase Company', password: 'Showcase-client-pass-2026!',
      portalConfig: {
        template: 'request-approval', status: 'published', sections: ['requestApproval'],
        fields: { requestApproval: ['name', 'username', 'platform', 'followers'], visitSchedule: [], deliveryCampaign: [], campaignReport: [] },
        actions: { allowDecisions: false, allowRevert: false, allowVisitConfirmation: false, allowVisitChangeRequest: false, allowShippingFollowUp: false }
      }
    }
  });
  const assigned = await mustCall('/api/client-catalogs', {
    method: 'POST', body: { brandId: 'fkretk', clientName: 'Showcase Client', companyName: 'Showcase Company', offerName: 'Wellness shortlist', influencerIds: [influencerIds[0], influencerIds[1]] }
  });
  assert.deepEqual((await mustCall(`/api/client-catalogs/${assigned.catalog.id}/influencers`)).influencerIds, [influencerIds[0], influencerIds[1]]);
  assert.equal((await call(`/api/client-catalogs/${assigned.catalog.id}/influencers`, { cookie: viewerCookie })).response.status, 403);
  const unassigned = await mustCall('/api/client-catalogs', {
    method: 'POST', body: { brandId: 'fkretk', clientName: 'Other Client', companyName: 'Other Company', offerName: 'Private shortlist', influencerIds: [influencerIds[1]] }
  });
  const multiAccount = await mustCall('/api/influencers', {
    method: 'POST',
    body: {
      Name: 'Multi-account creator',
      Main_Username: 'independent_handle',
      'Username I': 'micro_handle',
      'Followers Count I': '50K',
      'Username T': 'mega_handle',
      'Followers Count T': '1M'
    }
  });
  const neutralAvatar = await fetch(`${baseUrl}/profile-images/${multiAccount.record.id}`);
  const expectedNeutralAvatar = await fetch(`${baseUrl}/assets/avatars/neutral.svg`);
  assert.equal(neutralAvatar.status, 200);
  assert.equal(await neutralAvatar.text(), await expectedNeutralAvatar.text());
  const iconHelper = await fetch(`${baseUrl}/assets/icons.js`);
  const iconSprite = await fetch(`${baseUrl}/assets/icons/sprite.svg`);
  assert.equal(iconHelper.status, 200);
  assert.match(iconHelper.headers.get('content-type'), /javascript/);
  assert.equal(iconSprite.status, 200);
  assert.match(iconSprite.headers.get('content-type'), /image\/svg\+xml/);
  const preview = await mustCall(`/api/client-catalogs/${assigned.catalog.id}/showcase-preview`);
  assert.equal(preview.items.length, 2);
  assert.equal(JSON.stringify(preview.items).includes('555123456'), false);
  assert.equal((await call(`/api/client-catalogs/${assigned.catalog.id}/showcase-preview`, { cookie: viewerCookie })).response.status, 403);
  await mustCall(`/api/client-accounts/${created.account.id}`, {
    method: 'PATCH', body: { catalogIds: [assigned.catalog.id] }
  });
  const cookie = await loginClient('showcase@example.test', 'Showcase-client-pass-2026!');
  const lists = await mustCall('/api/client-portal/showcases', { cookie });
  assert.deepEqual(lists.lists.map(list => list.id), [assigned.catalog.id]);
  assert.equal((await call(`/api/client-portal/showcases/${unassigned.catalog.id}`, { cookie })).response.status, 404);

  await mustCall(`/api/client-catalogs/${assigned.catalog.id}`, {
    method: 'PATCH', body: { influencerIds: [influencerIds[1], influencerIds[0], multiAccount.record.id] }
  });
  const ordered = await mustCall(`/api/client-portal/showcases/${assigned.catalog.id}`, { cookie });
  assert.deepEqual(ordered.items.map(item => item.id), [influencerIds[1], influencerIds[0], multiAccount.record.id]);

  const result = await mustCall(`/api/client-portal/showcases/${assigned.catalog.id}?category=Health&city=Riyadh&pageSize=1`, { cookie });
  const showcasePage = await fetch(`${baseUrl}/showcase`);
  const showcaseHtml = await showcasePage.text();
  const showcaseScript = await fetch(`${baseUrl}/assets/showcase.js`).then(response => response.text());
  assert.equal(showcaseHtml.includes('tier-filter'), false);
  assert.equal(showcaseHtml.includes('data-i18n="tier"'), false);
  assert.equal(showcaseScript.includes('social-tier'), true);
  assert.equal(showcaseScript.includes('tierLabel'), false);
  assert.equal(result.total, 1);
  assert.equal(result.list.total, 3);
  assert.equal(result.items[0].name, 'Visit Creator');
  assert.equal(result.items[0].mainUsername, 'visit_main_username');
  assert.deepEqual(result.items[0].categories, ['Health', 'Beauty']);
  assert.equal(result.items[0].verified, true);
  assert.equal(result.items[0].mawthouq, true);
  assert.equal('tier' in result.items[0].socialAccounts[0], false);
  assert.equal(JSON.stringify(result.items[0]).includes('Influencer Type'), false);
  const microTierResults = await mustCall(`/api/client-portal/showcases/${assigned.catalog.id}?tier=Micro&pageSize=50`, { cookie });
  assert.equal(microTierResults.total, 3);
  assert.equal((await mustCall(`/api/client-portal/showcases/${assigned.catalog.id}?tier=Micro&platform=Instagram&pageSize=50`, { cookie })).total, 2);
  assert.equal((await mustCall(`/api/client-portal/showcases/${assigned.catalog.id}?tier=Micro&platform=TikTok&pageSize=50`, { cookie })).total, 1);
  const multiAccountItem = microTierResults.items.find(item => item.id === multiAccount.record.id);
  assert.ok(multiAccountItem.socialAccounts.some(account => account.platform === 'Instagram'));
  assert.ok(multiAccountItem.socialAccounts.some(account => account.platform === 'TikTok'));
  assert.equal(JSON.stringify(microTierResults.items).includes('"tier"'), false);
  const publicFields = JSON.stringify(result.items[0]);
  for (const sensitive of ['555123456', 'staff-only note', 'confidential staff note', '1000', 'Paid', 'Phone Shared', 'رقم مشترك']) {
    assert.equal(publicFields.includes(sensitive), false);
  }

  const comment = 'يفضل محتوى العناية بالبشرة للحملة القادمة.';
  await mustCall(`/api/client-portal/showcases/${assigned.catalog.id}/feedback/${influencerIds[0]}`, {
    method: 'PUT', cookie, body: { favorite: true, comment }
  });
  const shortlist = await mustCall(`/api/client-portal/showcases/${assigned.catalog.id}?favorites=1`, { cookie });
  assert.equal(shortlist.total, 1);
  assert.equal(shortlist.items[0].favorite, true);
  assert.equal(shortlist.items[0].comment, comment);
  const workspace = await mustCall(`/api/client-accounts/${created.account.id}/workspace`);
  assert.ok(workspace.activity.some(entry => entry.eventType === 'showcase_feedback_updated' && entry.details.comment === comment));
});

test('campaign briefs support independent CRUD, long mixed-language content, deletion retention, and role checks', async () => {
  const endpoint = `/api/campaigns/${visitCampaign.id}/briefs`;
  const initial = await mustCall(endpoint);
  assert.ok(initial.briefs.length >= 1);
  const created = await mustCall(endpoint, { method: 'POST', body: { advertiserName: 'Advertiser Alpha' } });
  const script = `${'تفاصيل الحملة '.repeat(400)} Hook, CTA, UGC`;
  const content = { script, visitCity: 'جدة', visitAddress: 'فرع حي طيبة — شارع المثال', googleMapsLink: 'https://maps.example.test/visit' };
  await mustCall(`${endpoint}/${created.brief.id}`, { method: 'PATCH', body: { content } });
  const repeated = await mustCall(endpoint);
  assert.equal(repeated.briefs.find(item => item.id === created.brief.id).content.script, script);
  const fullBrief = `${'بريف شامل '.repeat(1200)} English talking points`;
  await mustCall(`${endpoint}/${created.brief.id}`, {
    method: 'PATCH', body: { advertiserName: 'بريف الرياض', content: { body: fullBrief } }
  });
  const savedFullBrief = (await mustCall(endpoint)).briefs.find(item => item.id === created.brief.id);
  assert.equal(savedFullBrief.advertiserName, 'بريف الرياض');
  assert.equal(savedFullBrief.content.body, fullBrief);
  assert.equal(savedFullBrief.content.script, script);
  const second = await mustCall(endpoint, { method: 'POST', body: { advertiserName: 'Advertiser Beta' } });
  assert.notEqual(second.brief.id, created.brief.id);
  const third = await mustCall(endpoint, { method: 'POST', body: { advertiserName: 'Advertiser Gamma' } });
  assert.notEqual(third.brief.id, second.brief.id);
  for (let index = 3; index < 10; index += 1) await mustCall(endpoint, { method: 'POST', body: { advertiserName: `Advertiser ${index + 1}` } });
  assert.equal((await mustCall(endpoint)).briefs.length, initial.briefs.length + 10);
  const repeatedLinkedBrief = await mustCall(endpoint, { method: 'POST', body: { clientAccountId: clientOne.id } });
  const anotherLinkedBrief = await mustCall(endpoint, { method: 'POST', body: { clientAccountId: clientOne.id, advertiserName: 'Linked second brief' } });
  assert.notEqual(repeatedLinkedBrief.brief.id, anotherLinkedBrief.brief.id);
  const viewerForbidden = await call(endpoint, { cookie: viewerCookie });
  assert.equal(viewerForbidden.response.status, 403);
  await mustCall(`${endpoint}/${created.brief.id}`, { method: 'DELETE' });
  assert.equal((await mustCall(endpoint)).briefs.some(item => item.id === created.brief.id), false);
  const savedDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const archived = savedDatabase.prepare('SELECT archived, content_json AS contentJson FROM campaign_briefs WHERE id = ?').get(created.brief.id);
  assert.equal(archived.archived, 1);
  assert.equal(JSON.parse(archived.contentJson).script, script);
  savedDatabase.close();
});

test('visit Location, Address, Branch, and City stay distinct when campaigns are created or edited', async () => {
  async function createVisit(name, fields) {
    return (await mustCall('/api/campaigns', { method: 'POST', body: {
      campaignName: name, companyName: 'Visit field QA', campaignType: 'visit', serviceType: 'influencer', ...period,
      targets: [{ id: influencerIds[0], visitDate: period.startDate, ...fields }]
    } })).campaign;
  }
  const locationOnly = await createVisit('Location only QA', { visitLocation: 'Location only value' });
  const addressOnly = await createVisit('Address only QA', { visitAddress: 'Address only value' });
  const branchOnly = await createVisit('Branch only QA', { visitCity: 'Jeddah', visitBranch: 'Branch only value' });
  const distinct = await createVisit('Distinct visit fields QA', {
    visitCity: 'Jeddah', visitLocation: 'Legacy location value',
    visitAddress: 'Visit address value', visitBranch: 'Branch value'
  });
  const read = campaign => campaign.targets[0];
  assert.equal(read(locationOnly).visitLocation, 'Location only value');
  assert.equal(read(locationOnly).visitAddress, '');
  assert.equal(read(addressOnly).visitLocation, '');
  assert.equal(read(addressOnly).visitAddress, 'Address only value');
  assert.equal(read(branchOnly).visitCity, 'Jeddah');
  assert.equal(read(branchOnly).visitBranch, 'Branch only value');
  assert.equal(read(distinct).visitLocation, 'Legacy location value');
  assert.equal(read(distinct).visitAddress, 'Visit address value');
  assert.equal(read(distinct).visitBranch, 'Branch value');
  await mustCall(`/api/campaigns/${distinct.id}`, { method: 'PATCH', body: {
    campaignName: distinct.campaignName, companyName: distinct.companyName, campaignType: 'visit',
    serviceType: distinct.serviceType, startDate: distinct.startDate, endDate: distinct.endDate,
    targets: [{ id: influencerIds[0], visitDate: period.startDate, visitCity: 'Jeddah',
      visitLocation: 'Legacy location value', visitAddress: 'Updated visit address', visitBranch: 'Branch value' }]
  } });
  const stored = new DatabaseSync(databasePath, { readOnly: true });
  const values = stored.prepare('SELECT visit_city AS city, visit_location AS location, visit_address AS address, visit_branch AS branch FROM campaign_targets WHERE campaign_id = ?').get(distinct.id);
  assert.deepEqual({ ...values }, { city: 'Jeddah', location: 'Legacy location value', address: 'Updated visit address', branch: 'Branch value' });
  stored.close();
});

test('a newly linked advertiser gets one brief and unlinking it leaves that brief attached to its original identity', async () => {
  const account = (await mustCall('/api/client-accounts', { method: 'POST', body: {
    username: 'brief-link-review', email: 'brief-link-review@example.test', clientName: 'Brief Link Review',
    companyName: 'Brief Link Advertiser', password: 'Brief-link-password-2026!', campaignIds: [visitCampaign.id]
  } })).account;
  const endpoint = `/api/campaigns/${visitCampaign.id}/briefs`;
  const firstRead = (await mustCall(endpoint)).briefs;
  const seeded = firstRead.filter(brief => brief.clientAccountId === account.id);
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].advertiserName, account.companyName);
  await mustCall(`/api/client-accounts/${account.id}`, { method: 'PATCH', body: { campaignIds: [] } });
  const afterUnlink = (await mustCall(endpoint)).briefs;
  assert.equal(afterUnlink.filter(brief => brief.clientAccountId === account.id).length, 1);
  assert.equal(afterUnlink.find(brief => brief.id === seeded[0].id).advertiserName, account.companyName);
});

test('After Confirmation saves per influencer and remains private from viewers and the client portal', async () => {
  const summarizedVisit = (await mustCall('/api/campaigns')).campaigns.find(item => item.id === visitCampaign.id).targets[0];
  const influencerDatabase = new DatabaseSync(databasePath, { readOnly: true });
  const influencerRecord = JSON.parse(influencerDatabase.prepare('SELECT record_json FROM influencers WHERE id = ?').get(summarizedVisit.id).record_json);
  influencerDatabase.close();
  const platform = String(influencerRecord['Best Platform'] || '');
  const followerField = platform.toLowerCase().includes('tik') ? 'Followers Count T' : platform.toLowerCase().includes('snap') ? 'Followers Count S' : 'Followers Count I';
  assert.equal(summarizedVisit.platform, platform);
  assert.equal(summarizedVisit.followers, String(influencerRecord[followerField] || ''));
  assert.equal(summarizedVisit.influencerCity, String(influencerRecord.City || ''));
  const campaign = (await mustCall('/api/campaigns', { method: 'POST', body: {
    campaignName: 'Independent confirmation QA', companyName: 'Confirm QA', campaignType: 'mix', serviceType: 'influencer', ...period,
    targets: [
      { id: influencerIds[0], executionType: 'visit', visitDate: period.startDate },
      { id: influencerIds[1], executionType: 'delivery', recipientName: 'QA Recipient', recipientPhone: '5551234567' }
    ]
  } })).campaign;
  const firstText = 'تعليمات المؤثر الأول — Hook';
  const secondText = 'Instructions for creator two — CTA';
  await mustCall(`/api/campaigns/${campaign.id}/targets/${influencerIds[0]}`, { method: 'PATCH', body: { afterConfirmation: firstText } });
  await mustCall(`/api/campaigns/${campaign.id}/targets/${influencerIds[1]}`, { method: 'PATCH', cookie: editorCookie, body: { afterConfirmation: secondText } });
  const targets = (await mustCall('/api/campaigns')).campaigns.find(item => item.id === campaign.id).targets;
  assert.equal(targets.find(item => item.id === influencerIds[0]).afterConfirmation, firstText);
  assert.equal(targets.find(item => item.id === influencerIds[1]).afterConfirmation, secondText);
  const viewerTargets = (await mustCall('/api/campaigns', { cookie: viewerCookie })).campaigns.find(item => item.id === campaign.id).targets;
  assert.equal(viewerTargets[0].afterConfirmation, '');
  const denied = await call(`/api/campaigns/${campaign.id}/targets/${influencerIds[0]}`, { cookie: viewerCookie, method: 'PATCH', body: { afterConfirmation: 'unauthorized' } });
  assert.equal(denied.response.status, 403);
  const portal = await mustCall('/api/client-portal/campaigns', { cookie: clientOneCookie });
  assert.equal(JSON.stringify(portal).includes(firstText), false);
});

test('Advertiser Notes are campaign-scoped, retained with advertiser identity, and excluded from client views', async () => {
  const account = (await mustCall('/api/client-accounts', { method: 'POST', body: {
    username: 'advertiser-note-review', email: 'advertiser-note-review@example.test', clientName: 'Notes QA',
    companyName: 'Notes Advertiser', password: 'Advertiser-note-password-2026!', campaignIds: [visitCampaign.id]
  } })).account;
  const endpoint = `/api/campaigns/${visitCampaign.id}/advertiser-notes`;
  const privateText = 'Internal advertiser note — campaign specific';
  const saved = await mustCall(endpoint, { method: 'POST', body: { clientAccountId: account.id, noteText: privateText } });
  assert.equal(saved.note.clientAccountId, account.id);
  assert.equal((await mustCall(endpoint)).notes.find(note => note.id === saved.note.id).noteText, privateText);
  await mustCall(`/api/campaigns/${visitCampaign.id}/advertiser-notes/${saved.note.id}`, { method: 'PATCH', cookie: editorCookie, body: { noteText: `${privateText} updated` } });
  assert.equal((await mustCall(`/api/campaigns/${deliveryCampaign.id}/advertiser-notes`)).notes.some(note => note.noteText.includes(privateText)), false);
  await mustCall(`/api/client-accounts/${account.id}`, { method: 'PATCH', body: { campaignIds: [] } });
  const retained = (await mustCall(endpoint)).notes.find(note => note.id === saved.note.id);
  assert.equal(retained.advertiserName, account.companyName);
  assert.equal(retained.linked, false);
  const viewer = await call(endpoint, { cookie: viewerCookie });
  assert.equal(viewer.response.status, 403);
  const portal = await mustCall('/api/client-portal/campaigns', { cookie: clientOneCookie });
  assert.equal(JSON.stringify(portal).includes(privateText), false);
});

test('CSV and Excel imports preserve record ownership and reject account-based identity conflicts', async () => {
  const baseline = new DatabaseSync(databasePath, { readOnly: true });
  const initialCount = baseline.prepare('SELECT COUNT(*) AS count FROM influencers').get().count;
  baseline.close();
  const phoneConflict = await mustCall('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic Phone Conflict', Full_Mobile_Number: '+966555010202'
  } });
  await mustCall('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic Account Conflict', 'Username I': 'qa_conflict_existing'
  } });
  const xlsx = createXlsx([
    ['Name', 'Main_Username', 'Username I', 'Followers Count I', 'Country', 'City', 'Full_Mobile_Number', 'Import Source Column'],
    ['', '', '', '', '', '', '', ''],
    ['Synthetic Import Creator', 'qa_dedupealpha', '@ Qa_DedupeAlpha ', '10000', 'Saudi Arabia', 'Riyadh', '+966555010101', 'source-retained']
  ]);
  const firstImport = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: {
    fileName: 'synthetic-import.xlsx', fileBase64: xlsx.toString('base64')
  } });
  assert.deepEqual(
    { created: firstImport.created, updated: firstImport.updated, unchanged: firstImport.unchanged, failed: firstImport.failed },
    { created: 1, updated: 0, unchanged: 0, failed: 0 }
  );
  const repeatedFileImport = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: {
    fileName: 'synthetic-import.xlsx', fileBase64: xlsx.toString('base64')
  } });
  assert.deepEqual(
    { created: repeatedFileImport.created, updated: repeatedFileImport.updated, unchanged: repeatedFileImport.unchanged, failed: repeatedFileImport.failed },
    { created: 0, updated: 0, unchanged: 1, failed: 0 }
  );
  const importedDb = new DatabaseSync(databasePath, { readOnly: true });
  const importedRecord = importedDb.prepare('SELECT id, record_json FROM influencers')
    .all().map(row => ({ id: row.id, record: JSON.parse(row.record_json) }))
    .find(item => item.record.Name === 'Synthetic Import Creator');
  importedDb.close();
  assert.ok(importedRecord);
  const linkedCampaign = await mustCall('/api/campaigns', { method: 'POST', cookie: editorCookie, body: {
    campaignName: 'Synthetic Import Relationship',
    companyName: 'Synthetic Advertiser',
    campaignType: 'visit',
    serviceType: 'influencer',
    startDate: '2026-11-02',
    endDate: '2026-11-04',
    targets: [{ id: importedRecord.id, visitDate: '2026-11-03' }]
  } });
  const rows = [
    { id: importedRecord.id, 'Username I': 'qa_dedupealpha', Name: 'Updated Synthetic Import Creator', 'Followers Count I': '26000', Country: '', City: '', Full_Mobile_Number: '', 'Import Source Column': '' },
    { 'Username T': '@QA_DedupeAlpha', Main_Username: 'qa_dedupealpha', 'Followers Count T': '12000', Name: 'Synthetic TikTok Account' },
    { 'Username I': 'qa_conflict_existing', 'Followers Count I': '30000', Full_Mobile_Number: '+966555010202' },
    { 'Username I': 'qa_invalid_follower', 'Followers Count I': 'not-a-count' }
  ];
  const secondImport = await mustCall('/api/import', {
    method: 'POST', cookie: adminCookie, body: { rows, allowSensitiveChanges: true }
  });
  assert.deepEqual(
    { created: secondImport.created, updated: secondImport.updated, unchanged: secondImport.unchanged, failed: secondImport.failed },
    { created: 2, updated: 2, unchanged: 0, failed: 0 },
    JSON.stringify({ issues: secondImport.issues, warnings: secondImport.warnings })
  );
  assert.deepEqual(secondImport.issues, []);
  assert.deepEqual(secondImport.warnings.map(({ row, reason }) => ({ row, reason })), [
    { row: 4, reason: 'invalid-follower-count' }
  ]);
  const resultDb = new DatabaseSync(databasePath, { readOnly: true });
  const matchingRecords = resultDb.prepare('SELECT id, record_json FROM influencers').all()
    .map(row => ({ id: row.id, record: JSON.parse(row.record_json) }))
    .filter(item => item.record['Username I'] && item.record['Username I'].replace(/^@/, '').replace(/\s/g, '').toLowerCase() === 'qa_dedupealpha'
      || item.record['Username T'] && item.record['Username T'].replace(/^@/, '').replace(/\s/g, '').toLowerCase() === 'qa_dedupealpha');
  assert.equal(matchingRecords.length, 2);
  const importedInstagram = matchingRecords.find(item => item.record['Username I']);
  const importedTikTok = matchingRecords.find(item => item.record['Username T']);
  assert.equal(importedInstagram.id, importedRecord.id);
  assert.equal(importedInstagram.record.Name, 'Updated Synthetic Import Creator');
  assert.equal(importedInstagram.record['Followers Count I'], '26000');
  assert.equal(importedInstagram.record.Country, 'Saudi Arabia');
  assert.equal(importedInstagram.record.City, 'Riyadh');
  assert.equal(importedInstagram.record.Full_Mobile_Number, '+966555010101');
  assert.equal(importedInstagram.record['Import Source Column'], 'source-retained');
  assert.equal(importedTikTok.record['Followers Count T'], '12000');
  const sharedPhoneRecord = resultDb.prepare(`SELECT record_json FROM influencers
    WHERE json_extract(record_json, '$."Username I"') = 'qa_conflict_existing'`).get();
  assert.equal(JSON.parse(sharedPhoneRecord.record_json)['Phone Shared'], 'رقم مشترك');
  const invalidFollowerRecord = resultDb.prepare(`SELECT record_json FROM influencers
    WHERE json_extract(record_json, '$."Username I"') = 'qa_invalid_follower'`).get();
  assert.equal(JSON.parse(invalidFollowerRecord.record_json)['Followers Count I'], '');
  assert.equal(resultDb.prepare(`SELECT COUNT(*) AS count FROM influencer_follower_history
    WHERE influencer_id = ? AND platform = 'Instagram' AND followers_count = 26000 AND previous_count = 10000 AND source = 'import'`)
    .get(importedRecord.id).count, 1);
  assert.equal(resultDb.prepare('SELECT COUNT(*) AS count FROM campaign_targets WHERE influencer_id = ?')
    .get(importedRecord.id).count, 1);
  assert.equal(resultDb.prepare('SELECT influencer_id FROM campaign_targets WHERE campaign_id = ? AND influencer_id = ?')
    .get(linkedCampaign.campaign.id, importedRecord.id).influencer_id, importedRecord.id);
  assert.equal(resultDb.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, initialCount + 5);
  resultDb.close();

  const phoneOnlyMatch = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: {
    rows: [{ Name: 'Must not match by phone', 'Username I': 'qa_phone_only_identity', Full_Mobile_Number: '+966555010202' }]
  } });
  assert.deepEqual(
    { created: phoneOnlyMatch.created, updated: phoneOnlyMatch.updated, failed: phoneOnlyMatch.failed },
    { created: 1, updated: 0, failed: 0 }
  );
  assert.equal(phoneOnlyMatch.matchedByPhone, 0);
  assert.equal(phoneOnlyMatch.sharedPhones, 1);
  const phoneFirstDb = new DatabaseSync(databasePath, { readOnly: true });
  const phoneFirstRecord = JSON.parse(phoneFirstDb.prepare('SELECT record_json FROM influencers WHERE id = ?')
    .get(phoneConflict.record.id).record_json);
  const phoneOnlyCreated = JSON.parse(phoneFirstDb.prepare(`SELECT record_json FROM influencers
    WHERE json_extract(record_json, '$."Username I"') = 'qa_phone_only_identity'`).get().record_json);
  phoneFirstDb.close();
  assert.equal(phoneFirstRecord['Username I'] || '', '');
  assert.equal(phoneOnlyCreated['Phone Shared'], 'رقم مشترك');

  const accountChangeFixture = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: {
    rows: [{
      Name: 'Synthetic Account Change',
      'Username I': 'qa_account_change_before',
      'Username T': 'qa_account_change_match'
    }]
  } });
  assert.equal(accountChangeFixture.created, 1);
  const accountChangeDb = new DatabaseSync(databasePath, { readOnly: true });
  const accountChangeRecord = accountChangeDb.prepare(
    "SELECT id, record_json FROM influencers WHERE json_extract(record_json, '$.Username T') = 'qa_account_change_match'"
  ).get();
  accountChangeDb.close();
  assert.ok(accountChangeRecord);
  const changedAccountImport = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: {
    rows: [{
      'Username T': 'qa_account_change_match',
      'Username I': 'qa_account_change_after'
    }]
  } });
  assert.deepEqual(
    { created: changedAccountImport.created, updated: changedAccountImport.updated, failed: changedAccountImport.failed },
    { created: 0, updated: 0, failed: 1 }
  );
  assert.equal(changedAccountImport.issues[0].reason, 'account-match-needs-review');
  const changedAccountDb = new DatabaseSync(databasePath, { readOnly: true });
  const changedAccountRecord = JSON.parse(changedAccountDb.prepare('SELECT record_json FROM influencers WHERE id = ?')
    .get(accountChangeRecord.id).record_json);
  changedAccountDb.close();
  assert.equal(changedAccountRecord['Username I'], 'qa_account_change_before');

  const duplicateNames = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: {
    rows: [
      { Name: 'Same Name Different Account', 'Username I': 'qa_same_name_one' },
      { Name: 'Same Name Different Account', 'Username I': 'qa_same_name_two' }
    ]
  } });
  assert.deepEqual(
    { created: duplicateNames.created, failed: duplicateNames.failed },
    { created: 2, failed: 0 }
  );

  const rollbackBaseline = new DatabaseSync(databasePath, { readOnly: true });
  const rollbackCount = rollbackBaseline.prepare('SELECT COUNT(*) AS count FROM influencers').get().count;
  rollbackBaseline.close();
  const triggerDb = new DatabaseSync(databasePath);
  triggerDb.exec(`CREATE TRIGGER fail_import_fixture BEFORE INSERT ON influencers
    WHEN NEW.record_json LIKE '%Rollback Failure%'
    BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
  triggerDb.close();
  const failedMidImport = await call('/api/import', { method: 'POST', cookie: adminCookie, body: {
    rows: [
      { Name: 'Rollback First Row', 'Username I': 'qa_rollback_first' },
      { Name: 'Rollback Failure', 'Username I': 'qa_rollback_failure' }
    ]
  } });
  const removeTrigger = new DatabaseSync(databasePath);
  removeTrigger.exec('DROP TRIGGER fail_import_fixture');
  removeTrigger.close();
  assert.equal(failedMidImport.response.status, 500);
  const rollbackAfter = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(rollbackAfter.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, rollbackCount);
  assert.equal(rollbackAfter.prepare("SELECT COUNT(*) AS count FROM influencers WHERE json_extract(record_json, '$.Name') = 'Rollback First Row'").get().count, 0);
  rollbackAfter.close();

  const differentOwner = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: {
    rows: [{ Name: 'Different Synthetic Owner', 'Username I': 'qa_dedupealpha' }]
  } });
  assert.equal(differentOwner.created, 0);
  assert.equal(differentOwner.failed, 0);
  assert.equal(differentOwner.updated, 1);

  const parallelImports = await Promise.all(['Parallel Update One', 'Parallel Update Two'].map(Name =>
    mustCall('/api/import', { method: 'POST', cookie: adminCookie, body: {
      allowSensitiveChanges: true,
      rows: [{ id: importedRecord.id, Name, 'Username I': 'qa_dedupealpha' }]
    } })));
  assert.ok(parallelImports.every(result => result.updated === 1 && result.failed === 0));
  const afterParallel = new DatabaseSync(databasePath, { readOnly: true });
  const parallelRecord = JSON.parse(afterParallel.prepare('SELECT record_json FROM influencers WHERE id = ?')
    .get(importedRecord.id).record_json);
  assert.ok(['Parallel Update One', 'Parallel Update Two'].includes(parallelRecord.Name));
  assert.equal(parallelRecord['Username I'], 'qa_dedupealpha');
  afterParallel.close();

  const sparseWorkbook = createXlsx([
    ['Name', 'Username I', 'Followers Count I', 'Username T', 'Username', 'Followers Count S'],
    ['', '', '', '', '', ''],
    ['Conflicting Sparse Row', 'qa_dedupealpha', '12000', 'qa_dedupealpha', '12000', ''],
    ['Valid Sparse Row', 'sparse_valid_ig', '15000', 'sparse_valid_tt', 'sparse_valid_snap', '9000']
  ]);
  const sparsePreview = await mustCall('/api/import/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'synthetic-sparse-import.xlsx', fileBase64: sparseWorkbook.toString('base64') }
  });
  assert.deepEqual(
    {
      total: sparsePreview.preview.integrity.total,
      valid: sparsePreview.preview.integrity.valid,
      conflicts: sparsePreview.preview.integrity.conflicts,
      issueRow: sparsePreview.preview.integrity.issues[0]?.row
    },
    { total: 2, valid: 1, conflicts: 1, issueRow: 3 }
  );
  const sparseRows = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: {
    fileName: 'synthetic-sparse-import.xlsx',
    fileBase64: sparseWorkbook.toString('base64')
  } });
  assert.deepEqual(
    { created: sparseRows.created, failed: sparseRows.failed },
    { created: 1, failed: 1 }
  );
  assert.equal(sparseRows.issues[0].row, 3);
  const sparseRecord = new DatabaseSync(databasePath, { readOnly: true });
  const validSparseRecord = sparseRecord.prepare('SELECT record_json FROM influencers')
    .all().map(row => JSON.parse(row.record_json)).find(record => record.Name === 'Valid Sparse Row');
  assert.deepEqual(
    [validSparseRecord?.['Username I'], validSparseRecord?.['Username T'], validSparseRecord?.Username],
    ['sparse_valid_ig', 'sparse_valid_tt', 'sparse_valid_snap']
  );
  sparseRecord.close();
  const platformOwnerConflicts = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: {
    rows: [
      { Name: 'Wrong TikTok Owner', 'Username T': 'qa_dedupealpha', Username: 'sparse_valid_snap' },
      { Name: 'Wrong Instagram Owner', 'Username I': 'qa_dedupealpha', Username: 'sparse_valid_snap' }
    ]
  } });
  assert.equal(platformOwnerConflicts.failed, 2);
  assert.deepEqual(platformOwnerConflicts.issues.map(issue => issue.reason), [
    'duplicate-account-in-file', 'duplicate-account-in-file'
  ]);

  const viewerImport = await call('/api/import', { method: 'POST', cookie: viewerCookie, body: { rows: [] } });
  assert.equal(viewerImport.response.status, 403);
  const unauthenticatedImport = await call('/api/import', { method: 'POST', cookie: '', body: { rows: [] } });
  assert.equal(unauthenticatedImport.response.status, 401);
  assert.equal(phoneConflict.record.Name, 'Synthetic Phone Conflict');
});

test('manual influencer creation names the owner when a normalized account is already assigned', async () => {
  const owner = await mustCall('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic account owner',
    'Username I': 'qa_manual_account_owner',
    Full_Mobile_Number: '+966555700201'
  } });
  assert.equal(owner.record['Username I'], 'qa_manual_account_owner');
  const conflict = await call('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic duplicate', 'Username I': ' @ Qa_Manual_Account_Owner '
  } });
  assert.equal(conflict.response.status, 409);
  assert.deepEqual(conflict.body.conflict.influencerIds, [owner.record.id]);
  assert.deepEqual(conflict.body.conflict.influencerNames, ['Synthetic account owner']);
  assert.match(conflict.body.error, /Synthetic account owner/);
  const phoneConflict = await call('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic duplicate phone', 'Username T': 'qa_manual_phone_duplicate',
    Full_Mobile_Number: '+966555700201'
  } });
  assert.equal(phoneConflict.response.status, 201);
  assert.equal(phoneConflict.body.record['Phone Shared'], 'رقم مشترك');
  assert.equal(phoneConflict.body.record['Username T'], 'qa_manual_phone_duplicate');
});

test('social usernames remove every Unicode format character on create, update, and import', async () => {
  const formatCharacters = [
    '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u2060', '\ufeff', '\u00ad',
    '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u061c'
  ];
  const cases = formatCharacters.flatMap((character, characterIndex) => [0, 1].map((position) => {
    const base = `qa_unicode_owner_${characterIndex}_${position}`;
    const raw = position === 0
      ? `${base.slice(0, 8)}${character}${base.slice(8)}`
      : `${character}${base}${character}`;
    return { base, raw, character, position, ownerName: `Synthetic Unicode Owner ${characterIndex} ${position}` };
  }));
  const createdOwners = [];

  for (const item of cases) {
    const owner = await mustCall('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
      Name: item.ownerName, 'Username I': item.raw, 'Username T': item.raw
    } });
    assert.equal(owner.record['Username I'], item.base);
    assert.equal(owner.record['Username T'], item.base);
    createdOwners.push(owner.record);
    const duplicate = await call('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
      Name: 'Synthetic Unicode Duplicate', 'Username T': item.raw
    } });
    assert.equal(duplicate.response.status, 409);
    assert.deepEqual(duplicate.body.conflict.influencerIds, [owner.record.id]);
    const instagramDuplicate = await call('/api/influencers', {
      method: 'POST', cookie: editorCookie, body: {
        Name: 'Synthetic Instagram Duplicate', 'Username I': ` @ ${item.base.toUpperCase()} `
      }
    });
    assert.equal(instagramDuplicate.response.status, 409);
    assert.deepEqual(instagramDuplicate.body.conflict.influencerIds, [owner.record.id]);
  }

  const crossPlatform = await mustCall('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic cross-platform owner', Username: cases[0].base
  } });
  assert.equal(crossPlatform.record.Username, cases[0].base);

  let updateTarget = await mustCall('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic Unicode Update Target', 'Username T': 'qa_unicode_update_initial'
  } });
  for (const [index, item] of cases.entries()) {
    const updateBase = `qa_unicode_updated_${index}`;
    const updateRaw = item.position === 0
      ? `${updateBase.slice(0, 8)}${item.character}${updateBase.slice(8)}`
      : `${item.character}${updateBase}${item.character}`;
    const changed = await call(`/api/influencers/${updateTarget.record.id}`, {
      method: 'PUT', cookie: editorCookie, body: { ...updateTarget.record, 'Username T': updateRaw }
    });
    assert.equal(changed.response.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.record['Username T'], updateBase);
    updateTarget = changed.body;

    const conflict = await call(`/api/influencers/${updateTarget.record.id}`, {
      method: 'PUT', cookie: editorCookie, body: { ...updateTarget.record, 'Username T': item.raw }
    });
    assert.equal(conflict.response.status, 409);
    assert.deepEqual(conflict.body.conflict.influencerIds, [createdOwners[index].id]);
    assert.deepEqual(conflict.body.conflict.influencerNames, [item.ownerName]);
  }

  const rows = cases.map((item) => ({ Name: item.ownerName, 'Username T': item.raw }));
  const preview = await mustCall('/api/import/preview', {
    method: 'POST', cookie: editorCookie, body: { rows }
  });
  assert.equal(preview.preview.integrity.creates, 0);
  assert.equal(preview.preview.integrity.matchedByAccount, cases.length);
  assert.equal(preview.preview.integrity.issues.length, 0);
  const imported = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: {
    previewId: preview.preview.previewId, rows
  } });
  assert.equal(imported.created, 0);
  assert.equal(imported.unchanged, cases.length);
  assert.equal(imported.failed, 0);

  const db = new DatabaseSync(databasePath, { readOnly: true });
  for (const item of cases) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM influencers
      WHERE json_extract(record_json, '$."Username T"') = ?`).get(item.base).count, 1);
  }
  db.close();
});

test('import preview warns about a matched record name difference without exposing names or blocking import', async () => {
  await mustCall('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic Name Match', 'Username T': 'qa_name_warning_same'
  } });
  await mustCall('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic Existing Name', 'Username T': 'qa_name_warning_different'
  } });
  const rows = [
    { Name: '  synthetic   NAME match ', 'Username T': 'qa_name_warning_same' },
    { Name: 'Synthetic Incoming Name', 'Username T': 'qa_name_warning_different' }
  ];
  const preview = await mustCall('/api/import/preview', {
    method: 'POST', cookie: editorCookie, body: { rows }
  });
  assert.deepEqual(preview.preview.integrity.warnings.filter((warning) => warning.reason === 'اسم مختلف'), [
    { row: 2, reason: 'اسم مختلف' }
  ]);
  const imported = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: {
    previewId: preview.preview.previewId, rows
  } });
  assert.equal(imported.failed, 0);
  assert.equal(imported.created, 0);
  assert.ok(imported.unchanged + imported.updated > 0);
});

test('import preview classifies unchanged, changed, new, and shared-account rows before execution', async () => {
  const unchanged = await mustCall('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic unchanged creator', Full_Mobile_Number: '+966555700101',
    'Username I': 'qa_preview_unchanged_ig', 'Followers Count I': '12000',
    'Username T': 'qa_preview_unchanged_tt', 'Followers Count T': '15000',
    Username: 'qa_preview_unchanged_snap', 'Followers Count S': '9000'
  } });
  const changed = await mustCall('/api/influencers', { method: 'POST', cookie: editorCookie, body: {
    Name: 'Synthetic changed creator', Full_Mobile_Number: '+966555700102',
    'Username I': 'qa_preview_changed_ig', 'Followers Count I': '10000',
    'Username T': 'qa_preview_changed_tt', 'Followers Count T': '11000',
    Username: 'qa_preview_changed_snap', 'Followers Count S': '8000'
  } });
  const workbook = createXlsx([
    ['Name', 'Full_Mobile_Number', 'Username I', 'Followers Count I', 'Username T', 'Followers Count T', 'Username', 'Followers Count S'],
    ['Synthetic unchanged creator', '+966555700101', 'qa_preview_unchanged_ig', '12000', 'qa_preview_unchanged_tt', '15000', 'qa_preview_unchanged_snap', '9000'],
    ['Synthetic changed creator', '+966555700102', 'qa_preview_changed_ig_v2', '26000', 'qa_preview_changed_tt', '11000', 'qa_preview_changed_snap', '8000'],
    ['Synthetic new creator', '+966555700103', 'qa_preview_new_ig', '10000', 'qa_preview_new_tt', '20000', 'qa_preview_new_snap', '3000'],
    ['Synthetic conflict one', '+966555700104', 'qa_preview_shared_ig', '4000', '', '', '', ''],
    ['Synthetic conflict two', '+966555700105', ' @QA_PREVIEW_SHARED_IG ', '5000', '', '', '', '']
  ]);
  const file = { fileName: 'synthetic-import-review.xlsx', fileBase64: workbook.toString('base64') };
  const preview = await mustCall('/api/import/preview', { method: 'POST', cookie: editorCookie, body: file });
  assert.deepEqual({
    creates: preview.preview.integrity.creates,
    updates: preview.preview.integrity.updates,
    unchanged: preview.preview.integrity.unchanged,
    conflicts: preview.preview.integrity.conflicts
  }, { creates: 1, updates: 1, unchanged: 1, conflicts: 2 });
  assert.deepEqual(preview.preview.integrity.issues.map((issue) => issue.reason), [
    'duplicate-account-in-file', 'duplicate-account-in-file'
  ]);
  assert.deepEqual(preview.preview.integrity.issues.map((issue) => issue.accounts[0].username), [
    'qa_preview_shared_ig', 'qa_preview_shared_ig'
  ]);
  const missingPreview = await fetch(`${baseUrl}/api/import`, {
    method: 'POST',
    headers: { cookie: editorCookie, 'content-type': 'application/json' },
    body: JSON.stringify(file)
  });
  assert.equal(missingPreview.status, 410);
  const changedAfterPreview = await fetch(`${baseUrl}/api/import`, {
    method: 'POST',
    headers: { cookie: editorCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      previewId: preview.preview.previewId,
      rows: [{ Name: 'Synthetic changed after preview', 'Username I': 'qa_preview_unreviewed' }]
    })
  });
  assert.equal(changedAfterPreview.status, 409);
  const beforeDb = new DatabaseSync(databasePath, { readOnly: true });
  const countBefore = beforeDb.prepare('SELECT COUNT(*) AS count FROM influencers').get().count;
  beforeDb.close();
  const imported = await mustCall('/api/import', { method: 'POST', cookie: editorCookie, body: file });
  assert.deepEqual({
    created: imported.created,
    updated: imported.updated,
    unchanged: imported.unchanged,
    failed: imported.failed
  }, { created: 1, updated: 1, unchanged: 1, failed: 2 });
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const changedRecord = JSON.parse(db.prepare('SELECT record_json FROM influencers WHERE id = ?').get(changed.record.id).record_json);
  const newRecord = db.prepare(`SELECT record_json FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'Synthetic new creator'`).get();
  assert.equal(changedRecord['Username I'], 'qa_preview_changed_ig_v2');
  assert.equal(changedRecord['Followers Count I'], '26000');
  assert.ok(newRecord);
  const newData = JSON.parse(newRecord.record_json);
  assert.deepEqual([newData['Username I'], newData['Username T'], newData.Username], [
    'qa_preview_new_ig', 'qa_preview_new_tt', 'qa_preview_new_snap'
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, countBefore + 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM influencers
    WHERE lower(replace(json_extract(record_json, '$."Username I"'), '@', '')) = 'qa_preview_shared_ig'`).get().count, 0);
  db.close();
});

test('import preview reports ZIP, URL, and missing profile images without changing the database', async () => {
  const before = new DatabaseSync(databasePath, { readOnly: true });
  const initialCount = before.prepare('SELECT COUNT(*) AS count FROM influencers').get().count;
  before.close();
  const preview = await mustCall('/api/import/preview', {
    method: 'POST',
    cookie: editorCookie,
    body: {
      fileName: 'profile-preview.xlsx',
      fileBase64: createXlsx([
        ['Name', 'Username I', 'Username T', 'Profile Image URL'],
        ['ZIP Preview Creator', 'preview_zip_creator', '', ''],
        ['URL Preview Creator', 'preview_url_creator', '', 'https://images.example.test/profile.png'],
        ['No Image Preview Creator', '', 'preview_no_image', '']
      ]).toString('base64'),
      imageArchiveBase64: createZip([
        ['instagram_preview_zip_creator.png', createPng(32)],
        ['orphan_preview_creator.png', createPng(48)]
      ]).toString('base64')
    }
  });
  assert.deepEqual(
    { total: preview.preview.total, matched: preview.preview.matched, missing: preview.preview.missing },
    { total: 3, matched: 2, missing: 1 }
  );
  assert.deepEqual(preview.preview.items.map(item => item.imageSource), ['zip', 'url', '']);
  assert.equal(preview.preview.issues.length, 1);
  assert.equal(preview.preview.issues[0].reason, 'unmatched-image');
  const previewViewer = await call('/api/import/preview', {
    method: 'POST', cookie: viewerCookie, body: { rows: [] }
  });
  assert.equal(previewViewer.response.status, 403);
  const previewAnonymous = await call('/api/import/preview', {
    method: 'POST', cookie: '', body: { rows: [] }
  });
  assert.equal(previewAnonymous.response.status, 401);
  const after = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(after.prepare('SELECT COUNT(*) AS count FROM influencers').get().count, initialCount);
  assert.equal(after.prepare('SELECT COUNT(*) AS count FROM influencer_profile_images').get().count, 0);
  after.close();
});

test('Excel profile images match safe identities, persist in SQLite, and survive restart without replacing on failures', async () => {
  const validImage = createPng(40);
  const otherImage = createPng(90);
  const workbook = createXlsx([
    ['Name', 'Username I', 'Username T', 'Influencer ID', 'Profile Image URL'],
    ['ZIP Image Creator', 'zip_image_creator', '', '', ''],
    ['Visit Creator', 'visit_creator', '', influencerIds[0], ''],
    ['Shared Handle Instagram', 'shared_image_handle', '', '', ''],
    ['Shared Handle TikTok', '', 'shared_image_handle', '', ''],
    ['Invalid Image Creator', 'invalid_image_creator', '', '', '']
  ]);
  const archive = createZip([
    ['instagram_zip_image_creator.png', validImage],
    ['@zip_image_creator.png', validImage],
    [`id_${influencerIds[0]}.png`, otherImage],
    ['shared_image_handle.png', validImage],
    ['orphan_image.png', validImage],
    ['instagram_invalid_image_creator.png', Buffer.from('not an image')]
  ]);
  const imported = await mustCall('/api/import', {
    method: 'POST',
    cookie: editorCookie,
    body: { fileName: 'profile-images.xlsx', fileBase64: workbook.toString('base64'), imageArchiveBase64: archive.toString('base64') }
  });
  assert.equal(imported.created, 4);
  assert.equal(imported.failed, 0);
  assert.deepEqual(
    { added: imported.images.added, updated: imported.images.updated, unchanged: imported.images.unchanged, failed: imported.images.failed },
    { added: 2, updated: 0, unchanged: 0, failed: 4 }
  );
  assert.deepEqual(imported.images.issues.map(issue => issue.reason).sort(), [
    'ambiguous-image-match', 'invalid-image-content', 'multiple-images-for-influencer', 'unmatched-image'
  ]);

  const imageDb = new DatabaseSync(databasePath, { readOnly: true });
  const imageCreator = imageDb.prepare('SELECT id, record_json FROM influencers')
    .all().map(row => ({ id: row.id, record: JSON.parse(row.record_json) }))
    .find(item => item.record.Name === 'ZIP Image Creator');
  const visitCreator = imageDb.prepare('SELECT record_json FROM influencers WHERE id = ?').get(influencerIds[0]);
  const persistedImageCount = imageDb.prepare('SELECT COUNT(*) AS count FROM influencer_profile_images').get().count;
  assert.equal(persistedImageCount, 2);
  assert.match(imageCreator.record['Profile Image URL'], /^\/profile-images\/[a-f0-9]{32}\?v=/);
  assert.match(JSON.parse(visitCreator.record_json)['Profile Image URL'], /^\/profile-images\/[a-f0-9]{32}\?v=/);
  imageDb.close();

  const imageResponse = await fetch(`${baseUrl}${imageCreator.record['Profile Image URL']}`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), validImage);
  const photoCampaign = (await mustCall('/api/campaigns', {
    method: 'POST', cookie: adminCookie,
    body: {
      campaignName: 'Profile image presentation test', companyName: 'Client One Ltd',
      campaignType: 'visit', serviceType: 'influencer',
      startDate: '2026-11-02', endDate: '2026-11-05',
      targets: [{ id: influencerIds[0], visitDate: '2026-11-03' }]
    }
  })).campaign;
  await mustCall(`/api/client-accounts/${clientOne.id}`, {
    method: 'PATCH', cookie: adminCookie,
    body: { campaignIds: [visitCampaign.id, photoCampaign.id] }
  });
  const campaignRows = await mustCall('/api/campaigns', { cookie: editorCookie });
  const campaignTarget = campaignRows.campaigns.find(campaign => campaign.id === photoCampaign.id)
    ?.targets.find(target => target.id === influencerIds[0]);
  assert.ok(campaignTarget, 'Imported influencer should remain linked to the profile-image test campaign.');
  assert.equal(campaignTarget.profileImage, JSON.parse(visitCreator.record_json)['Profile Image URL'], JSON.stringify(campaignTarget));

  const repeated = await mustCall('/api/import', {
    method: 'POST', cookie: editorCookie,
    body: { rows: [{ 'Influencer ID': imageCreator.id, 'Username I': 'ZIP_IMAGE_CREATOR' }], imageArchiveBase64: createZip([
      ['@zip_image_creator.png', validImage]
    ]).toString('base64') }
  });
  assert.deepEqual(
    { added: repeated.images.added, updated: repeated.images.updated, unchanged: repeated.images.unchanged, failed: repeated.images.failed },
    { added: 0, updated: 0, unchanged: 1, failed: 0 }
  );

  const failedUrl = await mustCall('/api/import', {
    method: 'POST', cookie: editorCookie,
    body: { rows: [{
      'Username I': 'visit_creator',
      'Influencer ID': influencerIds[0],
      'Profile Image URL': 'https://127.0.0.1/private.png'
    }] }
  });
  assert.equal(failedUrl.images.failed, 1);
  assert.equal(failedUrl.images.issues[0].reason, 'image-host-not-public');
  const previousImage = await fetch(`${baseUrl}${JSON.parse(visitCreator.record_json)['Profile Image URL']}`);
  assert.equal(previousImage.status, 200);
  assert.deepEqual(Buffer.from(await previousImage.arrayBuffer()), otherImage);

  const mismatchedImageId = await mustCall('/api/import', {
    method: 'POST', cookie: editorCookie,
    body: { rows: [{
      'Username I': 'visit_creator',
      'Influencer ID': influencerIds[1],
      'Profile Image URL': 'https://images.example.test/new.png'
    }] }
  });
  assert.equal(mismatchedImageId.images.failed, 1);
  assert.equal(mismatchedImageId.images.issues[0].reason, 'image-id-conflict');

  const changed = await mustCall('/api/import', {
    method: 'POST', cookie: editorCookie,
    body: {
      rows: [{ 'Influencer ID': imageCreator.id, 'Username I': 'zip_image_creator' }],
      imageArchiveBase64: createZip([['instagram_zip_image_creator.png', otherImage]]).toString('base64')
    }
  });
  assert.equal(changed.images.updated, 1);
  const updatedRecord = new DatabaseSync(databasePath, { readOnly: true });
  const updatedPath = JSON.parse(updatedRecord.prepare('SELECT record_json FROM influencers WHERE id = ?')
    .get(imageCreator.id).record_json)['Profile Image URL'];
  assert.equal(updatedRecord.prepare('SELECT COUNT(*) AS count FROM influencers WHERE id = ?')
    .get(imageCreator.id).count, 1);
  updatedRecord.close();
  const updatedImageResponse = await fetch(`${baseUrl}${updatedPath}`);
  assert.equal(updatedImageResponse.status, 200);
  assert.deepEqual(Buffer.from(await updatedImageResponse.arrayBuffer()), otherImage);

  const imagePresentation = await mustCall(`/api/campaigns/${photoCampaign.id}/presentations`, {
    method: 'POST',
    cookie: adminCookie,
    body: { brandId: 'fkretk', clientAccountId: clientOne.id, influencerIds: [influencerIds[0]], fields: ['name', 'profileImage', 'visitDate'] }
  });
  const publicPresentation = await (await fetch(`${baseUrl}/api/campaign-presentations/${imagePresentation.token}`)).json();
  assert.equal(publicPresentation.targets[0].profileImage, JSON.parse(visitCreator.record_json)['Profile Image URL']);
  assert.equal(publicPresentation.targets[0].placeholderImage, '/assets/avatars/female-hijab.svg');

  const photoDbBefore = new DatabaseSync(databasePath, { readOnly: true });
  const manualCreatorId = 'c'.repeat(32);
  const manualCreatorBefore = JSON.parse(photoDbBefore.prepare('SELECT record_json FROM influencers WHERE id = ?')
    .get(manualCreatorId).record_json);
  photoDbBefore.close();
  const photoBatchIds = [];
  const photoBatchRecords = [];
  for (let index = 0; index < 10; index += 1) {
    const created = await mustCall('/api/influencers', {
      method: 'POST', cookie: editorCookie,
      body: {
      Name: `Photo Batch ${index + 1}`,
      'Username I': `photo_batch_${index + 1}`,
      'Followers Count I': String(1000 + index),
      Note: 'test-only private note'
      }
    });
    photoBatchIds.push(created.record.id);
    photoBatchRecords.push(created.record);
  }
  const unlinkedCreator = await mustCall('/api/influencers', {
    method: 'POST', cookie: editorCookie,
    body: { Name: 'Unlinked Photo', 'Username I': 'photo_unlinked' }
  });

  const photoTemplate = await fetch(`${baseUrl}/api/influencer-photos/template`, {
    headers: { Cookie: editorCookie }
  });
  assert.equal(photoTemplate.status, 200);
  assert.match(photoTemplate.headers.get('content-type') || '', /spreadsheetml\.sheet/);
  const photoTemplateBuffer = Buffer.from(await photoTemplate.arrayBuffer());
  assert.equal(photoTemplateBuffer.readUInt32LE(0), 0x04034b50);
  const unauthenticatedTemplate = await call('/api/influencer-photos/template', { cookie: '' });
  assert.equal(unauthenticatedTemplate.response.status, 401);
  const viewerTemplate = await call('/api/influencer-photos/template', { cookie: viewerCookie });
  assert.equal(viewerTemplate.response.status, 403);

  const unauthenticatedPhotoPreview = await call('/api/influencer-photos/preview', {
    method: 'POST', cookie: '',
    body: { fileName: 'photo-map.xlsx', fileBase64: photoTemplateBuffer.toString('base64') }
  });
  assert.equal(unauthenticatedPhotoPreview.response.status, 401);
  const viewerPhotoPreview = await call('/api/influencer-photos/preview', {
    method: 'POST', cookie: viewerCookie,
    body: { fileName: 'photo-map.xlsx', fileBase64: photoTemplateBuffer.toString('base64') }
  });
  assert.equal(viewerPhotoPreview.response.status, 403);
  const emptyPhotoTemplatePreview = await call('/api/influencer-photos/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'template.xlsx', fileBase64: photoTemplateBuffer.toString('base64') }
  });
  assert.equal(emptyPhotoTemplatePreview.response.status, 400);
  assert.match(emptyPhotoTemplatePreview.body.error, /صف بيانات واحد/);

  const imageTypes = [
    { extension: 'png', data: createPng(31) },
    { extension: 'jpg', data: createJpeg(32) },
    { extension: 'webp', data: createWebp(33) }
  ];
  const batchImages = photoBatchIds.map((_, index) => ({
    row: index + 2,
    ...imageTypes[index % imageTypes.length]
  })).reverse();
  const photoHeaders = ['Influencer ID', 'Main Username', 'Influencer Name', 'Image File Name', 'Optional Notes'];
  const photoWorkbook = createXlsx([
    photoHeaders,
    ...photoBatchRecords.map((record) => [record.id, record.Main_Username, record.Name, '', ''])
  ], { images: batchImages });
  const photoPreview = await mustCall('/api/influencer-photos/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'photo-map.xlsx', fileBase64: photoWorkbook.toString('base64') }
  });
  assert.equal(photoPreview.summary.rows, 10);
  assert.equal(photoPreview.summary.matched, 10);
  assert.equal(photoPreview.summary.ready, 10);
  assert.deepEqual(photoPreview.items.map((item) => item.sourceRow), Array.from({ length: 10 }, (_, i) => i + 2));
  for (const [index, item] of photoPreview.items.entries()) {
    const imageResponse = await fetch(`${baseUrl}/api/influencer-photos/preview/${photoPreview.previewId}/${item.index}`, {
      headers: { Cookie: editorCookie }
    });
    assert.equal(imageResponse.status, 200);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), imageTypes[index % imageTypes.length].data);
  }
  const differentOwnerUpload = await call('/api/influencer-photos/upload', {
    method: 'POST', cookie: adminCookie,
    body: { previewId: photoPreview.previewId, selectedRows: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], replaceExisting: [] }
  });
  assert.equal(differentOwnerUpload.response.status, 410);
  const photoUpload = await mustCall('/api/influencer-photos/upload', {
    method: 'POST', cookie: editorCookie,
    body: { previewId: photoPreview.previewId, selectedRows: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], replaceExisting: [] }
  });
  assert.deepEqual(
    { uploaded: photoUpload.uploaded, skipped: photoUpload.skipped, failed: photoUpload.failed },
    { uploaded: 10, skipped: 0, failed: 0 }
  );
  const savedBatchDb = new DatabaseSync(databasePath, { readOnly: true });
  for (const [index, id] of photoBatchIds.entries()) {
    const savedImage = savedBatchDb.prepare('SELECT image_data FROM influencer_profile_images WHERE influencer_id = ?').get(id);
    const savedRecord = JSON.parse(savedBatchDb.prepare('SELECT record_json FROM influencers WHERE id = ?').get(id).record_json);
    assert.deepEqual(Buffer.from(savedImage.image_data), imageTypes[index % imageTypes.length].data);
    assert.equal(savedRecord['Followers Count I'], String(1000 + index));
    assert.equal(savedRecord.Note, 'test-only private note');
  }
  savedBatchDb.close();

  const reviewWorkbook = createXlsx([
    photoHeaders,
    [photoBatchRecords[0].id, photoBatchRecords[0].Main_Username, photoBatchRecords[0].Name, '', ''],
    [photoBatchRecords[4].id, photoBatchRecords[4].Main_Username, photoBatchRecords[4].Name, '', ''],
    ['e'.repeat(32), photoBatchRecords[0].Main_Username, photoBatchRecords[0].Name, '', ''],
    [photoBatchRecords[1].id, photoBatchRecords[1].Main_Username, photoBatchRecords[1].Name, '', ''],
    [photoBatchRecords[1].id, photoBatchRecords[1].Main_Username, photoBatchRecords[1].Name, '', ''],
    ['', '', '', '', ''],
    ['', '', '', '', ''],
    [photoBatchRecords[2].id, photoBatchRecords[2].Main_Username, photoBatchRecords[2].Name, '', '']
  ], { images: [
    { row: 2, data: createPng(61) },
    { row: 4, data: createPng(62) },
    { row: 7, data: createPng(63) },
    { row: 8, data: createPng(64) },
    { row: 9, data: createPng(65) }
  ] });
  const reviewPreview = await mustCall('/api/influencer-photos/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'review.xlsx', fileBase64: reviewWorkbook.toString('base64') }
  });
  assert.deepEqual(
    reviewPreview.items.map((item) => item.status),
    ['Already Has Photo', 'Missing Image', 'No Matching Influencer', 'Duplicate Influencer ID',
      'Duplicate Influencer ID', 'Missing Influencer ID', 'Missing Influencer ID', 'Already Has Photo']
  );
  assert.equal(reviewPreview.items[2].hasImage, true);
  const replacementBlocked = await mustCall('/api/influencer-photos/upload', {
    method: 'POST', cookie: editorCookie,
    body: { previewId: reviewPreview.previewId, selectedRows: [0], replaceExisting: [] }
  });
  assert.equal(replacementBlocked.uploaded, 0);
  assert.equal(replacementBlocked.failed, 1);
  const replacementConfirmed = await mustCall('/api/influencer-photos/upload', {
    method: 'POST', cookie: editorCookie,
    body: { previewId: reviewPreview.previewId, selectedRows: [0], replaceExisting: [0] }
  });
  assert.equal(replacementConfirmed.uploaded, 1);
  const replacedPhotoDb = new DatabaseSync(databasePath, { readOnly: true });
  const replacedPhoto = replacedPhotoDb.prepare('SELECT image_data FROM influencer_profile_images WHERE influencer_id = ?')
    .get(photoBatchIds[0]);
  replacedPhotoDb.close();
  assert.deepEqual(Buffer.from(replacedPhoto.image_data), createPng(61));
  const wrongAnchorWorkbook = createXlsx([
    photoHeaders,
    [unlinkedCreator.record.id, unlinkedCreator.record.Main_Username, unlinkedCreator.record.Name, '', '']
  ], { images: [{ row: 2, column: 0, data: createPng(65) }] });
  const wrongAnchorPreview = await mustCall('/api/influencer-photos/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'wrong-anchor.xlsx', fileBase64: wrongAnchorWorkbook.toString('base64') }
  });
  assert.equal(wrongAnchorPreview.items[0].status, 'Uncertain Image');
  const unsafeSelection = await mustCall('/api/influencer-photos/upload', {
    method: 'POST', cookie: editorCookie,
    body: { previewId: wrongAnchorPreview.previewId, selectedRows: [0], replaceExisting: [] }
  });
  assert.equal(unsafeSelection.uploaded, 0);
  assert.equal(unsafeSelection.skipped, 1);
  const inCellWorkbook = createXlsx([
    photoHeaders,
    [unlinkedCreator.record.id, unlinkedCreator.record.Main_Username, unlinkedCreator.record.Name, '', '']
  ], { inCellImages: [{ row: 2, data: createPng(73) }] });
  const inCellPreview = await mustCall('/api/influencer-photos/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'in-cell.xlsx', fileBase64: inCellWorkbook.toString('base64') }
  });
  assert.equal(inCellPreview.items[0].status, 'Ready to Upload', JSON.stringify(inCellPreview));
  const inCellImageResponse = await fetch(`${baseUrl}/api/influencer-photos/preview/${inCellPreview.previewId}/0`, {
    headers: { Cookie: editorCookie }
  });
  assert.deepEqual(Buffer.from(await inCellImageResponse.arrayBuffer()), createPng(73));
  const inCellUpload = await mustCall('/api/influencer-photos/upload', {
    method: 'POST', cookie: editorCookie,
    body: { previewId: inCellPreview.previewId, selectedRows: [0], replaceExisting: [] }
  });
  assert.equal(inCellUpload.uploaded, 1);
  const mismatchedIdentityWorkbook = createXlsx([
    photoHeaders,
    [unlinkedCreator.record.id, 'different_main_username', unlinkedCreator.record.Name, '', '']
  ], { images: [{ row: 2, data: createPng(74) }] });
  const mismatchedIdentityPreview = await mustCall('/api/influencer-photos/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'mismatched-identity.xlsx', fileBase64: mismatchedIdentityWorkbook.toString('base64') }
  });
  assert.equal(mismatchedIdentityPreview.items[0].influencerId, unlinkedCreator.record.id);
  assert.equal(mismatchedIdentityPreview.items[0].status, 'Conflict – Needs Review');
  const mismatchedIdentityUpload = await mustCall('/api/influencer-photos/upload', {
    method: 'POST', cookie: editorCookie,
    body: { previewId: mismatchedIdentityPreview.previewId, selectedRows: [0], replaceExisting: [] }
  });
  assert.equal(mismatchedIdentityUpload.uploaded, 0);
  assert.equal(mismatchedIdentityUpload.skipped, 1);
  const mismatchedIdentityDb = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(
    Buffer.from(mismatchedIdentityDb.prepare('SELECT image_data FROM influencer_profile_images WHERE influencer_id = ?')
      .get(unlinkedCreator.record.id).image_data),
    createPng(73)
  );
  mismatchedIdentityDb.close();

  const duplicateImageWorkbook = createXlsx([
    photoHeaders,
    [unlinkedCreator.record.id, unlinkedCreator.record.Main_Username, unlinkedCreator.record.Name, '', '']
  ], { images: [
    { row: 2, data: createPng(71) },
    { row: 2, data: createPng(72) }
  ] });
  const duplicateImagePreview = await mustCall('/api/influencer-photos/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'duplicate-images.xlsx', fileBase64: duplicateImageWorkbook.toString('base64') }
  });
  assert.equal(duplicateImagePreview.items[0].status, 'Uncertain Image');
  assert.equal(duplicateImagePreview.items[0].imageCount, 2);
  for (const [imageIndex, seed] of [71, 72].entries()) {
    const response = await fetch(`${baseUrl}/api/influencer-photos/preview/${duplicateImagePreview.previewId}/0/${imageIndex}`, {
      headers: { Cookie: editorCookie }
    });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), createPng(seed));
  }
  const invalidImageWorkbook = createXlsx([
    photoHeaders,
    [photoBatchRecords[7].id, photoBatchRecords[7].Main_Username, photoBatchRecords[7].Name, '', '']
  ], { images: [{ row: 2, data: Buffer.from('not-an-image') }] });
  const invalidImagePreview = await mustCall('/api/influencer-photos/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'invalid-image.xlsx', fileBase64: invalidImageWorkbook.toString('base64') }
  });
  assert.equal(invalidImagePreview.items[0].status, 'Invalid Image');
  const invalidHeaders = createXlsx([['Main Username', 'Image File Name'], ['photo_unlinked', 'one.png']]);
  const invalidHeadersPreview = await call('/api/influencer-photos/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'old-template.xlsx', fileBase64: invalidHeaders.toString('base64') }
  });
  assert.equal(invalidHeadersPreview.response.status, 400);
  const extraColumns = createXlsx([
    [...photoHeaders, 'Other'],
    [unlinkedCreator.record.id, unlinkedCreator.record.Main_Username, unlinkedCreator.record.Name, '', '', 'unexpected data']
  ]);
  const extraColumnsPreview = await call('/api/influencer-photos/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'extra-columns.xlsx', fileBase64: extraColumns.toString('base64') }
  });
  assert.equal(extraColumnsPreview.response.status, 400);

  const manualPhotoWorkbook = createXlsx([
    photoHeaders,
    [manualCreatorId, manualCreatorBefore.Main_Username, manualCreatorBefore.Name, '', '']
  ], { images: [{ row: 2, data: validImage }] });
  const manualPhotoPreview = await mustCall('/api/influencer-photos/preview', {
    method: 'POST', cookie: editorCookie,
    body: { fileName: 'manual-photo.xlsx', fileBase64: manualPhotoWorkbook.toString('base64') }
  });
  assert.equal(manualPhotoPreview.items[0].status, 'Ready to Upload');
  const manualPhotoUpload = await mustCall('/api/influencer-photos/upload', {
    method: 'POST', cookie: editorCookie,
    body: { previewId: manualPhotoPreview.previewId, selectedRows: [0], replaceExisting: [] }
  });
  assert.equal(manualPhotoUpload.uploaded, 1);
  const imageDbAfterPhoto = new DatabaseSync(databasePath, { readOnly: true });
  const manualCreatorAfter = JSON.parse(imageDbAfterPhoto.prepare('SELECT record_json FROM influencers WHERE id = ?')
    .get(manualCreatorId).record_json);
  imageDbAfterPhoto.close();
  assert.equal(manualCreatorAfter.Main_Username, manualCreatorBefore.Main_Username);
  assert.equal(manualCreatorAfter['Followers Count I'], manualCreatorBefore['Followers Count I']);
  assert.ok(manualCreatorAfter['Profile Image URL'].startsWith(`/profile-images/${manualCreatorId}?v=`));
  const photoCatalog = await mustCall('/api/client-catalogs', {
    method: 'POST',
    body: { brandId: 'fkretk', clientName: 'Photo client', companyName: 'Photo client', influencerIds: [manualCreatorId] }
  });
  const publicPhotoCatalog = await mustCall(`/api/client-catalog/${photoCatalog.url.split('/').at(-1)}`);
  assert.equal(publicPhotoCatalog.influencers[0].profileImage, manualCreatorAfter['Profile Image URL']);
  assert.equal(publicPhotoCatalog.influencers[0].placeholderImage, '/assets/avatars/female.svg');
  const placeholderAsset = await fetch(`${baseUrl}${publicPhotoCatalog.influencers[0].placeholderImage}`);
  assert.equal(placeholderAsset.status, 200);
  assert.match(placeholderAsset.headers.get('content-type') || '', /image\/svg\+xml/);

  const viewerUpload = await call('/api/import', {
    method: 'POST', cookie: viewerCookie,
    body: { rows: [{ 'Username I': 'zip_image_creator' }], imageArchiveBase64: archive.toString('base64') }
  });
  assert.equal(viewerUpload.response.status, 403);
});

test('SQLite-backed profile images remain available after restarting the isolated test server', async () => {
  const imageDb = new DatabaseSync(databasePath, { readOnly: true });
  const record = imageDb.prepare(`SELECT id, record_json FROM influencers
    WHERE json_extract(record_json, '$.Name') = 'ZIP Image Creator'`).get();
  const imageUrl = JSON.parse(record.record_json)['Profile Image URL'];
  const imageHash = imageDb.prepare('SELECT content_hash FROM influencer_profile_images WHERE influencer_id = ?')
    .get(record.id)?.content_hash;
  imageDb.close();
  assert.ok(imageHash);
  assert.equal(imageUrl, `/profile-images/${record.id}?v=${imageHash.slice(0, 12)}`);
  const beforeRestart = await mustCall('/api/import', {
    method: 'POST', cookie: editorCookie,
    body: { rows: [{ 'Influencer ID': record.id, 'Username I': 'zip_image_creator' }] }
  });
  assert.equal(beforeRestart.images.added, 0);
  server.kill();
  await once(server, 'exit');
  restartTestServer();
  let readyAfterRestart = false;
  for (let attempt = 0; attempt < 200 && !readyAfterRestart; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Test server stopped after restart: ${serverErrors}`);
    try { readyAfterRestart = (await fetch(baseUrl)).status === 200; } catch {}
    if (!readyAfterRestart) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(readyAfterRestart, true, serverErrors);
  const imageResponse = await fetch(`${baseUrl}${imageUrl}`);
  if (imageResponse.status !== 200) throw new Error(`${imageUrl} ${await imageResponse.text()} ${serverErrors}`);
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await imageResponse.arrayBuffer()).length > 24, true);
  const savedPresentation = await fetch(`${baseUrl}/api/campaign-presentations/${companyWorkPresentationToken}`);
  assert.equal(savedPresentation.status, 200);
  const savedPresentationBody = await savedPresentation.json();
  assert.deepEqual(savedPresentationBody.companyWorkVideos.map(video => video.id), companyWorkPresentationVideoIds);
  const libraryAfterRestart = await call('/api/company-work-videos');
  assert.equal(libraryAfterRestart.response.status, 401);
});

test('followers-only imports cannot update profile images and preserve all other influencer fields', async () => {
  const testEditorCookie = await login('portal-editor', 'Portal-editor-pass-2026!');
  const creator = await mustCall('/api/influencers', {
    method: 'POST',
    cookie: testEditorCookie,
    body: {
      Name: 'Follower Isolation Creator',
      Main_Username: 'follower_isolation_main',
      'Username I': 'follower_isolation_creator',
      'Followers Count I': '1000'
    }
  });
  const originalImage = createPng(44);
  const replacementImage = createPng(88);
  const imageImport = await mustCall('/api/import', {
    method: 'POST',
    cookie: testEditorCookie,
    body: {
      rows: [{ 'Influencer ID': creator.record.id, 'Username I': 'follower_isolation_creator' }],
      imageArchiveBase64: createZip([[`id_${creator.record.id}.png`, originalImage]]).toString('base64')
    }
  });
  assert.equal(imageImport.images.added, 1);

  const preview = await mustCall('/api/import/preview', {
    method: 'POST',
    cookie: testEditorCookie,
    body: {
      followersOnly: true,
      rows: [{ 'Influencer ID': creator.record.id, 'Username I': 'follower_isolation_creator', 'Followers Count I': '2200', 'Update Date': '2026-11-05' }]
    }
  });
  assert.equal(preview.preview.followersOnly, true);
  assert.equal(preview.preview.total, 1);
  assert.equal('integrity' in preview.preview, false);

  const updated = await mustCall('/api/import', {
    method: 'POST',
    cookie: testEditorCookie,
    body: {
      followersOnly: true,
      rows: [{
        'Influencer ID': creator.record.id,
        'Username I': 'follower_isolation_creator',
        'Followers Count I': '2200',
        'Update Date': '2026-11-05',
        Name: 'Must Not Replace Name',
        Main_Username: 'must_not_replace_main'
      }]
    }
  });
  assert.deepEqual(
    { updatedAccounts: updated.updatedAccounts, invalid: updated.invalid, images: 'images' in updated },
    { updatedAccounts: 1, invalid: 0, images: false },
    JSON.stringify(updated.issues)
  );
  const missingId = await mustCall('/api/import', {
    method: 'POST',
    cookie: testEditorCookie,
    body: {
      followersOnly: true,
      rows: [{
        'Username I': 'follower_isolation_creator',
        'Followers Count I': '3300',
        'Update Date': '2026-11-05'
      }]
    }
  });
  assert.equal(missingId.updatedAccounts, 0);
  assert.equal(missingId.ambiguous, 1);
  assert.equal(missingId.issues[0].reason, 'missing-record-id');
  const mismatchedId = await mustCall('/api/import', {
    method: 'POST',
    cookie: testEditorCookie,
    body: {
      followersOnly: true,
      rows: [{
        'Influencer ID': influencerIds[0],
        'Username I': 'follower_isolation_creator',
        'Followers Count I': '3300',
        'Update Date': '2026-11-05'
      }]
    }
  });
  assert.equal(mismatchedId.updatedAccounts, 0);
  assert.equal(mismatchedId.ambiguous, 1);
  assert.equal(mismatchedId.issues[0].reason, 'identifiers-disagree');

  const combined = await call('/api/import', {
    method: 'POST',
    cookie: testEditorCookie,
    body: {
      followersOnly: true,
      rows: [{ 'Influencer ID': creator.record.id, 'Username I': 'follower_isolation_creator', 'Followers Count I': '3300', 'Update Date': '2026-11-05' }],
      imageArchiveBase64: createZip([[`id_${creator.record.id}.png`, replacementImage]]).toString('base64')
    }
  });
  assert.equal(combined.response.status, 400);
  assert.match(combined.body.error, /فصل تحديث المتابعين/);
  const imageUrlCombined = await call('/api/import/preview', {
    method: 'POST',
    cookie: testEditorCookie,
    body: {
      followersOnly: true,
      rows: [{
        'Influencer ID': creator.record.id,
        'Username I': 'follower_isolation_creator',
        'Followers Count I': '3300',
        'Update Date': '2026-11-05',
        'Profile Image URL': 'https://images.example.test/profile.png'
      }]
    }
  });
  assert.equal(imageUrlCombined.response.status, 400);

  const verify = new DatabaseSync(databasePath, { readOnly: true });
  const stored = JSON.parse(verify.prepare('SELECT record_json FROM influencers WHERE id = ?')
    .get(creator.record.id).record_json);
  const savedImage = verify.prepare('SELECT image_data FROM influencer_profile_images WHERE influencer_id = ?')
    .get(creator.record.id);
  const historyCount = verify.prepare(`SELECT COUNT(*) AS count FROM influencer_follower_history
    WHERE influencer_id = ? AND platform = 'Instagram'`).get(creator.record.id).count;
  const recordedAt = verify.prepare(`SELECT recorded_at FROM influencer_follower_history
    WHERE influencer_id = ? AND platform = 'Instagram'`).get(creator.record.id).recorded_at;
  assert.equal(stored.Name, 'Follower Isolation Creator');
  assert.equal(stored.Main_Username, 'follower_isolation_creator');
  assert.equal(stored['Followers Count I'], '2200');
  assert.equal(historyCount, 1);
  assert.equal(recordedAt, '2026-11-05T00:00:00.000Z');
  assert.deepEqual(Buffer.from(savedImage.image_data), originalImage);
  verify.close();
});

test('client presentations persist account visibility without deleting accounts or changing influencer decisions', async () => {
  const currentAdminCookie = await login('portal-admin', 'Portal-admin-pass-2026!');
  const creator = await mustCall('/api/influencers', {
    method: 'POST',
    cookie: currentAdminCookie,
    body: {
      Name: 'Visibility Test Creator',
      Main_Username: 'visibility_snap_handle',
      'Best Platform': 'Snapchat',
      'Username I': 'visibility_instagram',
      'Followers Count I': '12000',
      'Username T': 'visibility_tiktok',
      'Followers Count T': '23000',
      Username: 'visibility_snap_handle',
      'Followers Count S': '34000'
    }
  });
  const offer = await mustCall('/api/client-catalogs', {
    method: 'POST',
    cookie: currentAdminCookie,
    body: {
      brandId: 'fkretk',
      clientName: 'Visibility Client',
      companyName: 'Visibility Company',
      influencerIds: [creator.record.id],
      accountVisibility: {
        [creator.record.id]: { Instagram: true, TikTok: true, Snapchat: false }
      }
    }
  });
  const savedVisibility = await mustCall(`/api/client-catalogs/${offer.catalog.id}/influencers`, { cookie: currentAdminCookie });
  assert.deepEqual(savedVisibility.accountVisibility[creator.record.id], {
    Instagram: true, TikTok: true, Snapchat: false
  });
  const token = offer.url.split('/').at(-1);
  for (const path of [`/api/client-catalog/${token}`, `/api/client-catalogs/${offer.catalog.id}/client-preview`]) {
    const presentation = await mustCall(path, { cookie: currentAdminCookie });
    const influencer = presentation.influencers[0];
    assert.equal(influencer.instagramUsername, 'visibility_instagram');
    assert.equal(influencer.tiktokUsername, 'visibility_tiktok');
    assert.equal(influencer.snapchatUsername, '');
    assert.equal(influencer.snapchatFollowers, '');
    assert.equal(influencer.mainUsername, '');
    assert.equal(influencer.platform, '');
  }
  const client = await mustCall('/api/client-accounts', {
    method: 'POST',
    cookie: currentAdminCookie,
    body: {
      username: 'visibility-client',
      email: 'visibility-client@example.test',
      clientName: 'Visibility Client',
      companyName: 'Visibility Company',
      password: 'Visibility-client-pass-2026!',
      clientType: 'prospective',
      catalogIds: [offer.catalog.id],
      portalConfig: {
        template: 'request-approval',
        status: 'published',
        sections: ['requestApproval'],
        fields: { requestApproval: ['name', 'username', 'platform', 'followers'], visitSchedule: [], deliveryCampaign: [], campaignReport: [] },
        actions: { allowDecisions: false, allowRevert: false, allowVisitConfirmation: false, allowVisitChangeRequest: false, allowShippingFollowUp: false }
      }
    }
  });
  const clientCookie = await loginClient('visibility-client@example.test', 'Visibility-client-pass-2026!');
  const portal = await mustCall('/api/client-portal/campaigns', { cookie: clientCookie });
  const portalInfluencer = portal.offers.find((item) => item.id === offer.catalog.id).influencers[0];
  assert.deepEqual(portalInfluencer.profiles.map((profile) => profile.platform).sort(), ['Instagram', 'TikTok']);
  assert.equal(portalInfluencer.mainUsername, '');
  assert.equal(portalInfluencer.platform, '');
  assert.equal('followers' in portalInfluencer, false);
  const showcase = await mustCall(`/api/client-portal/showcases/${offer.catalog.id}`, { cookie: clientCookie });
  assert.deepEqual(showcase.items[0].socialAccounts.map((account) => account.platform).sort(), ['Instagram', 'TikTok']);
  assert.equal(showcase.items[0].mainUsername, '');
  await mustCall(`/api/client-catalogs/${offer.catalog.id}/influencers`, {
    method: 'POST',
    cookie: currentAdminCookie,
    body: {
      influencerIds: [creator.record.id],
      accountVisibility: {
        [creator.record.id]: { Instagram: true, TikTok: false, Snapchat: true }
      }
    }
  });
  const updatedPresentation = await mustCall(`/api/client-catalog/${token}`);
  assert.equal(updatedPresentation.influencers[0].tiktokUsername, '');
  assert.equal(updatedPresentation.influencers[0].snapchatUsername, 'visibility_snap_handle');
  assert.equal(updatedPresentation.influencers[0].mainUsername, 'visibility_snap_handle');
  const updatedShowcase = await mustCall(`/api/client-portal/showcases/${offer.catalog.id}`, { cookie: clientCookie });
  assert.deepEqual(updatedShowcase.items[0].socialAccounts.map((account) => account.platform).sort(), ['Instagram', 'Snapchat']);
  const updatedPortal = await mustCall('/api/client-portal/campaigns', { cookie: clientCookie });
  const updatedPortalInfluencer = updatedPortal.offers.find((item) => item.id === offer.catalog.id).influencers[0];
  assert.deepEqual(updatedPortalInfluencer.profiles.map((profile) => profile.platform).sort(), ['Instagram', 'Snapchat']);
  assert.equal(updatedPortalInfluencer.mainUsername, 'visibility_snap_handle');
  assert.equal(updatedPortalInfluencer.platform, 'Snapchat');
  const stored = await mustCall('/api/influencers/by-ids', {
    method: 'POST', cookie: currentAdminCookie, body: { ids: [creator.record.id] }
  });
  assert.equal(stored.rows[0].Username, 'visibility_snap_handle');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM client_catalog_items WHERE catalog_id = ? AND influencer_id = ?')
    .get(offer.catalog.id, creator.record.id).count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM client_catalog_decisions WHERE catalog_id = ? AND influencer_id = ?')
    .get(offer.catalog.id, creator.record.id).count, 0);
  db.close();
  assert.equal(client.account.id.length, 32);
});

test('Coverage is an independent video library with role checks and read-only campaign counts', async () => {
  const currentAdminCookie = await login('portal-admin', 'Portal-admin-pass-2026!');
  const currentEditorCookie = await login('portal-editor', 'Portal-editor-pass-2026!');
  const currentViewerCookie = await login('portal-viewer', 'Portal-viewer-pass-2026!');
  const currentClientCookie = await loginClient('client.one@example.test', 'Client-one-pass-2026!');
  const coverageInfluencer = await mustCall('/api/influencers', {
    method: 'POST',
    cookie: currentAdminCookie,
    body: { Name: 'Coverage Synthetic Creator', Main_Username: 'coverage_synthetic_creator', 'Username I': 'coverage_synthetic_instagram' }
  });

  test('Arabic client offer names round-trip through the JSON API without UTF-8 corruption', async () => {
    const currentAdminCookie = await login('portal-admin', 'Portal-admin-pass-2026!');
    const offerName = 'عرض رمضان ٢٠٢٦ - شركة الأمل';
    const created = await mustCall('/api/client-catalogs', {
      method: 'POST',
      cookie: currentAdminCookie,
      body: {
        brandId: 'fkretk',
        companyName: 'شركة الأمل',
        offerName,
        influencerIds: [influencerIds[0]]
      }
    });
    assert.equal(created.catalog.offerName, offerName);
    const listed = await mustCall('/api/client-catalogs', { cookie: currentAdminCookie });
    assert.equal(listed.catalogs.find((catalog) => catalog.id === created.catalog.id).offerName, offerName);
  });
  const before = (await mustCall('/api/campaigns', { cookie: currentAdminCookie })).campaigns;
  const visitBefore = before.find((campaign) => campaign.id === visitCampaign.id);
  const deliveryBefore = before.find((campaign) => campaign.id === deliveryCampaign.id);
  const unauthorized = await call('/api/coverage', {
    method: 'POST', cookie: currentViewerCookie,
    body: { url: 'https://youtu.be/Cov00000001', title: 'Denied', description: '', influencerId: coverageInfluencer.record.id, campaignId: visitCampaign.id }
  });
  assert.equal(unauthorized.response.status, 403);
  assert.deepEqual((await mustCall('/api/coverage', { cookie: currentViewerCookie })).rows, []);
  const invalidUrl = await call('/api/coverage', {
    method: 'POST', cookie: currentEditorCookie,
    body: { url: 'https://example.test/Cov00000001', title: 'Invalid URL', description: '', influencerId: coverageInfluencer.record.id, campaignId: visitCampaign.id }
  });
  assert.equal(invalidUrl.response.status, 400);
  const created = await mustCall('/api/coverage', {
    method: 'POST', cookie: currentEditorCookie,
    body: {
      url: 'https://youtu.be/Cov00000001',
      title: 'Synthetic Coverage video',
      description: 'Synthetic coverage description',
      influencerId: coverageInfluencer.record.id,
      campaignId: visitCampaign.id
    }
  });
  assert.equal(created.video.videoId, 'Cov00000001');
  assert.equal(created.video.influencerId, coverageInfluencer.record.id);
  assert.equal(created.video.campaignId, visitCampaign.id);
  assert.equal(created.video.influencerName, 'Coverage Synthetic Creator');
  const unrelatedCompanyVideo = await mustCall('/api/coverage', {
    method: 'POST', cookie: currentEditorCookie,
    body: {
      url: 'https://youtu.be/Cov00000002',
      title: 'Unrelated advertiser sample',
      description: 'This video belongs to another advertiser.',
      influencerId: coverageInfluencer.record.id,
      campaignId: deliveryCampaign.id
    }
  });
  const showcaseOffer = await mustCall('/api/client-catalogs', {
    method: 'POST', cookie: currentAdminCookie,
    body: {
      brandId: 'fkretk', clientName: 'Client One', companyName: 'Client One Ltd',
      offerName: 'Coverage showcase', influencerIds: [coverageInfluencer.record.id]
    }
  });
  await mustCall(`/api/client-accounts/${clientOne.id}`, {
    method: 'PATCH', cookie: currentAdminCookie, body: { catalogIds: [showcaseOffer.catalog.id] }
  });
  const clientCoverage = await mustCall(`/api/client-portal/showcases/${showcaseOffer.catalog.id}`, { cookie: currentClientCookie });
  assert.deepEqual(clientCoverage.coverageVideos.map(video => video.id), [created.video.id]);
  assert.equal(clientCoverage.coverageVideos[0].videoId, 'Cov00000001');
  assert.equal(clientCoverage.coverageVideos[0].title, 'Synthetic Coverage video');
  assert.equal(clientCoverage.coverageVideos[0].influencerName, 'Coverage Synthetic Creator');
  const previewCoverage = await mustCall(`/api/client-catalogs/${showcaseOffer.catalog.id}/client-preview`, { cookie: currentAdminCookie });
  assert.deepEqual(previewCoverage.coverageVideos.map(video => video.id), [created.video.id]);
  const publicCatalogToken = showcaseOffer.url.split('/').at(-1);
  const publicCatalogCoverage = await mustCall(`/api/client-catalog/${publicCatalogToken}`, { cookie: '' });
  assert.deepEqual(publicCatalogCoverage.coverageVideos.map(video => video.id), [created.video.id]);
  const serializedCoverage = JSON.stringify(clientCoverage.coverageVideos);
  for (const privateValue of ['555123456', 'staff-only note', 'Another advertiser', 'Client Two Ltd']) {
    assert.equal(serializedCoverage.includes(privateValue), false);
  }
  assert.ok(unrelatedCompanyVideo.video.id);
  const auditDb = new DatabaseSync(databasePath, { readOnly: true });
  const auditEvent = { ...auditDb.prepare(`SELECT action, section, entity_type AS entityType, entity_label AS entityLabel
    FROM audit_events WHERE entity_id = ? AND action = 'coverage.create'`).get(created.video.id) };
  assert.deepEqual(auditEvent, {
    action: 'coverage.create', section: 'coverage', entityType: 'coverage_video', entityLabel: 'Synthetic Coverage video'
  });
  auditDb.close();
  const filtered = await mustCall(`/api/coverage?campaignId=${visitCampaign.id}&influencerId=${coverageInfluencer.record.id}`, { cookie: currentEditorCookie });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.rows[0].id, created.video.id);
  const searched = await mustCall('/api/coverage?q=coverage%20synthetic%20creator', { cookie: currentEditorCookie });
  assert.equal(searched.total, 2);
  await mustCall(`/api/coverage/${unrelatedCompanyVideo.video.id}`, { method: 'DELETE', cookie: currentAdminCookie });
  const createdCounts = (await mustCall('/api/campaigns', { cookie: currentAdminCookie })).campaigns;
  assert.equal(createdCounts.find((campaign) => campaign.id === visitCampaign.id).coverageCount,
    (visitBefore.coverageCount || 0) + 1);
  const updated = await mustCall(`/api/coverage/${created.video.id}`, {
    method: 'PATCH', cookie: currentEditorCookie,
    body: {
      title: '',
      description: 'Updated synthetic description',
      influencerId: influencerIds[1],
      campaignId: deliveryCampaign.id
    }
  });
  assert.equal(updated.video.title, '');
  assert.equal(updated.video.description, 'Updated synthetic description');
  assert.equal(updated.video.influencerId, influencerIds[1]);
  assert.equal(updated.video.campaignId, deliveryCampaign.id);
  const movedCoverage = await mustCall(`/api/client-portal/showcases/${showcaseOffer.catalog.id}`, { cookie: currentClientCookie });
  assert.deepEqual(movedCoverage.coverageVideos, []);
  assert.equal((await mustCall(`/api/coverage?campaignId=${deliveryCampaign.id}&influencerId=${influencerIds[1]}`, {
    cookie: currentEditorCookie
  })).total, 1);
  const after = (await mustCall('/api/campaigns', { cookie: currentAdminCookie })).campaigns;
  const visitAfter = after.find((campaign) => campaign.id === visitCampaign.id);
  const deliveryAfter = after.find((campaign) => campaign.id === deliveryCampaign.id);
  assert.equal(visitAfter.coverageCount, visitBefore.coverageCount || 0);
  assert.equal(deliveryAfter.coverageCount, (deliveryBefore.coverageCount || 0) + 1);
  assert.deepEqual(visitAfter.schedules, visitBefore.schedules);
  assert.deepEqual(visitAfter.targets.map(({ id, coverageStatus, visitDate }) => ({ id, coverageStatus, visitDate })),
    visitBefore.targets.map(({ id, coverageStatus, visitDate }) => ({ id, coverageStatus, visitDate })));
  const deniedDelete = await call(`/api/coverage/${created.video.id}`, { method: 'DELETE', cookie: currentEditorCookie });
  assert.equal(deniedDelete.response.status, 403);
  const deleted = await mustCall(`/api/coverage/${created.video.id}`, { method: 'DELETE', cookie: currentAdminCookie });
  assert.equal(deleted.ok, true);
  const finalCampaign = (await mustCall('/api/campaigns', { cookie: currentAdminCookie })).campaigns.find((campaign) => campaign.id === visitCampaign.id);
  assert.equal(finalCampaign.coverageCount, visitBefore.coverageCount || 0);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM coverage_videos WHERE id = ?').get(created.video.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM influencers WHERE id = ?').get(coverageInfluencer.record.id).count, 1);
  db.close();
});

test('visit presentation links isolate advertiser data, visits, branding, and client logos', async () => {
  const currentAdminCookie = await login('portal-admin', 'Portal-admin-pass-2026!');
  const adminCall = (path, options = {}) => mustCall(path, { ...options, cookie: currentAdminCookie });
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const createLink = async ({ label, influencerId, campaignName, companyName, clientName, username, email, brandId, visitTime, city, branch, logoSeed }) => {
    const campaign = (await adminCall('/api/campaigns', { method: 'POST', body: {
      campaignName, companyName, campaignType: 'visit', serviceType: 'influencer',
      startDate: today, endDate: today,
      targets: [{ id: influencerId, visitDate: today, visitTime, visitCity: city, visitBranch: branch }]
    } })).campaign;
    const client = (await adminCall('/api/client-accounts', { method: 'POST', body: {
      username, email, clientName, companyName,
      password: `Synthetic-${label}-pass-2026!`, campaignIds: [campaign.id]
    } })).account;
    const logo = createPng(logoSeed);
    const presentation = await adminCall(`/api/campaigns/${campaign.id}/presentations`, { method: 'POST', body: {
      brandId, clientAccountId: client.id, influencerIds: [influencerId],
      fields: ['name', 'visitDate', 'visitTime', 'visitCity', 'visitBranch'],
      presentationMode: 'visits', headerTitle: `${label} Header Marker`,
      headerTagline: `${label} Tagline Marker`, packageVisitsCount: 1,
      displayOptions: {
        showInfluencerDetails: true, showSocialAccounts: true, showFollowers: true,
        showAdditionalDetails: true, showCompanyWork: false
      },
      companyWorkVideoIds: [], videoReferences: [],
      clientLogo: { mimeType: 'image/png', dataBase64: logo.toString('base64') }
    } });
    return { campaign, client, presentation, logo };
  };

  const alpha = await createLink({
    label: 'Alpha', influencerId: influencerIds[0],
    campaignName: 'Alpha Campaign Marker', companyName: 'Alpha Company Marker',
    clientName: 'Alpha Advertiser Marker', username: 'isolation-alpha-client',
    email: 'isolation-alpha@example.test', brandId: 'fkretk',
    visitTime: '09:17', city: 'Alpha City Marker', branch: 'Alpha Visit Marker', logoSeed: 53
  });
  const beta = await createLink({
    label: 'Beta', influencerId: influencerIds[1],
    campaignName: 'Beta Campaign Marker', companyName: 'Beta Company Marker',
    clientName: 'Beta Advertiser Marker', username: 'isolation-beta-client',
    email: 'isolation-beta@example.test', brandId: 'ryfaq',
    visitTime: '14:29', city: 'Beta City Marker', branch: 'Beta Visit Marker', logoSeed: 197
  });
  const readPublicData = async (presentation) => {
    const response = await fetch(`${baseUrl}/api/campaign-presentations/${presentation.token}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const alphaData = await readPublicData(alpha.presentation);
  const betaData = await readPublicData(beta.presentation);
  const alphaJson = JSON.stringify(alphaData);
  const betaJson = JSON.stringify(betaData);
  assert.equal(alphaData.targets.length, 1);
  assert.equal(betaData.targets.length, 1);
  assert.equal(alphaData.targets[0].name, 'Visit Creator');
  assert.equal(betaData.targets[0].name, 'Delivery Creator');
  assert.equal(alphaData.targets[0].visitTime, '09:17');
  assert.equal(betaData.targets[0].visitTime, '14:29');
  assert.equal(alphaData.campaign.clientCompany, 'Alpha Company Marker');
  assert.equal(betaData.campaign.clientCompany, 'Beta Company Marker');
  assert.equal(alphaData.presentation.title, 'Alpha Header Marker');
  assert.equal(betaData.presentation.title, 'Beta Header Marker');

  const linkMarkers = (data) => [
    data.campaign.name, data.campaign.clientCompany, data.presentation.title,
    data.presentation.tagline, data.targets[0].name, data.targets[0].visitCity,
    data.targets[0].visitBranch
  ].filter((value) => typeof value === 'string' && value);
  const brandMarkers = (data) => [data.brand.nameAr, data.brand.nameEn]
    .filter((value) => typeof value === 'string' && value);
  for (const marker of [...linkMarkers(betaData), ...brandMarkers(betaData)]) {
    assert.equal(alphaJson.includes(marker), false, `Alpha API leaked Beta marker: ${marker}`);
  }
  for (const marker of [...linkMarkers(alphaData), ...brandMarkers(alphaData)]) {
    assert.equal(betaJson.includes(marker), false, `Beta API leaked Alpha marker: ${marker}`);
  }
  assert.equal(alphaJson.includes(betaData.presentation.clientLogoUrl), false);
  assert.equal(betaJson.includes(alphaData.presentation.clientLogoUrl), false);

  const alphaLogoResponse = await fetch(`${baseUrl}${alphaData.presentation.clientLogoUrl}`);
  const betaLogoResponse = await fetch(`${baseUrl}${betaData.presentation.clientLogoUrl}`);
  assert.equal(alphaLogoResponse.status, 200);
  assert.equal(betaLogoResponse.status, 200);
  const alphaLogoBytes = Buffer.from(await alphaLogoResponse.arrayBuffer());
  const betaLogoBytes = Buffer.from(await betaLogoResponse.arrayBuffer());
  assert.deepEqual(alphaLogoBytes, alpha.logo);
  assert.deepEqual(betaLogoBytes, beta.logo);
  assert.notDeepEqual(alphaLogoBytes, betaLogoBytes);

  const browser = await chromium.launch({ headless: true });
  try {
    for (const [own, other, ownData, otherData] of [
      [alpha, beta, alphaData, betaData],
      [beta, alpha, betaData, alphaData]
    ]) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const pageResponse = await page.goto(`${baseUrl}${own.presentation.url}`, { waitUntil: 'domcontentloaded' });
      assert.equal(pageResponse.status(), 200);
      const html = await pageResponse.text();
      for (const marker of linkMarkers(otherData)) {
        assert.equal(html.includes(marker), false, `Presentation HTML leaked other-link marker: ${marker}`);
      }
      await page.locator('.visit-schedule').waitFor();
      const visibleText = await page.locator('body').innerText();
      assert.ok(visibleText.includes(ownData.presentation.title));
      assert.ok(visibleText.includes(ownData.campaign.clientCompany));
      assert.ok(visibleText.includes(ownData.targets[0].visitBranch));
      assert.ok(visibleText.includes(ownData.targets[0].name));
      for (const marker of linkMarkers(otherData)) {
        assert.equal(visibleText.includes(marker), false, `Presentation page leaked other-link marker: ${marker}`);
      }
      const visibleBranding = await page.locator('#visits-branding').innerText();
      for (const marker of brandMarkers(otherData)) {
        assert.equal(visibleBranding.includes(marker), false, `Presentation header leaked other-link brand: ${marker}`);
      }
      const clientLogo = page.locator('#client-brand-logo');
      assert.equal(await clientLogo.isVisible(), true);
      assert.equal(new URL(await clientLogo.getAttribute('src'), baseUrl).pathname, ownData.presentation.clientLogoUrl);
      await page.close();
    }

    await adminCall(`/api/campaigns/${beta.campaign.id}/presentations/${beta.presentation.id}`, {
      method: 'PATCH', body: { active: false }
    });
    const invalidToken = `${alpha.presentation.token.slice(0, -1)}${alpha.presentation.token.endsWith('A') ? 'B' : 'A'}`;
    for (const token of [invalidToken, beta.presentation.token]) {
      assert.equal((await fetch(`${baseUrl}/api/campaign-presentations/${token}`)).status, 404);
      assert.equal((await fetch(`${baseUrl}/api/campaign-presentations/${token}/client-logo`)).status, 404);
      const page = await browser.newPage();
      await page.goto(`${baseUrl}/campaign-presentation/${token}`, { waitUntil: 'domcontentloaded' });
      const notice = page.locator('#app .notice');
      await notice.waitFor();
      assert.match(await notice.innerText(), /غير متاح|unavailable/i);
      assert.equal(await page.locator('.visit-card').count(), 0);
      const visibleText = await page.locator('body').innerText();
      for (const marker of [...linkMarkers(alphaData), ...linkMarkers(betaData)]) {
        assert.equal(visibleText.includes(marker), false, `Unavailable link displayed presentation marker: ${marker}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('visit presentation day navigation follows Riyadh time across midnight and UTC 21:00', async () => {
  const currentAdminCookie = await login('portal-admin', 'Portal-admin-pass-2026!');
  const adminCall = (path, options = {}) => mustCall(path, { ...options, cookie: currentAdminCookie });
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const riyadhDay = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const nextDay = new Date(Date.parse(`${riyadhDay}T00:00:00Z`) + 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const campaign = (await adminCall('/api/campaigns', { method: 'POST', body: {
    campaignName: 'Riyadh Clock Boundary Campaign',
    companyName: 'Riyadh Clock Boundary Company',
    campaignType: 'visit', serviceType: 'influencer',
    startDate: riyadhDay, endDate: nextDay,
    targets: [
      { id: influencerIds[0], visitDate: riyadhDay, visitTime: '23:59', visitCity: 'Clock City', visitBranch: 'Before midnight' },
      { id: influencerIds[1], visitDate: nextDay, visitTime: '00:01', visitCity: 'Clock City', visitBranch: 'After midnight' }
    ]
  } })).campaign;
  const client = (await adminCall('/api/client-accounts', { method: 'POST', body: {
    username: 'riyadh-midnight-client', email: 'riyadh-midnight@example.test',
    clientName: 'Riyadh Midnight Client', companyName: 'Riyadh Midnight Company',
    password: 'Synthetic-Riyadh-midnight-2026!', campaignIds: [campaign.id]
  } })).account;
  const created = await adminCall(`/api/campaigns/${campaign.id}/presentations`, { method: 'POST', body: {
    brandId: 'fkretk', clientAccountId: client.id,
    influencerIds: [influencerIds[0], influencerIds[1]],
    fields: ['name', 'visitDate', 'visitTime', 'visitCity', 'visitBranch'],
    presentationMode: 'visits', headerTitle: 'Riyadh Midnight Schedule',
    headerTagline: '', packageVisitsCount: 2,
    displayOptions: {
      showInfluencerDetails: true, showSocialAccounts: true, showFollowers: true,
      showAdditionalDetails: true, showCompanyWork: false
    },
    companyWorkVideoIds: [], videoReferences: []
  } });

  const scenarios = [
    {
      instant: `${riyadhDay}T20:59:00.000Z`,
      localToday: riyadhDay,
      completed: 1,
      yesterday: [],
      today: ['Visit Creator'],
      tomorrow: ['Delivery Creator']
    },
    {
      instant: `${riyadhDay}T21:00:00.000Z`,
      localToday: nextDay,
      completed: 1,
      yesterday: ['Visit Creator'],
      today: ['Delivery Creator'],
      tomorrow: []
    },
    {
      instant: `${riyadhDay}T21:01:00.000Z`,
      localToday: nextDay,
      completed: 2,
      yesterday: ['Visit Creator'],
      today: ['Delivery Creator'],
      tomorrow: []
    }
  ];
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of scenarios) {
      await restartTestServerAt(scenario.instant);
      const apiResponse = await fetch(`${baseUrl}/api/campaign-presentations/${created.token}`);
      assert.equal(apiResponse.status, 200);
      const publicData = await apiResponse.json();
      assert.equal(publicData.presentation.packageVisitsCompleted, scenario.completed);
      assert.deepEqual(
        publicData.targets.map(({ name, visitDate, visitTime }) => ({ name, visitDate, visitTime })),
        [
          { name: 'Visit Creator', visitDate: riyadhDay, visitTime: '23:59' },
          { name: 'Delivery Creator', visitDate: nextDay, visitTime: '00:01' }
        ]
      );

      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.clock.install({ time: new Date(scenario.instant) });
      await page.goto(`${baseUrl}${created.url}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.visit-schedule').waitFor();
      const shortcuts = page.locator('.visit-date-shortcut');
      assert.equal(await shortcuts.count(), 3);
      assert.equal(await shortcuts.nth(1).getAttribute('aria-pressed'), 'true');
      const expectedDates = [scenario.yesterday, scenario.today, scenario.tomorrow];
      for (let index = 0; index < expectedDates.length; index += 1) {
        await shortcuts.nth(index).click();
        const cards = page.locator('.visit-card');
        assert.deepEqual(await cards.locator('.identity strong').allTextContents(), expectedDates[index]);
        if (expectedDates[index].length) {
          const expectedTime = expectedDates[index][0] === 'Visit Creator' ? '23:59' : '00:01';
          assert.ok((await page.locator('.date-group h3').allTextContents()).includes(expectedTime));
        }
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
