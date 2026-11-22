import http from 'node:http';
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { openSQLiteDatabase } from './data-access/sqlite.mjs';
import { createInfluencerPhotoTemplate, createXlsxWorkbook, validateXlsxWorkbook } from './data-access/xlsx-workbook.mjs';
import { runInNewContext } from 'node:vm';
import { inflateRawSync } from 'node:zlib';
import { requestAddress as getRequestAddress } from './security/request-address.mjs';

const projectDir = dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) process.umask(0o077);
const dataDir = resolve(process.env.FIKRATAK_DATA_DIR || resolve(projectDir, 'data'));
const databasePath = resolve(dataDir, 'fikratak.sqlite');
const backupDir = resolve(process.env.FIKRATAK_BACKUP_DIR || resolve(dataDir, 'backups'));
const backupRetentionCount = 30;
const influencerExcelFileName = 'Fikratak_Influencers.xlsx';
const influencerExcelPath = resolve(backupDir, influencerExcelFileName);
const influencerExcelStatusPath = resolve(backupDir, 'Fikratak_Influencers.status.json');
const influencerExcelLockPath = resolve(backupDir, '.Fikratak_Influencers.xlsx.lock');
const port = Number(process.env.PORT || 8765);
const host = String(process.env.FIKRATAK_HOST || '127.0.0.1').trim();
const setupToken = process.env.FIKRATAK_SETUP_TOKEN || '';
const setupTokenExpiresAt = setupToken ? Date.now() + 30 * 60 * 1000 : 0;
function positiveIntegerEnvironmentVariable(name, defaultValue) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue === '') return defaultValue;
  const value = Number(rawValue);
  if (!/^\d+$/.test(rawValue) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}
const loginMaxAttempts = positiveIntegerEnvironmentVariable('FIKRATAK_LOGIN_MAX_ATTEMPTS', 6);
const loginLockoutMinutes = positiveIntegerEnvironmentVariable('FIKRATAK_LOGIN_LOCKOUT_MINUTES', 10);
const productionImportEnabled = process.env.FIKRATAK_IMPORT_ENABLED === '1';
const allowedOrigins = new Set((process.env.FIKRATAK_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => {
    const origin = new URL(value);
    if (origin.origin === 'null' || origin.pathname !== '/' || origin.search || origin.hash
      || (isProduction && origin.protocol !== 'https:')) {
      throw new Error('FIKRATAK_ALLOWED_ORIGINS must contain only valid HTTPS origins in production.');
    }
    return origin.origin;
  }));
const trustedProxies = new Set((process.env.FIKRATAK_TRUSTED_PROXIES || '')
  .split(',')
  .map((value) => value.trim().replace(/^::ffff:/, ''))
  .filter(Boolean));
if ([...trustedProxies].some((address) => !isIP(address))) {
  throw new Error('FIKRATAK_TRUSTED_PROXIES must contain comma-separated IP addresses.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
if (!host) throw new Error('FIKRATAK_HOST must not be empty.');
if (isProduction && setupToken && Buffer.byteLength(setupToken, 'utf8') < 32) {
  throw new Error('FIKRATAK_SETUP_TOKEN must contain at least 32 bytes in production.');
}
const secureCookieAttribute = isProduction ? '; Secure' : '';
function logFailure(context, error) {
  const name = typeof error?.name === 'string' ? error.name : 'Error';
  const code = typeof error?.code === 'string' ? ` [${error.code}]` : '';
  console.error(`${context}: ${name}${code}`);
}
function isWithinProjectDirectory(path) {
  const pathFromProject = relative(projectDir, resolve(path));
  return pathFromProject === '' || (pathFromProject !== '..'
    && !pathFromProject.startsWith(`..${sep}`) && !isAbsolute(pathFromProject));
}
if (isProduction) {
  for (const [name, path] of [
    ['FIKRATAK_DATA_DIR', process.env.FIKRATAK_DATA_DIR],
    ['FIKRATAK_BACKUP_DIR', process.env.FIKRATAK_BACKUP_DIR]
  ]) {
    if (!path || !isAbsolute(path) || isWithinProjectDirectory(path)) {
      throw new Error(`${name} must be an absolute path outside the application directory in production.`);
    }
  }
  if (!allowedOrigins.size) throw new Error('FIKRATAK_ALLOWED_ORIGINS must contain the HTTPS application origin in production.');
}
const passwordMinLength = 12;
const passwordMaxLength = 128;
const passwordResetExpiryMs = 10 * 60 * 1000;
const sessionDurationMs = 8 * 60 * 60 * 1000;
const companyIdentity = Object.freeze({
  nameAr: 'فكرتك الرقمية',
  nameEn: 'FKRETK Digital',
  email: 'fkretkinfluencer1@gmail.com'
});
const defaultBrandSettings = Object.freeze({
  fkretk: {
    id: 'fkretk', nameAr: 'فكرتك', nameEn: 'FKRETK',
    primaryColor: '#2D82C4', secondaryColor: '#FFFFFF', accentColor: '#F78E1E',
    logoPath: '/assets/fikratak-digital-logo.png', logoMode: 'image',
    contactEmail: companyIdentity.email, template: 'fkretk-v1'
  },
  ryfaq: {
    id: 'ryfaq', nameAr: 'رفاق', nameEn: 'Ryfaq',
    primaryColor: '#427E60', secondaryColor: '#FFFFFF', accentColor: '#427E60',
    logoPath: '', logoMode: 'text-placeholder', contactEmail: '', template: 'ryfaq-v1'
  }
});
const scryptAsync = promisify(scrypt);
const sessions = new Map();
const clientSessions = new Map();
const catalogImportPreviews = new Map();
const visitImportPreviews = new Map();
const influencerPhotoPreviews = new Map();
const influencerImportPreviews = new Map();
const loginAttempts = new Map();
const resetAttempts = new Map();
const auditResponseContexts = new WeakMap();
const auditRequestBodies = new WeakMap();
const roles = new Set(['admin', 'editor', 'viewer']);
const clientDisplayModes = new Set(['prospective', 'selecting', 'existing']);
const visitFieldKeys = [
  'visitDate', 'visitTime', 'visitCity', 'visitBranch', 'visitAddress',
  'visitStatus', 'visitNotes', 'coverageStatus', 'coverageNotes'
];
const deliveryFieldKeys = [
  'recipientName', 'recipientPhone', 'courierContact', 'deliveryCity', 'deliveryDistrict',
  'deliveryAddress', 'deliveryMapLink', 'orderDetails', 'shippingStatus', 'shippingCarrier',
  'trackingNumber', 'deliveryDate', 'deliveryNotes', 'coverageStatus'
];
const portalTemplates = new Set(['request-approval', 'visit-schedule', 'delivery-campaign', 'campaign-report', 'custom-view']);
const portalSections = new Set(['requestApproval', 'visitSchedule', 'deliveryCampaign', 'campaignReport']);
const portalFieldKeys = {
  requestApproval: ['name', 'username', 'platform', 'accountLink', 'followers', 'price', 'campaignNotes', 'decision'],
  visitSchedule: ['name', 'username', ...visitFieldKeys],
  deliveryCampaign: ['name', 'username', ...deliveryFieldKeys],
  campaignReport: ['campaignSummary', 'targetCount', 'coverageSummary', 'visitSummary', 'deliverySummary']
};
const portalDefaultFields = {
  requestApproval: ['name', 'username', 'platform', 'followers', 'decision'],
  visitSchedule: ['name', 'username', 'visitDate', 'visitTime', 'visitCity', 'visitBranch', 'visitStatus', 'coverageStatus'],
  deliveryCampaign: ['name', 'username', 'recipientName', 'deliveryCity', 'deliveryDistrict', 'orderDetails', 'shippingStatus', 'deliveryDate'],
  campaignReport: ['campaignSummary', 'targetCount', 'coverageSummary', 'visitSummary', 'deliverySummary']
};
const defaultPortalActions = Object.freeze({
  allowDecisions: true, allowRevert: true, allowVisitConfirmation: false,
  allowVisitChangeRequest: false, allowShippingFollowUp: false
});
const shippingStatuses = new Set(['pending_preparation', 'ready', 'shipped', 'delivered', 'failed']);
const visitStatuses = new Set(['pending_confirmation', 'confirmed', 'completed', 'cancelled']);
const defaultCampaignVisibility = Object.freeze({
  visit: Object.fromEntries(visitFieldKeys.map((field) => [field, true])),
  delivery: Object.fromEntries(deliveryFieldKeys.map((field) => [field, true]))
});
const backupStatus = { state: 'pending', lastAttemptAt: '', lastSuccessAt: '', lastFile: '', lastError: '' };
let backupInProgress = false;
let influencerExcelInProgress = false;
let influencerExcelStatusLoaded = false;
const influencerExcelStatus = { state: 'pending', lastAttemptAt: '', lastSuccessAt: '', recordCount: 0, lastError: '', sourceHash: '' };

await mkdir(dataDir, { recursive: true, mode: 0o700 });
const database = openSQLiteDatabase(databasePath);
const executeDatabaseSql = database.exec.bind(database);
let apiTransaction = null;
let apiSavepointCounter = 0;
let apiRequestQueue = Promise.resolve();
database.exec = (statement) => {
  const command = String(statement).trim().toUpperCase();
  if (!apiTransaction) return executeDatabaseSql(statement);
  if (/^BEGIN(?:\s+IMMEDIATE|\s+EXCLUSIVE|\s+DEFERRED)?$/.test(command)) {
    const name = `api_nested_${++apiSavepointCounter}`;
    executeDatabaseSql(`SAVEPOINT ${name}`);
    apiTransaction.savepoints.push(name);
    return;
  }
  if (command === 'COMMIT') {
    const name = apiTransaction.savepoints.pop();
    executeDatabaseSql(name ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
    return;
  }
  if (command === 'ROLLBACK') {
    const name = apiTransaction.savepoints.pop();
    executeDatabaseSql(name
      ? `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`
      : 'ROLLBACK');
    return;
  }
  return executeDatabaseSql(statement);
};
async function acquireApiRequestLock() {
  let release;
  const previous = apiRequestQueue;
  apiRequestQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  return release;
}
const locationContext = {};
runInNewContext(await readFile(resolve(projectDir, 'assets/country-locations.js'), 'utf8'), locationContext);
const locationData = locationContext.FikratakLocationData;
const followerTierContext = {};
runInNewContext(await readFile(resolve(projectDir, 'assets/follower-tiers.js'), 'utf8'), followerTierContext);
const followerTierRules = followerTierContext.FikratakFollowerTiers;
const influencerFieldOptionsContext = {};
runInNewContext(await readFile(resolve(projectDir, 'assets/influencer-field-options.js'), 'utf8'), influencerFieldOptionsContext);
const influencerFieldOptions = influencerFieldOptionsContext.FikratakInfluencerFieldOptions;
const interestByNormalizedName = new Map(influencerFieldOptions.interests.map((value) => [value.toLocaleLowerCase('en-US'), value]));
interestByNormalizedName.set('blogging', 'Bloging');
function normalizeInterestKey(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}
function refreshInterestNames(names) {
  interestByNormalizedName.clear();
  for (const name of names) {
    const key = normalizeInterestKey(name);
    if (key) interestByNormalizedName.set(key, String(name).normalize('NFKC').trim().replace(/\s+/gu, ' '));
  }
  const bloging = interestByNormalizedName.get('bloging');
  if (bloging) interestByNormalizedName.set('blogging', bloging);
}
const arabicDigits = '٠١٢٣٤٥٦٧٨٩';
const parseFollowerValue = (value) => followerTierRules.parse(value);
const followerTiers = followerTierRules.tiers;
const followerTierFromCount = (value) => followerTierRules.classify(value);
const followerPlatformFields = Object.freeze({
  Instagram: { username: 'Username I', followers: 'Followers Count I' },
  TikTok: { username: 'Username T', followers: 'Followers Count T' },
  Snapchat: { username: 'Username', followers: 'Followers Count S' }
});
const mainPlatformPriority = Object.freeze([
  { platform: 'TikTok', username: 'Username T', followers: 'Followers Count T' },
  { platform: 'Instagram', username: 'Username I', followers: 'Followers Count I' },
  { platform: 'Snapchat', username: 'Username', followers: 'Followers Count S' }
]);
function deriveMainAccountFields(record, fallback = null) {
  let selected = null;
  for (const account of mainPlatformPriority) {
    const followers = parseImportedFollowerCount(record[account.followers]);
    if (followers !== null && (!selected || followers > selected.followers)) {
      selected = { ...account, followers };
    }
  }
  if (selected) {
    record['Best Platform'] = selected.platform;
    record.Main_Username = String(record[selected.username] ?? '').trim();
  } else if (fallback) {
    record['Best Platform'] = String(fallback['Best Platform'] || '');
    record.Main_Username = String(fallback.Main_Username || '').trim();
  }
  return record;
}
function parseManualFollowerCount(value) {
  const normalized = String(value ?? '').trim()
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[٬,\s]/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const count = Number(normalized);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}
function parseImportedFollowerCount(value) {
  const count = parseFollowerValue(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}
function deriveInfluencerFields(record) {
  const accounts = [
    { followers: 'Followers Count T', type: 'Influencer Type T' },
    { followers: 'Followers Count I', type: 'Influencer Type I' },
    { followers: 'Followers Count S', type: 'Influencer Type S' }
  ];
  for (const account of accounts) {
    record[account.type] = followerTierFromCount(record[account.followers]);
  }
  record['Overall Influencer Type'] = followerTier(
    record['Followers Count I'], record['Followers Count T'], record['Followers Count S']
  );
  return record;
}
function followerTier(...values) {
  return followerTierRules.highest(values);
}
function splitInterestValues(value) {
  let values = Array.isArray(value) ? value : [value];
  if (values.length === 1 && typeof values[0] === 'string' && values[0].trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(values[0]);
      if (Array.isArray(parsed)) values = parsed;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return values.flatMap((item) => String(item ?? '').split(/[,،;؛|\r\n]+/))
    .map((item) => item.trim()).filter(Boolean);
}
function canonicalizeInterests(values) {
  const interests = [];
  const unmapped = [];
  for (const value of splitInterestValues(values)) {
    const canonical = interestByNormalizedName.get(normalizeInterestKey(value));
    if (canonical) {
      if (!interests.includes(canonical)) interests.push(canonical);
    } else if (!unmapped.includes(value)) {
      unmapped.push(value);
    }
  }
  return { interests, unmapped };
}
function canonicalYesNo(value) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase('en-US');
  if (value === true || ['yes', 'y', 'true', '1', 'نعم', 'اجل', 'أجل'].includes(normalized)) return 'Yes';
  if (value === false || ['no', 'n', 'false', '0', 'لا', 'كلا'].includes(normalized)) return 'No';
  return '';
}
function canonicalLanguage(value) {
  const normalized = String(value ?? '').trim().normalize('NFKC').toLocaleLowerCase('en-US');
  if (['arabic', 'العربية', 'عربي', 'ar'].includes(normalized)) return 'Arabic';
  if (['english', 'الانجليزية', 'الإنجليزية', 'إنجليزي', 'انجليزي', 'en'].includes(normalized)) return 'English';
  return '';
}
function normalizeFilter(field, value) {
  let normalized = String(value ?? '').trim().toLocaleLowerCase();
  if (field === 'Country') return locationData.countryByName(value)?.iso || normalized;
  normalized = normalized.normalize('NFKD').replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/\s+/g, ' ');
  if (['Face Appearance', 'Speak', 'Verified', 'Mawthouq', 'Content Update'].includes(field)) {
    const answer = canonicalYesNo(value);
    if (answer) return answer.toLocaleLowerCase('en-US');
  }
  if (field === 'language') return canonicalLanguage(value).toLocaleLowerCase('en-US') || normalized;
  if (field === 'Gender') {
    if (['male', 'ذكر'].includes(normalized)) return 'male';
    if (['female', 'انثى'].includes(normalized)) return 'female';
  }
  if (field === 'Paid or Voucher') {
    if (['paid', 'مدفوع'].includes(normalized)) return 'paid';
    if (['voucher', 'coupon', 'قسيمة'].includes(normalized)) return 'voucher';
    if (['cash', 'نقدي'].includes(normalized)) return 'cash';
  }
  return normalized;
}
function normalizeWorkflow(value) {
  const normalized = String(value ?? '').trim().toLocaleLowerCase('en-US');
  const aliases = {
    '': 'new', new: 'new', review: 'reviewed', reviewed: 'reviewed', shortlist: 'shortlisted',
    shortlisted: 'shortlisted', reject: 'rejected', rejected: 'rejected', approve: 'approved',
    approved: 'approved', archive: 'archived', archived: 'archived', جديد: 'new',
    'تمت المراجعة': 'reviewed', 'مُختار': 'shortlisted', مختار: 'shortlisted',
    مرفوض: 'rejected', 'موافق عليه': 'approved', مؤرشف: 'archived'
  };
  return aliases[normalized] || normalized;
}
function normalizePhoneDigits(value) {
  const western = String(value ?? '')
    .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
  return western.replace(/\D/g, '');
}
database.function('country_iso', { deterministic: true }, (value) => locationData.countryByName(value)?.iso || '');
database.function('normalized_filter', { deterministic: true }, normalizeFilter);
database.function('follower_tier', { deterministic: true, varargs: true }, followerTier);
database.function('follower_count', { deterministic: true }, (value) => parseFollowerValue(value) ?? -1);
database.function('workflow_status', { deterministic: true }, normalizeWorkflow);
database.function('phone_digits', { deterministic: true }, normalizePhoneDigits);
database.function('account_username', { deterministic: true }, (value) => normalizedImportUsername(value));
function ensureUserColumns() {
  const columns = database.prepare('PRAGMA table_info(users)').all();
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('email')) {
    database.exec('ALTER TABLE users ADD COLUMN email TEXT');
  }
  if (!names.has('updated_at')) {
    database.exec('ALTER TABLE users ADD COLUMN updated_at TEXT');
  }
}
function ensureResetTokenTable() {
  const columns = database.prepare('PRAGMA table_info(password_reset_tokens)').all();
  if (!columns.length) {
    database.exec(`
      CREATE TABLE password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON password_reset_tokens(user_id, expires_at);
    `);
  }
}
function ensureCatalogSettingColumns() {
  const columns = database.prepare('PRAGMA table_info(client_catalogs)').all();
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('show_city')) {
    database.exec('ALTER TABLE client_catalogs ADD COLUMN show_city INTEGER NOT NULL DEFAULT 1');
  }
  if (!names.has('show_category')) {
    database.exec('ALTER TABLE client_catalogs ADD COLUMN show_category INTEGER NOT NULL DEFAULT 1');
  }
  if (!names.has('show_details')) {
    database.exec('ALTER TABLE client_catalogs ADD COLUMN show_details INTEGER NOT NULL DEFAULT 0');
  }
  if (!names.has('show_company_work')) {
    database.exec('ALTER TABLE client_catalogs ADD COLUMN show_company_work INTEGER NOT NULL DEFAULT 0');
  }
  if (!names.has('expires_at')) database.exec('ALTER TABLE client_catalogs ADD COLUMN expires_at TEXT');
  database.exec(`
    CREATE TABLE IF NOT EXISTS client_catalog_access_events (
      id INTEGER PRIMARY KEY,
      catalog_id TEXT NOT NULL REFERENCES client_catalogs(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN ('view', 'expired', 'unavailable')),
      accessed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_client_catalog_access_events_catalog
      ON client_catalog_access_events(catalog_id, accessed_at DESC);
  `);
}
function ensureCampaignColumns() {
  const columns = database.prepare('PRAGMA table_info(campaigns)').all();
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('service_type')) database.exec("ALTER TABLE campaigns ADD COLUMN service_type TEXT NOT NULL DEFAULT 'influencer'");
  if (!names.has('start_date')) database.exec('ALTER TABLE campaigns ADD COLUMN start_date TEXT');
  if (!names.has('end_date')) database.exec('ALTER TABLE campaigns ADD COLUMN end_date TEXT');
  const targetColumns = new Set(database.prepare('PRAGMA table_info(campaign_targets)').all().map((column) => column.name));
  if (!targetColumns.has('visit_date')) database.exec('ALTER TABLE campaign_targets ADD COLUMN visit_date TEXT');
  if (!targetColumns.has('shipping_status')) database.exec("ALTER TABLE campaign_targets ADD COLUMN shipping_status TEXT NOT NULL DEFAULT 'not_shipped'");
  if (!targetColumns.has('coverage_status')) database.exec("ALTER TABLE campaign_targets ADD COLUMN coverage_status TEXT NOT NULL DEFAULT 'pending'");
  if (!targetColumns.has('checkin_token')) database.exec('ALTER TABLE campaign_targets ADD COLUMN checkin_token TEXT');
  if (!targetColumns.has('visited_at')) database.exec('ALTER TABLE campaign_targets ADD COLUMN visited_at TEXT');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_targets_checkin ON campaign_targets(checkin_token) WHERE checkin_token IS NOT NULL');
  database.exec(`
    UPDATE campaigns SET
      start_date = COALESCE(start_date, (SELECT substr(MIN(scheduled_at), 1, 10) FROM campaign_schedule WHERE campaign_id = campaigns.id), date('now')),
      end_date = COALESCE(end_date, (SELECT substr(MAX(scheduled_at), 1, 10) FROM campaign_schedule WHERE campaign_id = campaigns.id), date('now'));
    UPDATE campaign_targets SET
      checkin_token = COALESCE(checkin_token, lower(hex(randomblob(24)))),
      visit_date = COALESCE(visit_date,
        (SELECT substr(MIN(scheduled_at), 1, 10) FROM campaign_schedule WHERE campaign_id = campaign_targets.campaign_id),
        (SELECT start_date FROM campaigns WHERE id = campaign_targets.campaign_id));
  `);
}
function ensureClientPortalSchema() {
  database.exec('BEGIN IMMEDIATE');
  try {
    const targetColumns = new Set(database.prepare('PRAGMA table_info(campaign_targets)').all().map((column) => column.name));
    for (const [name, definition] of [
      ['visit_location', 'TEXT'],
      ['visit_time', 'TEXT'],
      ['visit_city', 'TEXT'],
      ['visit_branch', 'TEXT'],
      ['visit_address', 'TEXT'],
      ['visit_status', "TEXT NOT NULL DEFAULT 'pending_confirmation'"],
      ['visit_notes', 'TEXT'],
      ['coverage_notes', 'TEXT'],
      ['delivery_recipient_name', 'TEXT'],
      ['delivery_recipient_phone', 'TEXT'],
      ['delivery_courier_contact', 'TEXT'],
      ['delivery_city', 'TEXT'],
      ['delivery_district', 'TEXT'],
      ['delivery_address', 'TEXT'],
      ['delivery_map_link', 'TEXT'],
      ['delivery_order_details', 'TEXT'],
      ['delivery_notes', 'TEXT'],
      ['shipping_carrier', 'TEXT'],
      ['tracking_number', 'TEXT'],
      ['delivery_date', 'TEXT'],
      ['execution_type', "TEXT NOT NULL DEFAULT 'visit'"],
      ['contact_status', "TEXT NOT NULL DEFAULT 'not_contacted'"],
      ['participation_status', "TEXT NOT NULL DEFAULT 'pending'"],
      ['campaign_price', "TEXT NOT NULL DEFAULT ''"],
      ['operations_notes', "TEXT NOT NULL DEFAULT ''"],
      ['after_confirmation', "TEXT NOT NULL DEFAULT ''"]
    ]) {
      if (!targetColumns.has(name)) database.exec(`ALTER TABLE campaign_targets ADD COLUMN ${name} ${definition}`);
    }
    const campaignColumns = new Set(database.prepare('PRAGMA table_info(campaigns)').all().map((column) => column.name));
    if (!campaignColumns.has('field_visibility')) database.exec("ALTER TABLE campaigns ADD COLUMN field_visibility TEXT NOT NULL DEFAULT '{}'");
    const addExecutionMode = !campaignColumns.has('execution_mode');
    if (addExecutionMode) database.exec("ALTER TABLE campaigns ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'visit'");
    if (!campaignColumns.has('qr_enabled')) database.exec('ALTER TABLE campaigns ADD COLUMN qr_enabled INTEGER NOT NULL DEFAULT 1');
    const catalogColumns = new Set(database.prepare('PRAGMA table_info(client_catalogs)').all().map((column) => column.name));
    if (catalogColumns.size) {
      if (!catalogColumns.has('offer_name')) database.exec("ALTER TABLE client_catalogs ADD COLUMN offer_name TEXT NOT NULL DEFAULT ''");
      if (!catalogColumns.has('offer_status')) database.exec("ALTER TABLE client_catalogs ADD COLUMN offer_status TEXT NOT NULL DEFAULT 'published'");
      if (!catalogColumns.has('portal_linked')) database.exec('ALTER TABLE client_catalogs ADD COLUMN portal_linked INTEGER NOT NULL DEFAULT 0');
      if (!catalogColumns.has('updated_at')) database.exec('ALTER TABLE client_catalogs ADD COLUMN updated_at TEXT');
      database.exec("UPDATE client_catalogs SET offer_name = company_name WHERE trim(offer_name) = ''");
      database.exec('UPDATE client_catalogs SET updated_at = COALESCE(updated_at, created_at)');
    }
    const accountColumns = new Set(database.prepare('PRAGMA table_info(client_accounts)').all().map((column) => column.name));
    if (accountColumns.size) {
      if (!accountColumns.has('portal_config')) database.exec("ALTER TABLE client_accounts ADD COLUMN portal_config TEXT NOT NULL DEFAULT '{}'");
      if (!accountColumns.has('portal_status')) database.exec("ALTER TABLE client_accounts ADD COLUMN portal_status TEXT NOT NULL DEFAULT 'published'");
      if (!accountColumns.has('client_type')) database.exec("ALTER TABLE client_accounts ADD COLUMN client_type TEXT NOT NULL DEFAULT 'current'");
      if (!accountColumns.has('email')) database.exec('ALTER TABLE client_accounts ADD COLUMN email TEXT');
      if (!accountColumns.has('internal_notes')) database.exec("ALTER TABLE client_accounts ADD COLUMN internal_notes TEXT NOT NULL DEFAULT ''");
      if (!accountColumns.has('display_mode')) {
        database.exec("ALTER TABLE client_accounts ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'selecting' CHECK (display_mode IN ('prospective', 'selecting', 'existing'))");
        // Preserve the existing prospective read-only behavior. Legacy current accounts
        // keep their decision-enabled behavior as selecting.
        database.exec("UPDATE client_accounts SET display_mode = CASE WHEN client_type = 'prospective' THEN 'prospective' ELSE 'selecting' END");
      }
    }
    if (addExecutionMode) database.exec('UPDATE campaigns SET execution_mode = campaign_type');
    if (!targetColumns.has('execution_type')) {
      database.exec('UPDATE campaign_targets SET execution_type = (SELECT c.execution_mode FROM campaigns c WHERE c.id = campaign_targets.campaign_id)');
    }
    database.exec(`
      UPDATE campaign_targets SET execution_type = (
        SELECT c.execution_mode FROM campaigns c WHERE c.id = campaign_targets.campaign_id
      )
      WHERE campaign_id IN (SELECT id FROM campaigns WHERE execution_mode IN ('visit', 'delivery'))
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS client_accounts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        email TEXT,
        client_name TEXT NOT NULL,
        company_name TEXT NOT NULL,
        internal_notes TEXT NOT NULL DEFAULT '',
        client_type TEXT NOT NULL DEFAULT 'current' CHECK (client_type IN ('prospective', 'current')),
        display_mode TEXT NOT NULL DEFAULT 'selecting' CHECK (display_mode IN ('prospective', 'selecting', 'existing')),
        salt TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        portal_config TEXT NOT NULL DEFAULT '{}',
        portal_status TEXT NOT NULL DEFAULT 'published' CHECK (portal_status IN ('draft', 'published')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS client_portal_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        config_json TEXT NOT NULL,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS client_account_campaigns (
        account_id TEXT NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, campaign_id)
      );
      CREATE INDEX IF NOT EXISTS idx_client_account_campaigns_campaign
        ON client_account_campaigns(campaign_id, account_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_client_accounts_email_unique
        ON client_accounts(email COLLATE NOCASE) WHERE email IS NOT NULL AND trim(email) <> '';
      CREATE TABLE IF NOT EXISTS client_account_activity (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_username TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_client_account_activity_account
        ON client_account_activity(account_id, created_at);
      CREATE TABLE IF NOT EXISTS client_showcase_feedback (
        account_id TEXT NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
        catalog_id TEXT NOT NULL REFERENCES client_catalogs(id) ON DELETE CASCADE,
        influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
        comment TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, catalog_id, influencer_id)
      );
      CREATE INDEX IF NOT EXISTS idx_client_showcase_feedback_account
        ON client_showcase_feedback(account_id, updated_at);
      CREATE TABLE IF NOT EXISTS client_account_catalogs (
        account_id TEXT NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
        catalog_id TEXT NOT NULL REFERENCES client_catalogs(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (account_id, catalog_id),
        UNIQUE (catalog_id)
      );
      CREATE INDEX IF NOT EXISTS idx_client_account_catalogs_catalog
        ON client_account_catalogs(catalog_id, account_id);
      CREATE TABLE IF NOT EXISTS client_catalog_decision_history (
        id TEXT PRIMARY KEY,
        catalog_id TEXT NOT NULL REFERENCES client_catalogs(id) ON DELETE CASCADE,
        influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
        client_account_id TEXT REFERENCES client_accounts(id) ON DELETE SET NULL,
        actor_label TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL CHECK (event_type IN ('accepted', 'rejected', 'reverted')),
        previous_decision TEXT CHECK (previous_decision IS NULL OR previous_decision IN ('accepted', 'rejected')),
        decision TEXT CHECK (decision IS NULL OR decision IN ('accepted', 'rejected')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_client_catalog_decision_history_target
        ON client_catalog_decision_history(catalog_id, influencer_id, created_at);
      CREATE TABLE IF NOT EXISTS campaign_checkin_history (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL CHECK (action_type IN ('visit', 'coverage')),
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        actor_username TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE (campaign_id, influencer_id, action_type)
      );
      CREATE TABLE IF NOT EXISTS campaign_target_decisions (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        influencer_id TEXT NOT NULL,
        client_account_id TEXT NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
        decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (client_account_id, campaign_id, influencer_id),
        FOREIGN KEY (campaign_id, influencer_id)
          REFERENCES campaign_targets(campaign_id, influencer_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS client_decision_history (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        influencer_id TEXT NOT NULL,
        client_account_id TEXT REFERENCES client_accounts(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('accepted', 'rejected', 'reverted')),
        previous_decision TEXT CHECK (previous_decision IS NULL OR previous_decision IN ('accepted', 'rejected')),
        decision TEXT CHECK (decision IS NULL OR decision IN ('accepted', 'rejected')),
        created_at TEXT NOT NULL,
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
        FOREIGN KEY (influencer_id) REFERENCES influencers(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_client_decision_history_target
        ON client_decision_history(campaign_id, influencer_id, created_at);
      CREATE TABLE IF NOT EXISTS client_decision_requests (
        client_account_id TEXT NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        influencer_id TEXT NOT NULL,
        result_decision TEXT NOT NULL CHECK (result_decision IN ('accepted', 'rejected', 'pending')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (client_account_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS client_campaign_actions (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
        client_account_id TEXT NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL CHECK (action_type IN ('visit_confirmed', 'visit_change_requested', 'shipping_followup')),
        details TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        FOREIGN KEY (campaign_id, influencer_id)
          REFERENCES campaign_targets(campaign_id, influencer_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_client_campaign_actions_target
        ON client_campaign_actions(campaign_id, influencer_id, created_at);
      CREATE TABLE IF NOT EXISTS client_visit_schedules (
        id TEXT PRIMARY KEY,
        client_account_id TEXT NOT NULL UNIQUE REFERENCES client_accounts(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        published_at TEXT
      );
      CREATE TABLE IF NOT EXISTS client_visits (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES client_visit_schedules(id) ON DELETE CASCADE,
        influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
        visit_date TEXT NOT NULL,
        visit_time TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT '',
        branch TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (schedule_id, influencer_id)
      );
      CREATE INDEX IF NOT EXISTS idx_client_visits_schedule_date
        ON client_visits(schedule_id, visit_date, visit_time);
    `);
    database.exec(`
      CREATE TABLE IF NOT EXISTS campaign_workspaces (
        campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
        content_json TEXT NOT NULL DEFAULT '{}',
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS campaign_briefs (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        client_account_id TEXT REFERENCES client_accounts(id) ON DELETE SET NULL,
        advertiser_name TEXT NOT NULL DEFAULT '',
        content_json TEXT NOT NULL DEFAULT '{}',
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_briefs_campaign
        ON campaign_briefs(campaign_id, created_at);
      DROP INDEX IF EXISTS idx_campaign_briefs_campaign_account;
      CREATE TABLE IF NOT EXISTS campaign_advertiser_notes (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        client_account_id TEXT REFERENCES client_accounts(id) ON DELETE SET NULL,
        advertiser_key TEXT NOT NULL,
        advertiser_name TEXT NOT NULL DEFAULT '',
        note_text TEXT NOT NULL DEFAULT '',
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (campaign_id, advertiser_key)
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_advertiser_notes_campaign
        ON campaign_advertiser_notes(campaign_id, updated_at);
      CREATE TABLE IF NOT EXISTS campaign_influencer_notes (
        campaign_id TEXT NOT NULL,
        influencer_id TEXT NOT NULL,
        note_text TEXT NOT NULL DEFAULT '',
        updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (campaign_id, influencer_id),
        FOREIGN KEY (campaign_id, influencer_id)
          REFERENCES campaign_targets(campaign_id, influencer_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS campaign_internal_files (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('attachment', 'evidence')),
        platform TEXT,
        phase TEXT,
        capture_date TEXT,
        note TEXT NOT NULL DEFAULT '',
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_data BLOB NOT NULL,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_internal_files_campaign
        ON campaign_internal_files(campaign_id, kind, created_at);
      CREATE TABLE IF NOT EXISTS campaign_presentations (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        client_account_id TEXT NOT NULL REFERENCES client_accounts(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        fields_json TEXT NOT NULL DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_presentations_campaign
        ON campaign_presentations(campaign_id, created_at);
      CREATE TABLE IF NOT EXISTS campaign_presentation_targets (
        presentation_id TEXT NOT NULL REFERENCES campaign_presentations(id) ON DELETE CASCADE,
        campaign_id TEXT NOT NULL,
        influencer_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (presentation_id, influencer_id),
        FOREIGN KEY (campaign_id, influencer_id)
          REFERENCES campaign_targets(campaign_id, influencer_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS campaign_presentation_videos (
        id TEXT PRIMARY KEY,
        presentation_id TEXT NOT NULL REFERENCES campaign_presentations(id) ON DELETE CASCADE,
        youtube_video_id TEXT NOT NULL,
        video_url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        UNIQUE (presentation_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_campaign_presentation_videos_presentation
        ON campaign_presentation_videos(presentation_id, position);
      CREATE TABLE IF NOT EXISTS company_work_videos (
        id TEXT PRIMARY KEY,
        youtube_video_id TEXT NOT NULL UNIQUE,
        video_url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS campaign_presentation_display_options (
        presentation_id TEXT PRIMARY KEY REFERENCES campaign_presentations(id) ON DELETE CASCADE,
        show_influencer_details INTEGER NOT NULL DEFAULT 1 CHECK (show_influencer_details IN (0,1)),
        show_social_accounts INTEGER NOT NULL DEFAULT 1 CHECK (show_social_accounts IN (0,1)),
        show_followers INTEGER NOT NULL DEFAULT 1 CHECK (show_followers IN (0,1)),
        show_additional_details INTEGER NOT NULL DEFAULT 1 CHECK (show_additional_details IN (0,1)),
        show_company_work INTEGER NOT NULL DEFAULT 0 CHECK (show_company_work IN (0,1))
      );
      CREATE TABLE IF NOT EXISTS campaign_presentation_work_videos (
        presentation_id TEXT NOT NULL REFERENCES campaign_presentations(id) ON DELETE CASCADE,
        video_id TEXT NOT NULL REFERENCES company_work_videos(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (presentation_id, video_id),
        UNIQUE (presentation_id, position)
      );
      CREATE TABLE IF NOT EXISTS client_catalog_work_videos (
        catalog_id TEXT NOT NULL REFERENCES client_catalogs(id) ON DELETE CASCADE,
        video_id TEXT NOT NULL REFERENCES company_work_videos(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (catalog_id, video_id),
        UNIQUE (catalog_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_company_work_videos_active
        ON company_work_videos(active, created_at);
    `);
    const briefColumns = new Set(database.prepare('PRAGMA table_info(campaign_briefs)').all().map((column) => column.name));
    if (!briefColumns.has('archived')) database.exec('ALTER TABLE campaign_briefs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    database.exec(`UPDATE client_catalogs SET portal_linked = 1
      WHERE id IN (SELECT catalog_id FROM client_account_catalogs)`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
function ensureCoverageSchema() {
  database.exec(`
    CREATE TABLE IF NOT EXISTS coverage_videos (
      id TEXT PRIMARY KEY,
      youtube_video_id TEXT NOT NULL,
      video_url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      influencer_id TEXT REFERENCES influencers(id) ON DELETE SET NULL,
      campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_coverage_videos_influencer
      ON coverage_videos(influencer_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_coverage_videos_campaign
      ON coverage_videos(campaign_id, updated_at DESC);
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS client_catalog_account_visibility (
      catalog_id TEXT NOT NULL,
      influencer_id TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('Instagram', 'TikTok', 'Snapchat')),
      visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
      PRIMARY KEY (catalog_id, influencer_id, platform),
      FOREIGN KEY (catalog_id, influencer_id)
        REFERENCES client_catalog_items(catalog_id, influencer_id) ON DELETE CASCADE
    );
  `);
}
function ensureAuditAndBrandSchema() {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS company_brand_settings (
        brand_id TEXT PRIMARY KEY,
        configuration_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT,
        actor_username TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        action TEXT NOT NULL,
        section TEXT NOT NULL,
        entity_type TEXT NOT NULL DEFAULT '',
        entity_id TEXT NOT NULL DEFAULT '',
        entity_label TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
        http_status INTEGER NOT NULL,
        old_values_json TEXT NOT NULL DEFAULT '',
        new_values_json TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_occurred ON audit_events(occurred_at DESC, id);
      CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_username COLLATE NOCASE, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_events_section ON audit_events(section, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS campaign_presentation_client_logos (
        presentation_id TEXT PRIMARY KEY REFERENCES campaign_presentations(id) ON DELETE CASCADE,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
        width INTEGER NOT NULL CHECK (width > 0),
        height INTEGER NOT NULL CHECK (height > 0),
        file_data BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    for (const [table, columns] of [
      ['client_catalogs', new Set(database.prepare('PRAGMA table_info(client_catalogs)').all().map((column) => column.name))],
      ['campaign_presentations', new Set(database.prepare('PRAGMA table_info(campaign_presentations)').all().map((column) => column.name))]
    ]) {
      if (!columns.has('brand_id')) database.exec(`ALTER TABLE ${table} ADD COLUMN brand_id TEXT NOT NULL DEFAULT 'fkretk'`);
      if (!columns.has('brand_snapshot_json')) database.exec(`ALTER TABLE ${table} ADD COLUMN brand_snapshot_json TEXT NOT NULL DEFAULT '{}'`);
    }
    const presentationColumns = new Set(database.prepare('PRAGMA table_info(campaign_presentations)').all().map((column) => column.name));
    for (const [column, definition] of [
      ['presentation_mode', "TEXT NOT NULL DEFAULT 'selecting' CHECK (presentation_mode IN ('selecting', 'visits'))"],
      ['header_title', "TEXT NOT NULL DEFAULT ''"],
      ['header_tagline', "TEXT NOT NULL DEFAULT ''"],
      ['package_visits_count', 'INTEGER NULL']
    ]) {
      if (!presentationColumns.has(column)) database.exec(`ALTER TABLE campaign_presentations ADD COLUMN ${column} ${definition}`);
    }
    const now = new Date().toISOString();
    const saveBrand = database.prepare(`INSERT OR IGNORE INTO company_brand_settings
      (brand_id, configuration_json, updated_at) VALUES (?, ?, ?)`);
    for (const brand of Object.values(defaultBrandSettings)) saveBrand.run(brand.id, JSON.stringify(brand), now);
    database.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run('company_identity', JSON.stringify(companyIdentity), now);
    for (const table of ['client_catalogs', 'campaign_presentations']) {
      database.prepare(`UPDATE ${table} SET brand_snapshot_json = ? WHERE brand_snapshot_json = '{}' OR brand_snapshot_json = ''`)
        .run(JSON.stringify(defaultBrandSettings.fkretk));
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function defaultPortalConfig(template = 'request-approval', status = 'published') {
  const sectionSets = {
    'request-approval': ['requestApproval'],
    'visit-schedule': ['visitSchedule'],
    'delivery-campaign': ['deliveryCampaign'],
    'campaign-report': ['campaignReport'],
    'custom-view': ['requestApproval', 'visitSchedule', 'deliveryCampaign', 'campaignReport']
  };
  return {
    template,
    status,
    sections: [...(sectionSets[template] || sectionSets['request-approval'])],
    fields: structuredClone(portalDefaultFields),
    actions: { ...defaultPortalActions }
  };
}

function validatePortalConfig(input, fallback = defaultPortalConfig()) {
  if (input === undefined || input === null) return structuredClone(fallback);
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = null; }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('إعدادات بوابة العميل غير صالحة.'), { status: 400 });
  }
  const template = portalTemplates.has(input.template) ? input.template : fallback.template;
  const status = input.status === undefined ? fallback.status : input.status;
  if (!['draft', 'published'].includes(status)) {
    throw Object.assign(new Error('حالة صفحة العميل غير صالحة.'), { status: 400 });
  }
  const rawSections = input.sections === undefined ? fallback.sections : input.sections;
  if (!Array.isArray(rawSections) || rawSections.length > portalSections.size || rawSections.some((section) => !portalSections.has(section))) {
    throw Object.assign(new Error('أقسام صفحة العميل غير صالحة.'), { status: 400 });
  }
  const sections = [...new Set(rawSections)];
  const fields = {};
  for (const [section, allowedFields] of Object.entries(portalFieldKeys)) {
    const selected = input.fields?.[section] === undefined ? fallback.fields?.[section] || [] : input.fields[section];
    if (!Array.isArray(selected) || selected.some((field) => !allowedFields.includes(field))) {
      throw Object.assign(new Error(`حقول قسم ${section} غير صالحة.`), { status: 400 });
    }
    fields[section] = [...new Set(selected)];
  }
  const actions = {};
  for (const [key, defaultValue] of Object.entries(defaultPortalActions)) {
    const value = input.actions?.[key] === undefined ? fallback.actions[key] : input.actions[key];
    if (typeof value !== 'boolean') throw Object.assign(new Error(`إعداد الإجراء ${key} غير صالح.`), { status: 400 });
    actions[key] = value;
  }
  if (!actions.allowDecisions) actions.allowRevert = false;
  if (!sections.includes('requestApproval')) {
    actions.allowDecisions = false;
    actions.allowRevert = false;
  }
  return { template, status, sections, fields, actions };
}
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS influencers (
    id TEXT PRIMARY KEY,
    record_json TEXT NOT NULL,
    phone_key TEXT,
    archived_at TEXT,
    archived_by TEXT,
    archive_previous_status TEXT NOT NULL DEFAULT 'Active',
    archive_previous_workflow TEXT NOT NULL DEFAULT 'new'
  );
  CREATE TABLE IF NOT EXISTS influencer_accounts (
    influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('Instagram', 'TikTok', 'Snapchat')),
    normalized_username TEXT NOT NULL,
    PRIMARY KEY (influencer_id, platform),
    UNIQUE (platform, normalized_username)
  );
  CREATE INDEX IF NOT EXISTS idx_influencer_accounts_owner ON influencer_accounts(influencer_id);
  CREATE TABLE IF NOT EXISTS import_batches (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_sha256 TEXT NOT NULL,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_username TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    created_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    unchanged_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    needs_review_count INTEGER NOT NULL DEFAULT 0,
    row_results_json TEXT NOT NULL DEFAULT '[]',
    undo_data_json TEXT NOT NULL DEFAULT '[]',
    undone_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_import_batches_created ON import_batches(completed_at DESC);
  CREATE TABLE IF NOT EXISTS influencer_profile_images (
    influencer_id TEXT PRIMARY KEY REFERENCES influencers(id) ON DELETE CASCADE,
    mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    image_data BLOB NOT NULL,
    content_hash TEXT NOT NULL,
    source_url TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS influencer_follower_history (
    id TEXT PRIMARY KEY,
    influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('Instagram', 'TikTok', 'Snapchat')),
    followers_count INTEGER NOT NULL CHECK (followers_count >= 0),
    previous_count INTEGER CHECK (previous_count IS NULL OR previous_count >= 0),
    source TEXT NOT NULL,
    actor_username TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_follower_history_lookup
    ON influencer_follower_history(influencer_id, platform, recorded_at DESC);
  CREATE TABLE IF NOT EXISTS influencer_status_history (
    id TEXT PRIMARY KEY,
    influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
    previous_status TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_username TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_influencer_status_history
    ON influencer_status_history(influencer_id, changed_at DESC);
  CREATE TABLE IF NOT EXISTS influencer_advertiser_notes (
    id TEXT PRIMARY KEY,
    influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
    note_text TEXT NOT NULL,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_by_username TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    updated_by_username TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    deleted_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_influencer_advertiser_notes
    ON influencer_advertiser_notes(influencer_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS influencer_advertiser_note_history (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
    previous_text TEXT NOT NULL DEFAULT '',
    note_text TEXT NOT NULL DEFAULT '',
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_username TEXT NOT NULL,
    changed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_influencer_advertiser_note_history
    ON influencer_advertiser_note_history(influencer_id, changed_at DESC);
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_influencers_phone ON influencers(phone_key);
  CREATE TABLE IF NOT EXISTS client_catalogs (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    client_name TEXT NOT NULL,
    company_name TEXT NOT NULL,
    show_city INTEGER NOT NULL DEFAULT 1,
    show_category INTEGER NOT NULL DEFAULT 1,
    show_details INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS client_catalog_items (
    catalog_id TEXT NOT NULL REFERENCES client_catalogs(id) ON DELETE CASCADE,
    influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (catalog_id, influencer_id)
  );
  CREATE TABLE IF NOT EXISTS client_inquiries (
    id TEXT PRIMARY KEY,
    catalog_id TEXT NOT NULL REFERENCES client_catalogs(id) ON DELETE CASCADE,
    influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
    customer_name TEXT NOT NULL,
    customer_contact TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS client_catalog_decisions (
    id TEXT PRIMARY KEY,
    catalog_id TEXT NOT NULL REFERENCES client_catalogs(id) ON DELETE CASCADE,
    influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected')),
    created_at TEXT NOT NULL,
    UNIQUE (catalog_id, influencer_id)
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    campaign_name TEXT NOT NULL,
    company_name TEXT NOT NULL,
    campaign_type TEXT NOT NULL CHECK (campaign_type IN ('visit', 'delivery')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS campaign_schedule (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    scheduled_at TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS campaign_targets (
    campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    influencer_id TEXT NOT NULL REFERENCES influencers(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, influencer_id)
  );
`);
const influencerColumns = new Set(database.prepare('PRAGMA table_info(influencers)').all().map((column) => column.name));
for (const [name, definition] of [
  ['archived_at', 'TEXT'],
  ['archived_by', 'TEXT'],
  ['archive_previous_status', "TEXT NOT NULL DEFAULT 'Active'"],
  ['archive_previous_workflow', "TEXT NOT NULL DEFAULT 'new'"]
]) {
  if (!influencerColumns.has(name)) database.exec(`ALTER TABLE influencers ADD COLUMN ${name} ${definition}`);
}
database.exec('CREATE INDEX IF NOT EXISTS idx_influencers_archived ON influencers(archived_at)');
const searchIndexExists = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'influencer_search'").get());
database.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS influencer_search USING fts5(influencer_id UNINDEXED, search_text, tokenize = 'trigram');
  CREATE TRIGGER IF NOT EXISTS influencers_search_insert AFTER INSERT ON influencers BEGIN
    INSERT INTO influencer_search (influencer_id, search_text)
    SELECT NEW.id, COALESCE(group_concat(CAST(value AS TEXT), ' '), '') FROM json_each(NEW.record_json);
  END;
  CREATE TRIGGER IF NOT EXISTS influencers_search_update AFTER UPDATE OF record_json ON influencers BEGIN
    DELETE FROM influencer_search WHERE influencer_id = OLD.id;
    INSERT INTO influencer_search (influencer_id, search_text)
    SELECT NEW.id, COALESCE(group_concat(CAST(value AS TEXT), ' '), '') FROM json_each(NEW.record_json);
  END;
  CREATE TRIGGER IF NOT EXISTS influencers_search_delete AFTER DELETE ON influencers BEGIN
    DELETE FROM influencer_search WHERE influencer_id = OLD.id;
  END;
  CREATE INDEX IF NOT EXISTS idx_influencers_name ON influencers(json_extract(record_json, '$.\"Name\"') COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_influencers_instagram_username
    ON influencers(account_username(json_extract(record_json, '$.\"Username I\"')));
  CREATE INDEX IF NOT EXISTS idx_influencers_tiktok_username
    ON influencers(account_username(json_extract(record_json, '$.\"Username T\"')));
  CREATE INDEX IF NOT EXISTS idx_influencers_snapchat_username
    ON influencers(account_username(json_extract(record_json, '$.\"Username\"')));
  CREATE INDEX IF NOT EXISTS idx_influencers_country ON influencers(country_iso(json_extract(record_json, '$.\"Country\"')));
  CREATE INDEX IF NOT EXISTS idx_influencers_area ON influencers(lower(trim(json_extract(record_json, '$.\"Area\"'))));
  CREATE INDEX IF NOT EXISTS idx_influencers_city ON influencers(lower(trim(json_extract(record_json, '$.\"City\"'))));
  CREATE INDEX IF NOT EXISTS idx_influencers_status ON influencers(json_extract(record_json, '$.\"Influencer Status\"'));
  CREATE INDEX IF NOT EXISTS idx_influencers_workflow ON influencers(workflow_status(json_extract(record_json, '$.\"Workflow Status\"')));
`);
database.exec(`
  CREATE TRIGGER IF NOT EXISTS influencers_account_owner_insert_guard
  BEFORE INSERT ON influencers
  WHEN EXISTS (
    SELECT 1 FROM influencers existing
    WHERE existing.id <> NEW.id AND (
      (account_username(json_extract(NEW.record_json, '$."Username I"')) <> ''
        AND account_username(json_extract(existing.record_json, '$."Username I"')) = account_username(json_extract(NEW.record_json, '$."Username I"')))
      OR (account_username(json_extract(NEW.record_json, '$."Username T"')) <> ''
        AND account_username(json_extract(existing.record_json, '$."Username T"')) = account_username(json_extract(NEW.record_json, '$."Username T"')))
      OR (account_username(json_extract(NEW.record_json, '$."Username"')) <> ''
        AND account_username(json_extract(existing.record_json, '$."Username"')) = account_username(json_extract(NEW.record_json, '$."Username"')))
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'social_account_conflict');
  END;
  CREATE TRIGGER IF NOT EXISTS influencers_account_owner_update_guard
  BEFORE UPDATE OF record_json ON influencers
  WHEN
    (account_username(json_extract(NEW.record_json, '$."Username I"')) <> ''
      AND account_username(json_extract(NEW.record_json, '$."Username I"')) <> account_username(json_extract(OLD.record_json, '$."Username I"'))
      AND EXISTS (
        SELECT 1 FROM influencers existing
        WHERE existing.id <> NEW.id
          AND account_username(json_extract(existing.record_json, '$."Username I"')) = account_username(json_extract(NEW.record_json, '$."Username I"'))
      ))
    OR (account_username(json_extract(NEW.record_json, '$."Username T"')) <> ''
      AND account_username(json_extract(NEW.record_json, '$."Username T"')) <> account_username(json_extract(OLD.record_json, '$."Username T"'))
      AND EXISTS (
        SELECT 1 FROM influencers existing
        WHERE existing.id <> NEW.id
          AND account_username(json_extract(existing.record_json, '$."Username T"')) = account_username(json_extract(NEW.record_json, '$."Username T"'))
      ))
    OR (account_username(json_extract(NEW.record_json, '$."Username"')) <> ''
      AND account_username(json_extract(NEW.record_json, '$."Username"')) <> account_username(json_extract(OLD.record_json, '$."Username"'))
      AND EXISTS (
        SELECT 1 FROM influencers existing
        WHERE existing.id <> NEW.id
          AND account_username(json_extract(existing.record_json, '$."Username"')) = account_username(json_extract(NEW.record_json, '$."Username"'))
      ))
  BEGIN
    SELECT RAISE(ABORT, 'social_account_conflict');
  END;
`);
if (!searchIndexExists || Number(database.prepare('SELECT COUNT(*) AS count FROM influencer_search').get().count) !== Number(database.prepare('SELECT COUNT(*) AS count FROM influencers').get().count)) {
  database.exec(`
    DELETE FROM influencer_search;
    INSERT INTO influencer_search (influencer_id, search_text)
    SELECT i.id, COALESCE((SELECT group_concat(CAST(value AS TEXT), ' ') FROM json_each(i.record_json)), '')
    FROM influencers i;
  `);
}
for (const field of ['Gender', 'Face Appearance', 'Speak', 'Verified', 'Mawthouq', 'Paid or Voucher']) {
  const path = `$."${field}"`;
  const index = field.toLowerCase().replace(/[^a-z]+/g, '_');
  database.exec(`CREATE INDEX IF NOT EXISTS idx_influencers_${index} ON influencers(normalized_filter('${field}', json_extract(record_json, '${path}')));`);
}
ensureUserColumns();
ensureResetTokenTable();
ensureCatalogSettingColumns();
ensureCampaignColumns();
ensureClientPortalSchema();
ensureCoverageSchema();
ensureAuditAndBrandSchema();
function ensurePhoneKeyNonUnique() {
  const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'influencers'").get();
  if (!table?.sql || !/\bphone_key\s+TEXT\s+UNIQUE\b/i.test(table.sql)) return;

  const tableSql = table.sql
    .replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"?influencers"?)\s*\(/i, 'CREATE TABLE influencers_phonekey_migration (')
    .replace(/\bphone_key\s+TEXT\s+UNIQUE\b/i, 'phone_key TEXT');
  if (tableSql === table.sql) throw new Error('Could not prepare the influencers phone-key migration.');

  const columns = database.prepare('PRAGMA table_info(influencers)').all().map((column) => column.name);
  const quotedColumns = columns.map((column) => `"${column.replace(/"/g, '""')}"`).join(', ');
  const objects = database.prepare(`SELECT sql FROM sqlite_master
    WHERE tbl_name = 'influencers' AND type IN ('index', 'trigger') AND sql IS NOT NULL`).all();

  database.exec('PRAGMA foreign_keys = OFF');
  try {
    database.exec('BEGIN IMMEDIATE');
    database.exec(tableSql);
    database.exec(`INSERT INTO influencers_phonekey_migration (${quotedColumns})
      SELECT ${quotedColumns} FROM influencers`);
    database.exec('DROP TABLE influencers');
    database.exec('ALTER TABLE influencers_phonekey_migration RENAME TO influencers');
    for (const object of objects) database.exec(object.sql);
    if (database.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('Foreign-key validation failed during the influencers phone-key migration.');
    }
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    database.exec('PRAGMA foreign_keys = ON');
  }
}
ensurePhoneKeyNonUnique();
database.exec(`UPDATE influencers
  SET record_json = json_set(record_json, '$."Influencer Status"', 'Active')
  WHERE json_valid(record_json) AND json_type(record_json, '$."Influencer Status"') IS NULL`);

function localDateStamp(date = new Date()) {
  const part = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

function backupFilePattern() {
  return /^fikratak-\d{4}-\d{2}-\d{2}(?:-\d{6}-[a-f0-9]{6})?\.sqlite$/;
}

async function listBackupFiles() {
  const files = [];
  for (const name of await readdir(backupDir)) {
    if (!backupFilePattern().test(name)) continue;
    const path = resolve(backupDir, name);
    const info = await stat(path);
    if (info.isFile()) files.push({ name, path, size: info.size, modifiedAt: info.mtime.toISOString() });
  }
  return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

function validateBackupFile(path) {
  const snapshot = openSQLiteDatabase(path);
  try {
    const integrity = snapshot.prepare('PRAGMA quick_check').get().quick_check;
    const journalMode = snapshot.prepare('PRAGMA journal_mode = DELETE').get().journal_mode;
    return integrity === 'ok' && journalMode === 'delete';
  } finally {
    snapshot.close();
  }
}

async function pruneBackups(files) {
  for (const file of files.slice(backupRetentionCount)) await rm(file.path);
}

async function createBackup(manual = false) {
  if (backupInProgress) throw Object.assign(new Error('هناك نسخة احتياطية قيد الإنشاء بالفعل.'), { status: 409 });
  backupInProgress = true;
  backupStatus.lastAttemptAt = new Date().toISOString();
  try {
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const date = localDateStamp();
    if (!manual && backupStatus.lastSuccessAt && localDateStamp(new Date(backupStatus.lastSuccessAt)) === date) {
      return { file: backupStatus.lastFile, created: false };
    }

    const dailyName = `fikratak-${date}.sqlite`;
    const dailyPath = resolve(backupDir, dailyName);
    let dailyFileIsInvalid = false;
    if (!manual) {
      try {
        const info = await stat(dailyPath);
        if (info.isFile() && validateBackupFile(dailyPath)) {
          backupStatus.state = 'success';
          backupStatus.lastSuccessAt = info.mtime.toISOString();
          backupStatus.lastFile = dailyName;
          backupStatus.lastError = '';
          await pruneBackups(await listBackupFiles());
          return { file: dailyName, created: false };
        }
        dailyFileIsInvalid = info.isFile();
      } catch (error) {
        if (error.code === 'SQLITE_NOTADB' || error.message.includes('not a database')) dailyFileIsInvalid = true;
        else if (error.code !== 'ENOENT') throw error;
      }
    }

    const suffix = `${String(new Date().getHours()).padStart(2, '0')}${String(new Date().getMinutes()).padStart(2, '0')}${String(new Date().getSeconds()).padStart(2, '0')}-${randomBytes(3).toString('hex')}`;
    const fileName = manual || dailyFileIsInvalid ? `fikratak-${date}-${suffix}.sqlite` : dailyName;
    const destination = resolve(backupDir, fileName);
    const temporary = resolve(backupDir, `.${fileName}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await database.backup(temporary);
      await chmod(temporary, 0o600);
      if (!validateBackupFile(temporary)) throw new Error('فشل التحقق من سلامة نسخة قاعدة البيانات.');
      await rename(temporary, destination);
      const files = await listBackupFiles();
      await pruneBackups(files);
      backupStatus.state = 'success';
      backupStatus.lastSuccessAt = new Date().toISOString();
      backupStatus.lastFile = fileName;
      backupStatus.lastError = '';
      if (!manual) recordSystemAudit('backup.create', 'system', 'success', {
        label: fileName, values: { backupType: 'sqlite', created: true }
      });
      return { file: fileName, created: true };
    } finally {
      await rm(temporary, { force: true });
    }
  } catch (error) {
    backupStatus.state = 'error';
    backupStatus.lastError = error.message;
    if (!manual) recordSystemAudit('backup.create', 'system', 'failure', {
      label: 'SQLite', values: { backupType: 'sqlite' }
    });
    throw error;
  } finally {
    backupInProgress = false;
  }
}

async function getBackupSummary() {
  try {
    const files = await listBackupFiles();
    const latest = files[0];
    return {
      directory: backupDir,
      retentionCount: backupRetentionCount,
      state: backupStatus.state,
      lastAttemptAt: backupStatus.lastAttemptAt,
      lastSuccessAt: latest?.modifiedAt || (files.length ? backupStatus.lastSuccessAt : ''),
      lastFile: latest?.name || (files.length ? backupStatus.lastFile : ''),
      lastError: backupStatus.lastError,
      backupCount: files.length,
      directoryAvailable: true,
      backupInProgress
    };
  } catch (error) {
    return {
      directory: backupDir,
      retentionCount: backupRetentionCount,
      state: backupStatus.state === 'success' ? 'error' : backupStatus.state,
      lastAttemptAt: backupStatus.lastAttemptAt,
      lastSuccessAt: backupStatus.lastSuccessAt,
      lastFile: backupStatus.lastFile,
      lastError: error.message,
      backupCount: 0,
      directoryAvailable: false,
      backupInProgress
    };
  }
}

async function loadInfluencerExcelStatus() {
  if (influencerExcelStatusLoaded) return;
  influencerExcelStatusLoaded = true;
  try {
    const saved = JSON.parse(await readFile(influencerExcelStatusPath, 'utf8'));
    if (!['pending', 'success', 'error'].includes(saved.state)
      || typeof saved.lastAttemptAt !== 'string'
      || typeof saved.lastSuccessAt !== 'string'
      || !Number.isSafeInteger(saved.recordCount) || saved.recordCount < 0
        || typeof saved.lastError !== 'string'
        || (saved.sourceHash !== undefined && typeof saved.sourceHash !== 'string')) {
        throw new Error('ملف حالة نسخة Excel غير صالح.');
      }
      Object.assign(influencerExcelStatus, saved);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      influencerExcelStatus.state = 'error';
      influencerExcelStatus.lastError = error.message;
    }
  }
}

async function saveInfluencerExcelStatus() {
  const temporary = resolve(backupDir, `.Fikratak_Influencers.status.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(influencerExcelStatus), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, influencerExcelStatusPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readOptionalFile(path) {
  try { return await readFile(path); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function restoreOptionalFile(path, contents) {
  if (contents === null) {
    await rm(path, { force: true });
    return;
  }
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.restore`;
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function restoreInfluencerExcelSnapshot(context) {
  const snapshot = context?.influencerExcelSnapshot;
  if (!snapshot) return;
  await restoreOptionalFile(influencerExcelPath, snapshot.workbook);
  await restoreOptionalFile(influencerExcelStatusPath, snapshot.statusFile);
  Object.assign(influencerExcelStatus, snapshot.status);
  delete context.influencerExcelSnapshot;
}

async function getInfluencerExcelSummary() {
  await loadInfluencerExcelStatus();
  return {
    path: influencerExcelPath,
    fileName: influencerExcelFileName,
    state: influencerExcelStatus.state,
    lastAttemptAt: influencerExcelStatus.lastAttemptAt,
    lastSuccessAt: influencerExcelStatus.lastSuccessAt,
    recordCount: influencerExcelStatus.recordCount,
    lastError: influencerExcelStatus.lastError,
    fileAvailable: await stat(influencerExcelPath).then((info) => info.isFile()).catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }),
    inProgress: influencerExcelInProgress
  };
}

async function acquireInfluencerExcelLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(influencerExcelLockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8');
      return handle;
    } catch (error) {
      if (handle) {
        await handle.close();
        await rm(influencerExcelLockPath, { force: true });
      }
      if (error.code !== 'EEXIST') throw error;
      let lockData;
      let lockInfo;
      try {
        [lockData, lockInfo] = await Promise.all([
          readFile(influencerExcelLockPath, 'utf8'),
          stat(influencerExcelLockPath)
        ]);
      } catch (readError) {
        if (readError.code === 'ENOENT') continue;
        throw readError;
      }
      let activeProcess = false;
      let lock;
      try {
        lock = JSON.parse(lockData);
      } catch (parseError) {
        logFailure('Excel backup lock could not be parsed', parseError);
      }
      if (Number.isSafeInteger(lock?.pid) && lock.pid > 0) {
        try { process.kill(lock.pid, 0); activeProcess = true; }
        catch (processError) { activeProcess = processError.code !== 'ESRCH'; }
      }
      if (activeProcess || Date.now() - lockInfo.mtimeMs < 10 * 60 * 1000) {
        throw Object.assign(new Error('تحديث ملف Excel قيد التنفيذ بالفعل.'), { status: 409 });
      }
      await rm(influencerExcelLockPath, { force: true });
    }
  }
  throw Object.assign(new Error('تعذر الحصول على قفل تحديث ملف Excel.'), { status: 409 });
}

function readInfluencerExportSnapshot() {
  let rows;
  database.exec('BEGIN');
  try {
    rows = database.prepare('SELECT id, record_json FROM influencers ORDER BY id').all();
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  const sourceHash = createHash('sha256');
  const records = rows.map((row) => {
    sourceHash.update(row.id).update('\0').update(row.record_json).update('\n');
    return {
      id: row.id,
      record: deriveMainAccountFields(deriveInfluencerFields(JSON.parse(row.record_json || '{}')))
    };
  });
  return { records, sourceHash: sourceHash.digest('hex') };
}

async function createInfluencerExcelBackup(manual = false, auditContext = null) {
  await loadInfluencerExcelStatus();
  const date = localDateStamp();
  if (!manual && influencerExcelStatus.state === 'success' && influencerExcelStatus.lastSuccessAt
    && localDateStamp(new Date(influencerExcelStatus.lastSuccessAt)) === date) {
    try {
      const fileInfo = await stat(influencerExcelPath);
      const snapshot = readInfluencerExportSnapshot();
      if (fileInfo.isFile() && influencerExcelStatus.sourceHash
        && snapshot.sourceHash === influencerExcelStatus.sourceHash) {
        return { created: false, recordCount: influencerExcelStatus.recordCount, path: influencerExcelPath };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  try {
    await mkdir(backupDir, { recursive: true });
  } catch (error) {
    influencerExcelStatus.lastAttemptAt = new Date().toISOString();
    influencerExcelStatus.state = 'error';
    influencerExcelStatus.lastError = error.message;
    if (!error.status) error.status = 503;
    throw error;
  }
  const lockHandle = await acquireInfluencerExcelLock();
  influencerExcelInProgress = true;
  try {
    if (auditContext) {
      auditContext.influencerExcelSnapshot = {
        workbook: await readOptionalFile(influencerExcelPath),
        statusFile: await readOptionalFile(influencerExcelStatusPath),
        status: { ...influencerExcelStatus }
      };
    }
    influencerExcelStatus.lastAttemptAt = new Date().toISOString();
    influencerExcelStatus.lastError = '';
    const snapshot = readInfluencerExportSnapshot();
    const records = snapshot.records;

    const keys = [...new Set(records.flatMap(({ record }) => Object.keys(record)))].sort((left, right) => left.localeCompare(right, 'en'));
    const headers = ['ID', ...keys];
    const rows = records.map(({ id, record }) => [id, ...keys.map((key) => record[key] ?? '')]);
    const workbook = createXlsxWorkbook(headers, rows, { parseFollower: parseFollowerValue });
    validateXlsxWorkbook(workbook, rows.length);
    const temporary = resolve(backupDir, `.${influencerExcelFileName}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, workbook, { flag: 'wx', mode: 0o600 });
      const written = await readFile(temporary);
      validateXlsxWorkbook(written, rows.length);
      await rename(temporary, influencerExcelPath);
    } finally {
      await rm(temporary, { force: true });
    }
    influencerExcelStatus.state = 'success';
    influencerExcelStatus.lastSuccessAt = new Date().toISOString();
    influencerExcelStatus.recordCount = rows.length;
    influencerExcelStatus.sourceHash = snapshot.sourceHash;
    influencerExcelStatus.lastError = '';
    await saveInfluencerExcelStatus();
    if (!manual) recordSystemAudit('backup.create', 'system', 'success', {
      label: influencerExcelFileName, values: { backupType: 'influencer_excel', recordCount: rows.length }
    });
    return { created: true, recordCount: rows.length, path: influencerExcelPath };
  } catch (error) {
    influencerExcelStatus.state = 'error';
    influencerExcelStatus.lastError = error.message;
    if (!manual) recordSystemAudit('backup.create', 'system', 'failure', {
      label: influencerExcelFileName, values: { backupType: 'influencer_excel' }
    });
    try { await saveInfluencerExcelStatus(); }
    catch (statusError) { logFailure('Excel backup status could not be saved', statusError); }
    if (!error.status) error.status = 503;
    throw error;
  } finally {
    influencerExcelInProgress = false;
    await lockHandle.close();
    await rm(influencerExcelLockPath, { force: true });
  }
}

async function runDailyBackup() {
  try {
    await createBackup();
  } catch (error) {
    logFailure('Daily database backup failed', error);
  }
  try {
    await createInfluencerExcelBackup();
  } catch (error) {
    logFailure('Daily influencer Excel backup failed', error);
  }
}

function auditSafeValue(value, key = '', depth = 0) {
  if (/password|secret|token|session|phone|mobile|email|contact|image|base64|reset.?code|confirmation.?username/i.test(key)
    || /^(?:number|country code|full_mobile_number)$/i.test(key)) return undefined;
  if (depth > 4) return '[nested]';
  if (Array.isArray(value)) return { count: value.length };
  if (value && typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 60)) {
      const safe = auditSafeValue(childValue, childKey, depth + 1);
      if (safe !== undefined) output[childKey] = safe;
    }
    return output;
  }
  if (typeof value === 'string') return value.slice(0, 1000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return undefined;
}

function auditEntitySnapshot(pathname) {
  const definitions = [
    [/^\/api\/influencers\/([^/]+)$/, id => database.prepare('SELECT id, record_json AS recordJson, archived_at AS archivedAt FROM influencers WHERE id = ?').get(id), 'influencer'],
    [/^\/api\/campaigns\/([a-f0-9]{32})$/, id => database.prepare('SELECT id, campaign_name AS name, company_name AS companyName, service_type AS serviceType, execution_mode AS executionMode FROM campaigns WHERE id = ?').get(id), 'campaign'],
    [/^\/api\/coverage\/([a-f0-9]{32})$/, id => coverageVideoById(id), 'coverage_video'],
    [/^\/api\/client-catalogs\/([a-f0-9]{32})$/, id => database.prepare('SELECT id, offer_name AS name, client_name AS clientName, company_name AS companyName, brand_id AS brandId, active, offer_status AS status FROM client_catalogs WHERE id = ?').get(id), 'client_offer'],
    [/^\/api\/client-accounts\/([a-f0-9]{32})$/, id => database.prepare('SELECT id, username, client_name AS clientName, company_name AS companyName, active, display_mode AS displayMode FROM client_accounts WHERE id = ?').get(id), 'client_account'],
    [/^\/api\/users\/([^/]+)$/, id => database.prepare('SELECT id, username, role, active FROM users WHERE id = ?').get(id), 'user'],
    [/^\/api\/campaigns\/[a-f0-9]{32}\/presentations\/([a-f0-9]{32})$/, id => database.prepare('SELECT id, brand_id AS brandId, active, fields_json AS fields FROM campaign_presentations WHERE id = ?').get(id), 'campaign_presentation']
  ];
  for (const [pattern, read, type] of definitions) {
    const match = pathname.match(pattern);
    if (!match) continue;
    let id = match[1];
    if (type === 'influencer') {
      try { id = decodeURIComponent(id); } catch { return { type, id: '', values: null }; }
    }
    const row = read(id);
    if (!row) return { type, id, values: null };
    if (type === 'influencer') {
      try { row.record = auditSafeValue(JSON.parse(row.recordJson || '{}')); } catch { row.record = {}; }
      delete row.recordJson;
      row.name = row.record.Name || '';
    }
    if (type === 'campaign_presentation') {
      try { row.fields = JSON.parse(row.fields || '[]'); } catch { row.fields = []; }
    }
    return {
      type, id, values: auditSafeValue(row),
      label: String(row.name || row.title || row.influencerName || row.clientName || row.username || '')
    };
  }
  const nested = pathname.match(/^\/api\/([^/]+)\/([^/]+)(?:\/([^/]+))?/);
  return nested ? { type: nested[1].replace(/s$/, ''), id: nested[3] || nested[2], values: null } : { type: '', id: '', values: null };
}

function auditAction(pathname, method) {
  if (pathname === '/api/legacy-export' || /\/(?:influencers\/export|export)$/.test(pathname)
    || /\/campaigns\/[^/]+\/export$/.test(pathname) || /\/client-catalogs\/[^/]+\/export$/.test(pathname)
    || /\/campaigns\/[^/]+\/targets\/[^/]+\/qr-export$/.test(pathname)) return ['data.export', 'data'];
  if (pathname === '/api/backups/create' || pathname === '/api/backups/influencers/create') return ['backup.create', 'system'];
  if (pathname.includes('/restore')) return ['data.restore', 'system'];
  if (/^\/api\/import(?:\/|$)/.test(pathname)) return ['influencers.import', 'influencers'];
  if (/^\/api\/client-portal\/offers\/[^/]+\/targets\/[^/]+\/decision$/.test(pathname)
    || /^\/api\/client-catalog\/[^/]+\/decision$/.test(pathname)) return ['client_offer.decision', 'client_offers'];
  if (/^\/api\/client-portal\/campaigns\/[^/]+\/targets\/[^/]+\/decision$/.test(pathname)) return ['campaign.client_decision', 'campaigns'];
  if (pathname === '/api/client-catalogs' && method === 'POST') return ['client_offer.create', 'client_offers'];
  if (/^\/api\/coverage(?:\/[a-f0-9]{32})?$/.test(pathname)) {
    return [method === 'DELETE' ? 'coverage.delete' : method === 'POST' ? 'coverage.create' : 'coverage.update', 'coverage'];
  }
  if ((pathname === '/api/client-catalogs/import-confirm'
    || /^\/api\/client-catalogs\/[a-f0-9]{32}\/influencers$/.test(pathname)) && method === 'POST') {
    return ['client_offer.influencers.add', 'client_offers'];
  }
  if (pathname === '/api/influencers' || /^\/api\/influencers\/[^/]+/.test(pathname)) {
    const suffix = pathname.match(/^\/api\/influencers\/[^/]+\/([^/]+)/)?.[1];
    if (suffix === 'status') return ['influencer.status.change', 'influencers'];
    if (suffix === 'follower-updates') return ['influencer.followers.update', 'influencers'];
    if (suffix === 'advertiser-notes') return ['influencer.note.change', 'influencers'];
    if (suffix === 'restore') return ['influencer.restore', 'influencers'];
    return [method === 'POST' && pathname === '/api/influencers' ? 'influencer.create'
      : method === 'DELETE' ? 'influencer.archive' : method === 'PUT' ? 'influencer.update' : 'influencer.change', 'influencers'];
  }
  if (/^\/api\/campaigns/.test(pathname)) return [method === 'DELETE' ? 'campaign.delete' : method === 'POST' ? 'campaign.create' : 'campaign.change', 'campaigns'];
  if (/^\/api\/client-catalog/.test(pathname) || /^\/api\/client-inquiries/.test(pathname)) return [method === 'DELETE' ? 'client_offer.delete' : method === 'POST' ? 'client_offer.create_or_decision' : 'client_offer.change', 'client_offers'];
  if (/^\/api\/client-accounts/.test(pathname) || /^\/api\/client-portal-templates/.test(pathname)) return [method === 'DELETE' ? 'client_account.delete' : method === 'POST' ? 'client_account.create' : 'client_account.change', 'clients'];
  if (/^\/api\/users/.test(pathname)) return [method === 'DELETE' ? 'user.delete' : method === 'POST' ? 'user.create' : 'user.change', 'users'];
  if (/^\/api\/client-portal\//.test(pathname)) return ['client_portal.change', 'client_portal'];
  if (pathname === '/api/login' || pathname === '/api/client-portal/login') return ['auth.login', 'auth'];
  if (/^\/api\/settings\//.test(pathname)) return ['settings.change', 'settings'];
  return [`${method.toLowerCase()} ${pathname.slice(5)}`, pathname.split('/')[2] || 'system'];
}

function auditEntityLabel(context, body, snapshot) {
  return String(snapshot?.label || body?.Name || body?.name || body?.title || body?.offerName || body?.campaignName
    || body?.clientName || body?.username || body?.brandId || '').slice(0, 200);
}

function recordAuditContext(context) {
  const { request, status, value, before } = context;
  if (!request.method || request.method === 'GET' || !request.url?.startsWith('/api/')) return;
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const [action, section] = auditAction(pathname, request.method);
  const body = auditRequestBodies.get(request) || {};
  const after = auditEntitySnapshot(pathname);
  const responseValue = value && typeof value === 'object' ? value : {};
  const entityId = before?.id || after?.id || responseValue.record?.id || responseValue.campaign?.id
    || responseValue.catalog?.id || responseValue.account?.id || responseValue.user?.id
    || responseValue.video?.id || responseValue.id || '';
  const entityType = before?.type || after?.type
    || (action.startsWith('influencer.') || action === 'influencers.import' ? 'influencer'
      : action.startsWith('client_offer.') ? 'client_offer'
        : action.startsWith('campaign.') ? 'campaign'
          : action.startsWith('user.') ? 'user'
            : action.startsWith('client_account.') ? 'client_account'
                    : action.startsWith('coverage.') ? 'coverage_video'
                    : action.startsWith('backup.') || action === 'data.restore' ? 'system' : '');
  const oldValues = before?.values || null;
  let newValues = after?.values || auditSafeValue(body);
  if (status >= 400) {
    newValues = auditSafeValue({ attempted: body, error: responseValue.error || '', httpStatus: status });
  }
  if (status < 400 && action === 'influencers.import') {
    newValues = auditSafeValue({ created: responseValue.created, updated: responseValue.updated,
      unchanged: responseValue.unchanged, failed: responseValue.failed, rows: body.rows?.length ?? body.recordCount });
  }
  if (action === 'data.export') {
    newValues = auditSafeValue({
      exportType: pathname,
      scope: body.scope || '',
      filterCount: Object.keys(body.filters || {}).length,
      rowCount: status < 400
        ? Array.isArray(responseValue.rows) ? responseValue.rows.length
          : responseValue.checkinPath ? 1 : Number(body.recordCount) || 0
        : undefined,
      httpStatus: status,
      error: status >= 400 ? responseValue.error || '' : undefined
    });
  }
  if (action === 'backup.create') {
    const backupType = pathname === '/api/backups/influencers/create' ? 'influencer_excel' : 'database';
    newValues = auditSafeValue({
      exportType: pathname,
      backupType,
      fileName: status < 400 ? responseValue.file || '' : undefined,
      recordCount: status < 400 ? Number(responseValue.recordCount) || 0 : undefined,
      httpStatus: status,
      error: status >= 400 ? responseValue.error || '' : undefined
    });
  }
  const user = context.user;
  const client = context.client;
  const attemptedUsername = typeof body.username === 'string' ? body.username.slice(0, 100) : '';
  const actorUsername = user?.username || client?.clientName || attemptedUsername || 'unknown';
  const actorRole = user?.role || (client ? 'client' : 'anonymous');
  try {
    database.prepare(`INSERT INTO audit_events
      (id, actor_user_id, actor_username, actor_role, action, section, entity_type, entity_id,
       entity_label, outcome, http_status, old_values_json, new_values_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      randomBytes(16).toString('hex'), user?.id || client?.id || null, actorUsername, actorRole,
      action, section, entityType, String(entityId || before?.id || after?.id || ''),
      auditEntityLabel(context, body, before || after),
      status >= 200 && status < 400 ? 'success' : 'failure', status || 500,
      oldValues ? JSON.stringify(oldValues).slice(0, 30000) : '',
      newValues ? JSON.stringify(newValues).slice(0, 30000) : '',
      new Date().toISOString()
    );
  } catch (error) {
    logFailure('Audit event could not be persisted', error);
    throw error;
  }
}

function recordSystemAudit(action, section, outcome, details = {}) {
  database.prepare(`INSERT INTO audit_events
    (id, actor_user_id, actor_username, actor_role, action, section, entity_type, entity_id,
     entity_label, outcome, http_status, old_values_json, new_values_json, occurred_at)
    VALUES (?, NULL, 'system', 'system', ?, ?, 'system', '', ?, ?, ?, '', ?, ?)`)
    .run(randomBytes(16).toString('hex'), action, section, String(details.label || '').slice(0, 200),
      outcome, outcome === 'success' ? 200 : 500,
      JSON.stringify(auditSafeValue(details.values || {})).slice(0, 30000), new Date().toISOString());
}

function json(response, status, value, extraHeaders = {}) {
  const auditContext = auditResponseContexts.get(response);
  if (auditContext) {
    auditContext.status = status;
    auditContext.value = value;
    auditContext.extraHeaders = extraHeaders;
    return;
  }
  const payload = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    ...extraHeaders
  });
  response.end(payload);
}

function cookieHeader(token, maxAge = Math.floor(sessionDurationMs / 1000)) {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookieAttribute}`;
}

function clearCookieHeader() {
  return `sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookieAttribute}`;
}

function clientCookieHeader(token, maxAge = Math.floor(sessionDurationMs / 1000)) {
  return `client_sid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookieAttribute}`;
}

function clearClientCookieHeader() {
  return `client_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookieAttribute}`;
}

function requestCookie(request, name) {
  const cookie = request.headers.cookie || '';
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function requestAddress(request) { return getRequestAddress(request, trustedProxies); }

function userView(row) {
  return { id: row.id, username: row.username, email: row.email || '', role: row.role, active: Boolean(row.active) };
}

function getSessionUser(request) {
  const token = requestCookie(request, 'sid');
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = database.prepare('SELECT id, username, role, active FROM users WHERE id = ?').get(session.userId);
  if (!user || !user.active) {
    sessions.delete(token);
    return null;
  }
  return user;
}

function getClientSessionAccount(request) {
  const token = requestCookie(request, 'client_sid');
  const session = clientSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    clientSessions.delete(token);
    return null;
  }
  const account = database.prepare(`SELECT id, username, client_name AS clientName,
    email, company_name AS companyName, active, portal_config AS portalConfig,
    portal_status AS portalStatus, client_type AS clientType, display_mode AS displayMode
    FROM client_accounts WHERE id = ?`).get(session.accountId);
  if (!account || !account.active) {
    clientSessions.delete(token);
    return null;
  }
  account.portalConfig = validatePortalConfig(account.portalConfig, defaultPortalConfig('request-approval', account.portalStatus));
  account.displayMode = displayModeFor(account);
  return account;
}

function displayModeFor(account) {
  return clientDisplayModes.has(account?.displayMode)
    ? account.displayMode
    : account?.clientType === 'prospective' ? 'prospective' : 'selecting';
}

function requireRole(user, allowed) {
  return Boolean(user && allowed.includes(user.role));
}

function requireDataExportRole(user) {
  return requireRole(user, ['admin']);
}

function getBrandSettings(brandId) {
  const row = database.prepare('SELECT configuration_json AS configurationJson FROM company_brand_settings WHERE brand_id = ?')
    .get(brandId);
  if (!row) return null;
  try { return JSON.parse(row.configurationJson); }
  catch { throw new Error(`Brand settings are invalid for ${brandId}.`); }
}

function getBrandSnapshot(row) {
  if (row?.brandSnapshotJson) {
    try { return JSON.parse(row.brandSnapshotJson); }
    catch { throw new Error('Saved presentation brand settings are invalid.'); }
  }
  return getBrandSettings(row?.brandId || 'fkretk') || defaultBrandSettings.fkretk;
}

async function verifySensitiveConfirmation(request, user, body) {
  if (!requireDataExportRole(user)) return { ok: false, status: 403, error: 'تصدير البيانات متاح للمدير فقط.' };
  const attempt = allowResetAttempt(requestAddress(request), 'sensitive-export', 5, 15 * 60 * 1000);
  if (!attempt.allowed) return { ok: false, status: 429, error: 'تجاوزت عدد محاولات التأكيد. حاول لاحقًا.' };
  const username = normalizeUsername(body?.confirmationUsername);
  const password = typeof body?.confirmationPassword === 'string' ? body.confirmationPassword : '';
  const storedUser = database.prepare(`SELECT id, username, role, active, salt, password_hash
    FROM users WHERE id = ?`).get(user.id);
  const identityMatches = storedUser?.active && storedUser.role === 'admin'
    && username.toLocaleLowerCase('en-US') === storedUser.username.toLocaleLowerCase('en-US');
  const valid = identityMatches && validateLoginPassword(password) && await checkPassword(password, storedUser);
  if (!valid) return { ok: false, status: 403, error: 'اسم المدير أو كلمة المرور غير صحيحة.' };
  resetAttempts.delete(`sensitive-export:${requestAddress(request)}`);
  return { ok: true };
}

function verifySameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return !isProduction;
  try {
    const parsedOrigin = new URL(origin);
    if (isProduction && parsedOrigin.protocol !== 'https:') return false;
    if (allowedOrigins.size) return allowedOrigins.has(parsedOrigin.origin);
    return parsedOrigin.host.toLowerCase() === String(request.headers.host || '').toLowerCase();
  }
  catch { return false; }
}

function matchesSetupToken(candidate) {
  if (!setupToken || Date.now() >= setupTokenExpiresAt || typeof candidate !== 'string') return false;
  const expected = Buffer.from(setupToken, 'utf8');
  const supplied = Buffer.from(candidate, 'utf8');
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function isLoopbackRequest(request) {
  const address = String(request.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

async function readJson(request, maxBytes = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('حجم الطلب أكبر من الحد المسموح.'), { status: 413 });
    chunks.push(chunk);
  }
  if (size === 0) {
    auditRequestBodies.set(request, {});
    return {};
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    auditRequestBodies.set(request, value);
    return value;
  }
  catch { throw Object.assign(new Error('صيغة البيانات غير صحيحة.'), { status: 400 }); }
}

function xmlText(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name) => {
    if (name[0] === '#') {
      const codepoint = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isInteger(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : '';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name.toLowerCase()] || entity;
  });
}

function zipEntries(buffer, {
  maxEntries = 200,
  maxEntryBytes = 10 * 1024 * 1024,
  maxExpandedBytes = 15 * 1024 * 1024,
  include = () => true
} = {}) {
  const endMin = Math.max(0, buffer.length - 22 - 0xffff);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= endMin; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { endOffset = offset; break; }
  }
  if (endOffset < 0) throw Object.assign(new Error('ملف Excel غير صالح أو غير مكتمل.'), { status: 400 });
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (!entryCount || entryCount > maxEntries || centralOffset >= endOffset) {
    throw Object.assign(new Error('بنية ملف Excel غير مدعومة.'), { status: 400 });
  }
  const entries = new Map();
  let offset = centralOffset;
  let expandedSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw Object.assign(new Error('بنية ملف Excel غير صالحة.'), { status: 400 });
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength).replace(/\\/g, '/');
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)
      || name.split('/').includes('..') || (flags & 1) || entries.has(name)) {
      throw Object.assign(new Error('يحتوي ملف Excel على مسار أو تشفير غير مدعوم.'), { status: 400 });
    }
    if (!include(name) || name.endsWith('/')) continue;
    expandedSize += uncompressedSize;
    if (compressedSize > maxEntryBytes || uncompressedSize > maxEntryBytes || expandedSize > maxExpandedBytes) {
      throw Object.assign(new Error('حجم محتويات ملف Excel يتجاوز الحد المسموح.'), { status: 413 });
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw Object.assign(new Error('بنية ملف Excel غير صالحة.'), { status: 400 });
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > buffer.length) throw Object.assign(new Error('بيانات ملف Excel غير مكتملة.'), { status: 400 });
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    try {
      if (method === 0) data = Buffer.from(compressed);
      else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
      else throw new Error('Unsupported ZIP compression method.');
    } catch {
      throw Object.assign(new Error('تعذر قراءة محتويات ملف Excel.'), { status: 400 });
    }
    if (data.length !== uncompressedSize) throw Object.assign(new Error('حجم بيانات ملف Excel غير متطابق.'), { status: 400 });
    entries.set(name, data);
  }
  return entries;
}

function xlsxEntries(buffer) {
  const included = new Set([
    '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml'
  ]);
  const archive = zipEntries(buffer, {
    maxEntries: 200,
    maxEntryBytes: 10 * 1024 * 1024,
    maxExpandedBytes: 15 * 1024 * 1024,
    include: (name) => included.has(name) || /^xl\/worksheets\/[^/]+\.xml$/i.test(name)
  });
  return new Map([...archive].map(([name, data]) => [name, data.toString('utf8')]));
}

function xlsxColumnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  let index = 0;
  for (const letter of letters) index = index * 26 + letter.charCodeAt(0) - 64;
  return index - 1;
}

const xlsxSourceRowNumber = Symbol('xlsxSourceRowNumber');

function readXlsxWorksheet(base64) {
  if (typeof base64 !== 'string' || base64.length > 4_500_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw Object.assign(new Error('ملف Excel فارغ أو يتجاوز الحجم المسموح.'), { status: 400 });
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw Object.assign(new Error('ارفع ملف Excel من نوع .xlsx.'), { status: 400 });
  }
  const entries = xlsxEntries(buffer);
  const workbook = entries.get('xl/workbook.xml');
  const relationships = entries.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !relationships) throw Object.assign(new Error('تعذر العثور على ورقة Excel داخل الملف.'), { status: 400 });
  const firstSheet = workbook.match(/<sheet\b([^>]*)\/?>/i)?.[1] || '';
  const relationshipId = firstSheet.match(/\br:id=["']([^"']+)["']/i)?.[1];
  const relationship = [...relationships.matchAll(/<Relationship\b([^>]*)\/?>/gi)]
    .map((match) => match[1])
    .find((attributes) => attributes.match(/\bId=["']([^"']+)["']/i)?.[1] === relationshipId);
  const target = relationship?.match(/\bTarget=["']([^"']+)["']/i)?.[1];
  if (!target) throw Object.assign(new Error('تعذر تحديد ورقة Excel الأولى.'), { status: 400 });
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  const sheet = entries.get(sheetPath);
  if (!sheet) throw Object.assign(new Error('ورقة Excel الأولى غير متاحة.'), { status: 400 });
  const sharedStrings = [...(entries.get('xl/sharedStrings.xml') || '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)]
    .map((match) => [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((text) => xmlText(text[1])).join(''));
  const rows = [];
  const rowNumbers = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    const rowNumber = Number(rowMatch[0].match(/\br=["'](\d+)["']/i)?.[1]) || rows.length + 1;
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi)) {
      const reference = cellMatch[1].match(/\br=["']([^"']+)["']/i)?.[1];
      const column = xlsxColumnIndex(reference);
      if (column < 0 || column > 100) continue;
      const type = cellMatch[1].match(/\bt=["']([^"']+)["']/i)?.[1] || '';
      const value = cellMatch[2] || '';
      const raw = type === 'inlineStr'
        ? [...value.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((match) => xmlText(match[1])).join('')
        : xmlText(value.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] || '');
      row[column] = type === 's' ? sharedStrings[Number(raw)] || '' : raw;
    }
    if (row.some((value) => String(value || '').trim())) {
      rows.push(row.map((value) => String(value || '').trim()));
      rowNumbers.push(rowNumber);
    }
  }
  if (rows.length < 2) throw Object.assign(new Error('يجب أن يحتوي الملف على صف عناوين وصف مؤثر واحد على الأقل.'), { status: 400 });
  return { rows, rowNumbers };
}

function xlsxPhotoArchive(base64) {
  if (typeof base64 !== 'string' || base64.length > 40_000_000
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw Object.assign(new Error('ملف Excel فارغ أو يتجاوز الحجم المسموح.'), { status: 400 });
  }
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw Object.assign(new Error('ارفع ملف Excel من نوع .xlsx.'), { status: 400 });
  }
  const archive = zipEntries(buffer, {
    maxEntries: 2500,
    maxEntryBytes: 10 * 1024 * 1024,
    maxExpandedBytes: 100 * 1024 * 1024,
    include: (name) => name === '[Content_Types].xml' || name === 'xl/workbook.xml'
      || name === 'xl/_rels/workbook.xml.rels' || name === 'xl/sharedStrings.xml'
      || /^xl\/worksheets\/(?:[^/]+\.xml|_rels\/[^/]+\.rels)$/i.test(name)
      || /^xl\/drawings\/(?:[^/]+\.xml|_rels\/[^/]+\.rels)$/i.test(name)
      || /^xl\/media\/[^/]+$/i.test(name)
      || /^xl\/(?:cellimages\.xml|_rels\/cellimages\.xml\.rels|metadata\.xml)$/i.test(name)
      || /^xl\/richdata\/(?:[^/]+\.xml|_rels\/[^/]+\.rels)$/i.test(name)
  });
  return new Map(archive);
}

function xlsxRelationshipPath(sourcePath) {
  return `${posix.dirname(sourcePath)}/_rels/${posix.basename(sourcePath)}.rels`;
}

function resolveXlsxTarget(sourcePath, target) {
  const value = String(target || '').replace(/\\/g, '/');
  if (!value || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || value.startsWith('//')) return '';
  const resolved = value.startsWith('/') ? posix.normalize(value.slice(1))
    : posix.normalize(posix.join(posix.dirname(sourcePath), value));
  return !resolved || resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')
    ? '' : resolved;
}

function xlsxAttributes(xml) {
  return Object.fromEntries([...String(xml || '').matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(["'])(.*?)\2/g)]
    .map((match) => [match[1].split(':').at(-1), xmlText(match[3])]));
}

function xlsxRelationshipMap(xml, sourcePath) {
  const relationships = new Map();
  for (const match of String(xml || '').matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*)\/?>/gi)) {
    const attributes = xlsxAttributes(match[1]);
    if (!attributes.Id || attributes.TargetMode?.toLocaleLowerCase() === 'external') continue;
    const target = resolveXlsxTarget(sourcePath, attributes.Target);
    if (target) relationships.set(attributes.Id, target);
  }
  return relationships;
}

function xlsxImageAttributions(archive, sheetPath) {
  const sheetXml = archive.get(sheetPath)?.toString('utf8') || '';
  const rowImages = new Map();
  let unresolvedImageCount = 0;
  const referencedMedia = new Set();
  const addImage = (rowNumber, image) => {
    if (!rowNumber || rowNumber <= 1 || !image) { unresolvedImageCount += 1; return; }
    rowImages.set(rowNumber, [...(rowImages.get(rowNumber) || []), image]);
  };
  const sheetRelationships = xlsxRelationshipMap(
    archive.get(xlsxRelationshipPath(sheetPath))?.toString('utf8'), sheetPath
  );
  const drawingIds = [...sheetXml.matchAll(/<(?:[\w.-]+:)?drawing\b([^>]*)\/?>/gi)]
    .map((match) => xlsxAttributes(match[1]).id).filter(Boolean);
  for (const drawingId of drawingIds) {
    const drawingPath = sheetRelationships.get(drawingId);
    const drawingXml = archive.get(drawingPath)?.toString('utf8') || '';
    const imageRelationships = xlsxRelationshipMap(
      archive.get(xlsxRelationshipPath(drawingPath || ''))?.toString('utf8'), drawingPath || ''
    );
    const anchors = [...drawingXml.matchAll(/<(?:[\w.-]+:)?(twoCellAnchor|oneCellAnchor)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\1>/gi)];
    for (const anchor of anchors) {
      const content = anchor[2];
      const imageIds = [...content.matchAll(/<(?:[\w.-]+:)?blip\b([^>]*)\/?>/gi)]
        .map((match) => xlsxAttributes(match[1]).embed).filter(Boolean);
      if (!imageIds.length) continue;
      const from = content.match(/<(?:[\w.-]+:)?from\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?from>/i)?.[1] || '';
      const to = content.match(/<(?:[\w.-]+:)?to\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?to>/i)?.[1] || '';
      const fromColumn = Number(from.match(/<(?:[\w.-]+:)?col\b[^>]*>\s*(\d+)\s*<\/(?:[\w.-]+:)?col>/i)?.[1]);
      const fromRow = Number(from.match(/<(?:[\w.-]+:)?row\b[^>]*>\s*(\d+)\s*<\/(?:[\w.-]+:)?row>/i)?.[1]);
      const toColumn = Number(to.match(/<(?:[\w.-]+:)?col\b[^>]*>\s*(\d+)\s*<\/(?:[\w.-]+:)?col>/i)?.[1]);
      const toRow = Number(to.match(/<(?:[\w.-]+:)?row\b[^>]*>\s*(\d+)\s*<\/(?:[\w.-]+:)?row>/i)?.[1]);
      const exactCellAnchor = anchor[1].toLocaleLowerCase() === 'twocellanchor'
        && fromColumn === 3 && Number.isInteger(fromRow)
        && Number.isInteger(toColumn) && toColumn >= fromColumn && toColumn <= 4
        && Number.isInteger(toRow) && toRow >= fromRow && toRow <= fromRow + 1;
      for (const imageId of imageIds) {
        const imagePath = imageRelationships.get(imageId);
        const image = archive.get(imagePath);
        if (imagePath) referencedMedia.add(imagePath);
        if (!exactCellAnchor || !image) { unresolvedImageCount += 1; continue; }
        addImage(fromRow + 1, image);
      }
    }
    if (!drawingPath) unresolvedImageCount += 1;
  }

  const cellImagesPath = [...archive.keys()].find((name) => /^xl\/cellimages\.xml$/i.test(name));
  if (cellImagesPath) {
    const cellImagesXml = archive.get(cellImagesPath).toString('utf8');
    const cellImagesRelationships = xlsxRelationshipMap(
      archive.get(xlsxRelationshipPath(cellImagesPath))?.toString('utf8'), cellImagesPath
    );
    const cellImagePaths = [];
    for (const match of cellImagesXml.matchAll(/<(?:[\w.-]+:)?cellImage\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?cellImage>/gi)) {
      const ids = [...match[1].matchAll(/<(?:[\w.-]+:)?blip\b([^>]*)\/?>/gi)]
        .map((entry) => xlsxAttributes(entry[1]).embed).filter(Boolean);
      const imagePath = ids.length === 1 ? cellImagesRelationships.get(ids[0]) : '';
      const image = archive.get(imagePath);
      if (imagePath) referencedMedia.add(imagePath);
      cellImagePaths.push(image ? imagePath : '');
    }

    const richDataPath = (name) => [...archive.keys()].find((path) => path.toLocaleLowerCase() === `xl/richdata/${name}`.toLocaleLowerCase());
    const richRelationsPath = richDataPath('richValueRel.xml');
    const richValuesPath = richDataPath('richValueData.xml');
    const metadataPath = [...archive.keys()].find((path) => path.toLocaleLowerCase() === 'xl/metadata.xml');
    const richRelationships = xlsxRelationshipMap(
      richRelationsPath ? archive.get(xlsxRelationshipPath(richRelationsPath))?.toString('utf8') : '',
      richRelationsPath || ''
    );
    const richRelationIds = [...(richRelationsPath ? archive.get(richRelationsPath).toString('utf8') : '')
      .matchAll(/<(?:[\w.-]+:)?rel\b([^>]*)\/?>/gi)]
      .map((match) => xlsxAttributes(match[1]).id);
    const richValueXml = richValuesPath ? archive.get(richValuesPath).toString('utf8') : '';
    const richValues = [...richValueXml.matchAll(/<(?:[\w.-]+:)?rv\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?rv>/gi)]
      .map((match) => {
        const values = [...match[2].matchAll(/<(?:[\w.-]+:)?v\b[^>]*>\s*(\d+)\s*<\/(?:[\w.-]+:)?v>/gi)]
          .map((entry) => Number(entry[1]));
        return values.length === 1 ? values[0] : null;
      });
    const metadataXml = metadataPath ? archive.get(metadataPath).toString('utf8') : '';
    const metadataTypes = [...metadataXml.matchAll(/<(?:[\w.-]+:)?metadataType\b([^>]*)\/?>/gi)]
      .map((match) => xlsxAttributes(match[1]).name || '');
    const futureMetadata = new Map();
    for (const match of metadataXml.matchAll(/<(?:[\w.-]+:)?futureMetadata\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?futureMetadata>/gi)) {
      const name = xlsxAttributes(match[1]).name || '';
      futureMetadata.set(name, [...match[2].matchAll(/<(?:[\w.-]+:)?bk\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?bk>/gi)]
        .map((entry) => entry[1]));
    }
    const cellMetadata = [...metadataXml.matchAll(/<(?:[\w.-]+:)?cellMetadata\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?cellMetadata>/gi)]
      .flatMap((match) => [...match[1].matchAll(/<(?:[\w.-]+:)?bk\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?bk>/gi)]
        .map((entry) => entry[1]));
    const imageValueIndexByMetadata = (metadataIndex) => {
      const cellMetadataEntry = cellMetadata[metadataIndex - 1];
      if (!cellMetadataEntry) return null;
      for (const match of cellMetadataEntry.matchAll(/<(?:[\w.-]+:)?rc\b([^>]*)\/?>/gi)) {
        const attributes = xlsxAttributes(match[1]);
        const typeIndex = Number(attributes.t);
        const typeName = metadataTypes[typeIndex - 1];
        if (typeName !== 'XLRICHVALUE') continue;
        const richMetadata = futureMetadata.get(typeName)?.[Number(attributes.v)];
        const richValueReference = richMetadata?.match(/<(?:[\w.-]+:)?rvb\b([^>]*)\/?>/i);
        const richValueIndex = richValueReference
          ? Number(xlsxAttributes(richValueReference[1]).i) : Number.NaN;
        return Number.isInteger(richValueIndex) ? richValueIndex : null;
      }
      return null;
    };
    const inCellRows = new Set();
    for (const match of sheetXml.matchAll(/<(?:[\w.-]+:)?c\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?c>/gi)) {
      const attributes = xlsxAttributes(match[1]);
      if (!attributes.r || xlsxColumnIndex(attributes.r) !== 3 || !attributes.vm) continue;
      const rowNumber = Number(attributes.r.match(/\d+$/)?.[0]);
      const richValueIndex = imageValueIndexByMetadata(Number(attributes.vm));
      const relationIndex = richValueIndex === null ? null : richValues[richValueIndex];
      const relationId = relationIndex === null ? '' : richRelationIds[relationIndex];
      const imagePath = relationId ? richRelationships.get(relationId) : '';
      const image = archive.get(imagePath);
      if (!image) { unresolvedImageCount += 1; continue; }
      if (!cellImagePaths.includes(imagePath)) { unresolvedImageCount += 1; continue; }
      referencedMedia.add(imagePath);
      addImage(rowNumber, image);
      inCellRows.add(rowNumber);
    }
    const referencedCellImageCount = cellImagePaths.filter(Boolean).length;
    if (!inCellRows.size && referencedCellImageCount) unresolvedImageCount += referencedCellImageCount;
  }

  const mediaPaths = [...archive.keys()].filter((name) => /^xl\/media\/[^/]+$/i.test(name));
  for (const mediaPath of mediaPaths) if (!referencedMedia.has(mediaPath)) unresolvedImageCount += 1;
  return { rowImages, unresolvedImageCount };
}

function readXlsxPhotoRows(base64) {
  const archive = xlsxPhotoArchive(base64);
  const workbookXml = archive.get('xl/workbook.xml')?.toString('utf8') || '';
  const workbookRelationships = xlsxRelationshipMap(
    archive.get('xl/_rels/workbook.xml.rels')?.toString('utf8'), 'xl/workbook.xml'
  );
  const sheet = workbookXml.match(/<(?:[\w.-]+:)?sheet\b([^>]*)\/?>/i);
  const sheetRelationshipId = xlsxAttributes(sheet?.[1]).id;
  const sheetPath = workbookRelationships.get(sheetRelationshipId);
  const sheetXml = sheetPath ? archive.get(sheetPath)?.toString('utf8') || '' : '';
  if (!sheetPath || !sheetXml) throw Object.assign(new Error('تعذر العثور على ورقة Excel داخل الملف.'), { status: 400 });
  const sharedStringsXml = archive.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const sharedStrings = [...sharedStringsXml.matchAll(/<(?:[\w.-]+:)?si\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?si>/gi)]
    .map((match) => [...match[1].matchAll(/<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t>/gi)]
      .map((entry) => xmlText(entry[1])).join(''));
  const worksheetRows = new Map();
  for (const rowMatch of sheetXml.matchAll(/<(?:[\w.-]+:)?row\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?row>/gi)) {
    const rowNumber = Number(xlsxAttributes(rowMatch[1]).r);
    if (!Number.isInteger(rowNumber) || rowNumber < 1) continue;
    if (worksheetRows.has(rowNumber)) {
      throw Object.assign(new Error('يحتوي ملف Excel على رقم صف مكرر.'), { status: 400 });
    }
    const cells = new Map();
    for (const cellMatch of rowMatch[2].matchAll(/<(?:[\w.-]+:)?c\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?c>/gi)) {
      const attributes = xlsxAttributes(cellMatch[1]);
      const column = xlsxColumnIndex(attributes.r);
      if (!attributes.r || column < 0) continue;
      const type = attributes.t || '';
      const rawValue = type === 'inlineStr'
        ? [...cellMatch[2].matchAll(/<(?:[\w.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?t>/gi)]
          .map((entry) => xmlText(entry[1])).join('')
        : xmlText(cellMatch[2].match(/<(?:[\w.-]+:)?v\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?v>/i)?.[1] || '');
      if (column > 4) {
        if (String(rawValue || '').trim()) throw Object.assign(new Error('توجد بيانات خارج أعمدة قالب الصور.'), { status: 400 });
        continue;
      }
      const imagePlaceholder = column === 3 && type === 'e' && Boolean(attributes.vm);
      if (imagePlaceholder) continue;
      if (cells.has(column)) throw Object.assign(new Error('يحتوي ملف Excel على مرجع خلية مكرر.'), { status: 400 });
      cells.set(column, type === 's' ? sharedStrings[Number(rawValue)] || '' : rawValue);
    }
    worksheetRows.set(rowNumber, cells);
  }
  const headers = [...(worksheetRows.get(1) || new Map()).entries()]
    .sort(([left], [right]) => left - right).map(([, value]) => normalizeImportHeader(value));
  const expectedHeaders = ['influencerid', 'mainusername', 'influencername', 'imagefilename', 'optionalnotes'];
  const legacyHeaders = ['influencerid', 'mainusername', 'influencername', 'influencerimage', 'optionalnotes'];
  if (headers.length !== 5 || (headers.join('|') !== expectedHeaders.join('|') && headers.join('|') !== legacyHeaders.join('|'))) {
    throw Object.assign(new Error('يجب أن يحتوي ملف Excel على الأعمدة Influencer ID وMain Username وInfluencer Name وImage File Name وOptional Notes بهذا الترتيب.'), { status: 400 });
  }
  const images = xlsxImageAttributions(archive, sheetPath);
  const rows = new Map([...worksheetRows].filter(([rowNumber]) => rowNumber > 1)
    .map(([rowNumber, cells]) => [rowNumber, {
      influencerId: String(cells.get(0) || '').trim(),
      username: String(cells.get(1) || '').trim(),
      name: String(cells.get(2) || '').trim(),
      imageFileName: String(cells.get(3) || '').trim(),
      notes: String(cells.get(4) || '').trim()
    }]));
  for (const rowNumber of images.rowImages.keys()) {
    if (rowNumber > 1 && !rows.has(rowNumber)) {
      rows.set(rowNumber, { influencerId: '', username: '', name: '', imageFileName: '', notes: '', images: images.rowImages.get(rowNumber) || [] });
    }
  }
  const items = [...rows.entries()].sort(([left], [right]) => left - right)
    .filter(([rowNumber, row]) => row.influencerId || row.username || row.name || row.imageFileName || images.rowImages.has(rowNumber))
    .map(([rowNumber, row]) => ({
      sourceRow: rowNumber,
      ...row,
      imageFileName: String(row.imageFileName || '').trim(),
      images: images.rowImages.get(rowNumber) || []
    }));
  if (!items.length) throw Object.assign(new Error('يجب أن يحتوي الملف على صف بيانات واحد على الأقل.'), { status: 400 });
  if (items.length > 1000) throw Object.assign(new Error('الحد الأقصى لمعاينة الدفعة 1000 صف.'), { status: 400 });
  return { items, unresolvedImageCount: images.unresolvedImageCount };
}

function readXlsxRows(base64) {
  return readXlsxWorksheet(base64).rows;
}

function readXlsxImportRows(base64) {
  const worksheet = readXlsxWorksheet(base64);
  const headers = worksheet.rows[0].map((header) => String(header || '').trim());
  const nonEmptyHeaders = headers.filter(Boolean);
  if (new Set(nonEmptyHeaders).size !== nonEmptyHeaders.length) {
    throw Object.assign(new Error('يحتوي ملف Excel على أسماء أعمدة مكررة.'), { status: 400 });
  }
  return worksheet.rows.slice(1).map((values, index) => {
    const row = Object.fromEntries(headers
      .map((header, column) => [header, values[column] || '']).filter(([header]) => header));
    Object.defineProperty(row, xlsxSourceRowNumber, { value: worksheet.rowNumbers[index + 1] });
    return row;
  });
}

function importIssueRow(input, index) {
  return input?.[xlsxSourceRowNumber] || index + 1;
}

function normalizeImportHeader(value) {
  return String(value || '').trim().toLocaleLowerCase()
    .normalize('NFKD').replace(/[\u064b-\u065f\u0670\u0640]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function normalizeImportCellValue(value) {
  return typeof value === 'string'
    ? value.replace(/[\u00a0\u200b\u202f\u2060\ufeff]/gu, '').trim()
    : value;
}

const offerImportHeaderAliases = {
  id: ['id', 'influencerid', 'recordid', 'معرفالمؤثر', 'المعرف', 'معرف', 'معرفالسجل'],
  username: ['username', 'user', 'userhandle', 'mainusername', 'اسمالمستخدم', 'اسمحساب', 'اليوزر', 'يوزر'],
  platform: ['platform', 'socialplatform', 'المنصة', 'منصة', 'التطبيق']
};

function importColumnIndexes(headerRow) {
  const normalized = headerRow.map(normalizeImportHeader);
  return Object.fromEntries(Object.entries(offerImportHeaderAliases).map(([key, aliases]) => [
    key, normalized.findIndex((header) => aliases.includes(header))
  ]));
}

function normalizeImportPlatform(value) {
  const normalized = String(value || '').trim().toLocaleLowerCase();
  if (['instagram', 'ig', 'انستجرام', 'انستغرام', 'إنستجرام', 'إنستغرام'].includes(normalized)) return 'Instagram';
  if (['tiktok', 'tik tok', 'تيك توك', 'تيكتوك'].includes(normalized)) return 'TikTok';
  if (['snapchat', 'snap', 'سناب', 'سناب شات'].includes(normalized)) return 'Snapchat';
  return '';
}

function normalizedImportUsername(value) {
  const source = String(value || '').normalize('NFKC').trim();
  if (!source) return '';
  let handle = source;
  const isProfileUrl = /^(?:https?:\/\/|(?:www\.)?(?:instagram\.com|tiktok\.com|snapchat\.com)(?:\/|$))/i.test(source);
  if (isProfileUrl) {
    try {
      const url = new URL(/^https?:\/\//i.test(source) ? source : `https://${source}`);
      const host = url.hostname.replace(/^www\./i, '').toLocaleLowerCase('en-US');
      const parts = url.pathname.split('/').filter(Boolean).map((part) => {
        try { return decodeURIComponent(part); }
        catch { return part; }
      });
      if (host === 'instagram.com') handle = parts[0] || '';
      else if (host === 'tiktok.com') handle = parts.find((part) => part.startsWith('@')) || parts[0] || '';
      else if (host === 'snapchat.com') {
        const addIndex = parts.findIndex((part) => part.toLocaleLowerCase('en-US') === 'add');
        handle = parts[addIndex + 1] || parts[0] || '';
      } else handle = parts[0] || '';
    } catch {
      return '';
    }
  }
  return handle.normalize('NFKC').replace(/^@+/, '').replace(/\s+/gu, '').toLocaleLowerCase('en-US');
}

function normalizedPhotoIdentityText(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

const influencerImportAccountFields = [
  { platform: 'Instagram', username: 'Username I', aliases: ['Instagram_Username', 'Instagram', 'Username Instagram', 'Instagram Username', 'Instagram Username I'], followers: 'Followers Count I' },
  { platform: 'TikTok', username: 'Username T', aliases: ['TikTok_Username', 'TikTok', 'Username Tiktok', 'Username TikTok', 'TikTok Username', 'Tiktok Username'], followers: 'Followers Count T' },
  { platform: 'Snapchat', username: 'Username', aliases: ['Username S', 'Snapchat_Username', 'Snapchat', 'Username Snapchat', 'Snapchat Username'], followers: 'Followers Count S' }
];
const influencerImportHeaders = {
  Name: ['name', 'influencername', 'creatorname', 'الاسم', 'اسمالمؤثر', 'اسمالمعلن'],
  Main_Username: ['mainusername', 'primaryusername', 'اسمالمستخدمالرئيسي'],
  id: ['id', 'influencerid', 'recordid', 'معرفالمؤثر', 'المعرف', 'معرف', 'معرفالسجل'],
  'Best Platform': ['bestplatform', 'primaryplatform', 'افضلالمنصات', 'افضلالمنصة', 'المنصةالافضل'],
  'Country Code': ['countrycode', 'dialcode', 'رمزالدولة', 'رمزالاتصال', 'مفتاحالدولة'],
  Number: ['number', 'phone', 'phonenumber', 'mobilenumber', 'رقمالهاتف', 'رقمالجوال', 'الهاتف', 'الجوال'],
  Full_Mobile_Number: ['fullmobilenumber', 'fullphone', 'رقمالجوالالكامل', 'الهاتفالكامل', 'الرقمبالرمزالدولي'],
  Country: ['country', 'الدولة'],
  Area: ['area', 'المنطقة'],
  City: ['city', 'المدينة'],
  Gender: ['gender', 'الجنس', 'نوعالمؤثر'],
  'Username I': ['usernamei', 'instagramusername', 'instagramusernamei', 'usernameinstagram', 'usernameinstagrami', 'انستجرام', 'انستغرام', 'اسمانستجرام', 'اسمانستغرام', 'اسمالحسابانستجرام', 'اسمالحسابانستغرام'],
  'Username T': ['usernamet', 'tiktokusername', 'usernametiktok', 'تيكتوك', 'تيك توك', 'اسمتكتوك', 'اسمتك توك', 'اسمالحسابتيكتوك', 'اسمالحسابتيك توك'],
  Username: ['username', 'usernames', 'usernamesnapchat', 'snapchatusername', 'username s', 'snapchat', 'سناب', 'سنابشات', 'يوزر سناب', 'اسمالحسابسناب'],
  'Followers Count I': ['followerscounti', 'instagramfollowers', 'instagramfollowerscount', 'followerscountinstagram', 'عددالمتابعينانستجرام', 'عددالمتابعينانستغرام', 'متابعينانستجرام', 'متابعينانستغرام'],
  'Followers Count T': ['followerscountt', 'tiktokfollowers', 'tiktokfollowerscount', 'followerscounttiktok', 'عددالمتابعينتيكتوك', 'عددالمتابعينتيك توك', 'متابعينتيكتوك', 'متابعينتيك توك'],
  'Followers Count S': ['followerscounts', 'snapchatfollowers', 'snapchatfollowerscount', 'followerscountsnapchat', 'عددالمتابعينسناب', 'عددالمتابعينسنابشات', 'متابعينسناب'],
  'Influencer Type I': ['influencertypei', 'instagramtier', 'نوعالمؤثراستجرام', 'شريحةانستجرام'],
  'Influencer Type T': ['influencertypet', 'tiktoktier', 'نوعالمؤثرتيكتوك', 'شريحةتيكتوك'],
  'Influencer Type S': ['influencertypes', 'snapchattier', 'نوعالمؤثرسناب', 'شريحةسناب'],
  'Overall Influencer Type': ['overallinfluencertype', 'overalltiert'],
  Verified: ['verified', 'توثيق', 'توثيقمنالمنصة', 'موثقمنالمنصة'],
  Mawthouq: ['mawthouq', 'موثوق', 'شهادةموثوق'],
  Speak: ['speak', 'contentstyle', 'طريقةالتقديم', 'اسلوبالمحتوى', 'طريقةالتحدث'],
  'Content Update': ['contentupdate', 'activecontent', 'تحديثالمحتوى', 'نشاطالمحتوى'],
  language: ['language', 'اللغة', 'لغةالمحتوى'],
  Classification: ['classification', 'التصنيف', 'تصنيفالمؤثر'],
  'Face Appearance': ['faceappearance', 'ظهورالوجه', 'الظهورفيالمحتوى'],
  Hijab: ['hijab', 'الحجاب'],
  'Full Classification': ['fullclassification', 'التصنيفالكامل'],
  'Categories 1': ['categories1', 'category1', 'الفئة1', 'التصنيف1'],
  'Categories 2': ['categories2', 'category2', 'الفئة2', 'التصنيف2'],
  'Categories 3': ['categories3', 'category3', 'الفئة3', 'التصنيف3'],
  'Categories 4': ['categories4', 'category4', 'الفئة4', 'التصنيف4'],
  Date: ['date', 'التاريخ', 'تاريخالتسجيل'],
  'Confrmation Source': ['confrmationsource', 'confirmationsource', 'مصدرالتأكيد', 'مصدرالتاكيد'],
  'Paid or Voucher': ['paidorvoucher', 'paidvoucher', 'الدفعأوالقسيمة', 'مدفوعأوقسيمة'],
  'Added By': ['addedby', 'addedbyuser', 'اضيفبواسطة', 'اضافهبواسطة', 'مسجلمنقبل'],
  Note: ['note', 'notes', 'ملاحظة', 'ملاحظات'],
  Interests: ['interests', 'الاهتمامات'],
  'Unmapped Interests': ['unmappedinterests'],
  'Unmapped Content Update': ['unmappedcontentupdate'],
  'Unmapped Language': ['unmappedlanguage'],
  'Internal Notes': ['internalnotes'],
  Price: ['price', 'السعر'],
  'Influencer Status': ['influencerstatus'],
  'Workflow Status': ['workflowstatus'],
  'Profile Image URL': ['profileimageurl'],
  'Import Source Column': ['importsourcecolumn', 'مصدرالاستيراد', 'مصدربياناتالاستيراد'],
  'Update Date': ['updatedate', 'تاريخالتحديث', 'تاريختحديثالمتابعين']
};
const influencerImportHeaderMap = new Map(Object.entries(influencerImportHeaders)
  .flatMap(([field, aliases]) => [field, ...aliases].map((alias) => [normalizeImportHeader(alias), field])));
for (const field of influencerImportAccountFields) {
  for (const alias of [field.username, ...field.aliases]) {
    influencerImportHeaderMap.set(normalizeImportHeader(alias), field.username);
  }
  const followerAliases = field.platform === 'Instagram'
    ? ['Instagram Followers', 'Instagram Followers Count', 'Followers Instagram', 'Followers Count Instagram']
    : field.platform === 'TikTok'
      ? ['TikTok Followers', 'TikTok Followers Count', 'Followers TikTok', 'Followers Count TikTok', 'Followers Count Tiktok']
      : ['Snapchat Followers', 'Snapchat Followers Count', 'Followers Snapchat', 'Followers Count Snapchat'];
  for (const alias of [field.followers, ...followerAliases]) {
    influencerImportHeaderMap.set(normalizeImportHeader(alias), field.followers);
  }
}

function normalizeInfluencerImportRows(rows) {
  const unknownColumns = new Set();
  const normalizedRows = rows.map((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const output = {};
    for (const [rawHeader, rawValue] of Object.entries(input)) {
      const cleanHeader = normalizeImportCellValue(rawHeader);
      const value = normalizeImportCellValue(rawValue);
      const header = normalizeImportHeader(cleanHeader);
      if (header === 'campaignref') continue;
      const canonical = influencerImportHeaderMap.get(header);
      if (canonical) output[canonical] = value;
      else {
        output[rawHeader] = value;
        if (cleanHeader) unknownColumns.add(cleanHeader);
      }
    }
    if (input[xlsxSourceRowNumber]) Object.defineProperty(output, xlsxSourceRowNumber, { value: input[xlsxSourceRowNumber] });
    return output;
  });
  return { rows: normalizedRows, unknownColumns: [...unknownColumns].sort((a, b) => a.localeCompare(b, 'en')) };
}

function findImportAccountAlignmentWarnings(rows) {
  return rows.flatMap((row, index) => influencerImportAccountFields
    .filter((field) => field.platform !== 'Snapchat')
    .flatMap((field) => {
    const hasUsername = Boolean(String(row?.[field.username] ?? '').trim());
    const hasFollowers = Boolean(String(row?.[field.followers] ?? '').trim());
    if (hasUsername === hasFollowers) return [];
    return [{
      row: importIssueRow(row, index),
      platform: field.platform,
      reason: hasFollowers ? 'followers-without-username' : 'username-without-followers'
    }];
  }));
}

function legacyAccountAliasEntries(record, field) {
  const canonicalHeader = normalizeImportHeader(field.username);
  return Object.entries(record || {})
    .filter(([key, value]) => normalizeImportHeader(key) !== canonicalHeader
      && influencerImportHeaderMap.get(normalizeImportHeader(key)) === field.username
      && String(value || '').trim());
}

function legacyAccountAliasValues(record, field) {
  return legacyAccountAliasEntries(record, field).map(([, value]) => String(value));
}

function influencerImportAccountValues(record, field) {
  return [...new Set([
    String(record?.[field.username] || '').trim(),
    ...legacyAccountAliasValues(record, field)
  ].filter(Boolean))];
}

function planLegacyAccountAliasNormalization(rows) {
  const accountOwners = new Map();
  const candidates = [];
  const removeAliases = new Map();
  let fieldConflicts = 0;
  const addOwner = (platform, value, id) => {
    const username = normalizedImportUsername(value);
    if (!username) return;
    const key = `${platform}\0${username}`;
    const owners = accountOwners.get(key) || new Set();
    owners.add(id);
    accountOwners.set(key, owners);
  };
  for (const row of rows) {
    for (const field of influencerImportAccountFields) {
      const standard = String(row.record?.[field.username] || '').trim();
      const aliases = legacyAccountAliasValues(row.record, field);
      const values = standard ? [standard, ...aliases] : aliases;
      const normalizedValues = new Set(values.map(normalizedImportUsername).filter(Boolean));
      for (const value of values) addOwner(field.platform, value, row.id);
      if (standard || !aliases.length) continue;
      if (normalizedValues.size !== 1) {
        fieldConflicts += 1;
        continue;
      }
      candidates.push({
        id: row.id, field, value: aliases[0], normalized: [...normalizedValues][0],
        aliasKeys: legacyAccountAliasEntries(row.record, field).map(([key]) => key)
      });
    }
  }
  const updates = new Map();
  const conflictingFields = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.field.platform}\0${candidate.normalized}`;
    const owners = accountOwners.get(key) || new Set();
    if (owners.size !== 1 || !owners.has(candidate.id)) {
      conflictingFields.add(`${candidate.id}\0${candidate.field.username}`);
      continue;
    }
    const record = updates.get(candidate.id) || {};
    record[candidate.field.username] = candidate.value;
    updates.set(candidate.id, record);
    const keys = removeAliases.get(candidate.id) || new Set();
    candidate.aliasKeys.forEach((key) => keys.add(key));
    removeAliases.set(candidate.id, keys);
  }
  return {
    updates,
    removeAliases,
    fieldsCopied: candidates.length - conflictingFields.size - fieldConflicts,
    conflicts: fieldConflicts + conflictingFields.size,
    conflictingAccountGroups: [...accountOwners.values()].filter((owners) => owners.size > 1).length,
    byPlatform: Object.fromEntries(influencerImportAccountFields.map((field) => [
      field.platform,
      [...updates.values()].filter((record) => Object.hasOwn(record, field.username)).length
    ]))
  };
}

function hasImportIdentity(record) {
  return Boolean(normalizePhone(record || {})
    || influencerImportAccountFields.some((field) =>
      influencerImportAccountValues(record, field).length));
}

function normalizedImportRecord(input) {
  const record = normalizeRecord({ ...input });
  for (const field of influencerImportAccountFields) {
    const rawUsername = String(record[field.username] ?? '').trim();
    if (rawUsername) {
      const username = normalizedImportUsername(rawUsername);
      if (!username) throw new Error('invalid-username');
      record[field.username] = username;
    }
    const rawFollowers = String(record[field.followers] ?? '').trim();
    if (rawFollowers) {
      const followers = parseImportedFollowerCount(rawFollowers);
      if (followers === null) throw new Error('invalid-follower-count');
      record[field.followers] = String(followers);
    }
  }
  const mainUsername = String(record.Main_Username ?? '').trim();
  if (mainUsername) {
    const username = normalizedImportUsername(mainUsername);
    if (!username) throw new Error('invalid-username');
    record.Main_Username = username;
  }
  normalizeImportedPhoneFields(record, input);
  return deriveInfluencerFields(record);
}

function importFileMetadata(body, rows) {
  const fileName = String(body.fileName || 'import.json').replace(/[\\/:*?"<>|]/g, '_').slice(0, 255);
  let bytes;
  if (typeof body.fileBase64 === 'string' && body.fileBase64) {
    bytes = Buffer.from(body.fileBase64, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== body.fileBase64.replace(/=+$/, '')) {
      throw Object.assign(new Error('ترميز الملف غير صالح.'), { status: 400 });
    }
  } else bytes = Buffer.from(JSON.stringify(rows));
  return { fileName, fileSha256: createHash('sha256').update(bytes).digest('hex') };
}

database.exec(`
  INSERT OR IGNORE INTO influencer_accounts (influencer_id, platform, normalized_username)
  SELECT source.influencer_id, source.platform, source.normalized_username
  FROM (
    SELECT id AS influencer_id, 'Instagram' AS platform,
      account_username(json_extract(record_json, '$."Username I"')) AS normalized_username
    FROM influencers
    UNION ALL
    SELECT id, 'TikTok', account_username(json_extract(record_json, '$."Username T"'))
    FROM influencers
    UNION ALL
    SELECT id, 'Snapchat', account_username(json_extract(record_json, '$."Username"'))
    FROM influencers
  ) AS source
  WHERE source.normalized_username <> ''
    AND NOT EXISTS (
      SELECT 1 FROM (
        SELECT 'Instagram' AS platform, account_username(json_extract(record_json, '$."Username I"')) AS normalized_username FROM influencers
        UNION ALL
        SELECT 'TikTok', account_username(json_extract(record_json, '$."Username T"')) FROM influencers
        UNION ALL
        SELECT 'Snapchat', account_username(json_extract(record_json, '$."Username"')) FROM influencers
      ) AS duplicate
      WHERE duplicate.platform = source.platform
        AND duplicate.normalized_username = source.normalized_username
      GROUP BY duplicate.platform, duplicate.normalized_username
      HAVING COUNT(*) > 1
    );
  CREATE TRIGGER IF NOT EXISTS influencers_accounts_after_insert
  AFTER INSERT ON influencers BEGIN
    INSERT INTO influencer_accounts (influencer_id, platform, normalized_username)
    SELECT NEW.id, platform, normalized_username FROM (
      SELECT 'Instagram' AS platform, account_username(json_extract(NEW.record_json, '$."Username I"')) AS normalized_username
      UNION ALL SELECT 'TikTok', account_username(json_extract(NEW.record_json, '$."Username T"'))
      UNION ALL SELECT 'Snapchat', account_username(json_extract(NEW.record_json, '$."Username"'))
    ) WHERE normalized_username <> '';
  END;
  CREATE TRIGGER IF NOT EXISTS influencers_accounts_after_update
  AFTER UPDATE OF record_json ON influencers BEGIN
    DELETE FROM influencer_accounts WHERE influencer_id = NEW.id;
    INSERT INTO influencer_accounts (influencer_id, platform, normalized_username)
    SELECT NEW.id, platform, normalized_username FROM (
      SELECT 'Instagram' AS platform, account_username(json_extract(NEW.record_json, '$."Username I"')) AS normalized_username
      UNION ALL SELECT 'TikTok', account_username(json_extract(NEW.record_json, '$."Username T"'))
      UNION ALL SELECT 'Snapchat', account_username(json_extract(NEW.record_json, '$."Username"'))
    ) WHERE normalized_username <> '';
  END;
`);
const influencerImportIdHeaders = new Set(['id', 'influencerid', 'recordid', 'معرفالمؤثر', 'المعرف', 'معرف', 'معرفالسجل']);
const influencerImportReviewReasons = new Set([
  'account-match-needs-review', 'identity-conflict', 'ambiguous-existing-account', 'ambiguous-phone-match',
  'phone-account-mismatch', 'phone-number-changed-needs-review', 'archived-match-needs-restore',
  'duplicate-account-in-file', 'duplicate-phone-in-file'
]);

function findDuplicateImportRows(rows) {
  const identityRows = new Map();
  for (const [index, input] of rows.entries()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    const record = { ...input };
    const keys = [];
    for (const field of influencerImportAccountFields) {
      if (!String(record[field.username] || '').trim()) {
        const alias = field.aliases.find((name) => String(record[name] || '').trim());
        if (alias) record[field.username] = record[alias];
      }
      const username = normalizedImportUsername(record[field.username]);
      if (username) keys.push({
        key: `account\u0000${field.platform}\u0000${username}`,
        kind: 'account',
        platform: field.platform,
        username: String(record[field.username]).trim().replace(/^@+/, '')
      });
    }
    for (const item of keys) {
      const group = identityRows.get(item.key) || { rows: new Set(), item };
      group.rows.add(index);
      identityRows.set(item.key, group);
    }
  }
  const duplicates = new Map();
  for (const group of identityRows.values()) {
    if (group.rows.size < 2) continue;
    for (const index of group.rows) {
      const issue = duplicates.get(index) || { accounts: [], phone: false };
      issue.accounts.push({ platform: group.item.platform, username: group.item.username });
      duplicates.set(index, issue);
    }
  }
  return duplicates;
}

function findDuplicateImportPhoneRows(rows) {
  const phoneRows = new Map();
  for (const [index, input] of rows.entries()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
    const phoneKey = normalizeImportedPhone(input);
    if (!phoneKey) continue;
    const indexes = phoneRows.get(phoneKey) || new Set();
    indexes.add(index);
    phoneRows.set(phoneKey, indexes);
  }
  return new Set([...phoneRows.values()].filter((indexes) => indexes.size > 1).flatMap((indexes) => [...indexes]));
}
function importPreviewFingerprint(rows, body, user) {
  return createHash('sha256').update(JSON.stringify({
    rows,
    file: importFileMetadata(body, rows),
    imageArchiveBase64: String(body.imageArchiveBase64 || ''),
    followersOnly: body.followersOnly === true,
    allowSensitiveChanges: body.allowSensitiveChanges === true && user.role === 'admin'
  })).digest('hex');
}

function saveInfluencerImportPreview(user, rows, body) {
  const now = Date.now();
  for (const [id, preview] of influencerImportPreviews) {
    if (preview.expiresAt <= now) influencerImportPreviews.delete(id);
  }
  while (influencerImportPreviews.size >= 1000) {
    influencerImportPreviews.delete(influencerImportPreviews.keys().next().value);
  }
  const previewId = randomBytes(32).toString('hex');
  influencerImportPreviews.set(previewId, {
    userId: user.id,
    fingerprint: importPreviewFingerprint(rows, body, user),
    expiresAt: now + 10 * 60 * 1000
  });
  return previewId;
}

function requireInfluencerImportPreview(user, rows, body) {
  const previewId = String(body.previewId || '');
  const preview = influencerImportPreviews.get(previewId);
  if (!preview || preview.expiresAt <= Date.now() || preview.userId !== user.id) {
    throw Object.assign(new Error('انتهت صلاحية المعاينة أو لا تخص حسابك؛ أعد معاينة الملف.'), { status: 410 });
  }
  if (preview.fingerprint !== importPreviewFingerprint(rows, body, user)) {
    throw Object.assign(new Error('تغير محتوى الملف أو خيارات الاستيراد بعد المعاينة؛ أعد المعاينة قبل التنفيذ.'), { status: 409 });
  }
  return previewId;
}

function getAccountConflictReport() {
  const parseRecord = (recordJson, id) => {
    try { return JSON.parse(recordJson || '{}'); }
    catch { throw new Error(`تعذر قراءة سجل المؤثر ${id} لإعداد تقرير التعارضات.`); }
  };
  const getAccountKeys = (record) => influencerImportAccountFields.flatMap((account) => {
    const values = new Map();
    for (const username of influencerImportAccountValues(record, account)) {
      const normalized = normalizedImportUsername(username);
      if (normalized && !values.has(normalized)) values.set(normalized, username);
    }
    return [...values].map(([normalized, username]) => ({
      platform: account.platform,
      accountField: account.username,
      normalized,
      username
    }));
  });
  const groupKey = (account) => `${account.platform}\u0000${account.normalized}`;
  const activeRows = database.prepare(`SELECT id, record_json AS recordJson
    FROM influencers WHERE archived_at IS NULL`).all();
  const groups = new Map();
  for (const row of activeRows) {
    const record = parseRecord(row.recordJson, row.id);
    for (const account of getAccountKeys(record)) {
      const key = groupKey(account);
      const group = groups.get(key) || {
        platform: account.platform, username: account.username, accountField: account.accountField,
        activeIds: new Set(), influencers: new Map()
      };
      group.activeIds.add(row.id);
      groups.set(key, group);
    }
  }
  for (const [key, group] of groups) {
    if (group.activeIds.size < 2) groups.delete(key);
  }
  if (!groups.size) return { generatedAt: new Date().toISOString(), groups: [] };

  const addInfluencer = (key, id, name, { current = false, archived = false } = {}) => {
    const group = groups.get(key);
    if (!group || !id) return;
    const influencer = group.influencers.get(id) || {
      id, name: '', historicalNames: [], current: false, archived: false
    };
    const normalizedName = String(name || '').trim();
    if (normalizedName && !influencer.historicalNames.includes(normalizedName)) {
      influencer.historicalNames.push(normalizedName);
    }
    if (normalizedName && (current || !influencer.name)) influencer.name = normalizedName;
    influencer.current ||= current;
    influencer.archived = archived;
    group.influencers.set(id, influencer);
  };

  const auditRows = database.prepare(`SELECT entity_id AS entityId,
      old_values_json AS oldValuesJson, new_values_json AS newValuesJson
    FROM audit_events
    WHERE entity_type = 'influencer' AND outcome = 'success'
    ORDER BY occurred_at ASC, id ASC`).all();
  for (const event of auditRows) {
    for (const valuesJson of [event.oldValuesJson, event.newValuesJson]) {
      if (!valuesJson) continue;
      const values = JSON.parse(valuesJson);
      if (!values?.record || typeof values.record !== 'object') continue;
      const id = String(values.id || event.entityId || '');
      for (const account of getAccountKeys(values.record)) {
        addInfluencer(groupKey(account), id, values.name || values.record.Name);
      }
    }
  }

  const currentRows = database.prepare(`SELECT id, record_json AS recordJson,
      archived_at AS archivedAt FROM influencers`).all();
  for (const row of currentRows) {
    const record = parseRecord(row.recordJson, row.id);
    for (const account of getAccountKeys(record)) {
      addInfluencer(groupKey(account), row.id, record.Name, {
        current: !row.archivedAt,
        archived: Boolean(row.archivedAt)
      });
    }
  }

  const order = new Map(influencerImportAccountFields.map((account, index) => [account.platform, index]));
  return {
    generatedAt: new Date().toISOString(),
    groups: [...groups.values()]
      .sort((left, right) => (order.get(left.platform) - order.get(right.platform))
        || left.username.localeCompare(right.username, 'en'))
      .map((group) => ({
        platform: group.platform,
        username: group.username,
        accountField: group.accountField,
        influencers: [...group.influencers.values()]
          .sort((left, right) => left.id.localeCompare(right.id))
      }))
  };
}

const profileImageMaxBytes = 5 * 1024 * 1024;
const profileImageMimeTypes = new Map([
  ['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']
]);
const profileImageCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

function profileImageCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = profileImageCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(buffer) {
  let offset = 8;
  let hasHeader = false;
  let hasData = false;
  let hasEnd = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) return false;
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const chunk = buffer.subarray(offset + 4, end - 4);
    if (profileImageCrc32(chunk) !== buffer.readUInt32BE(end - 4)) return false;
    if (!hasHeader) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = buffer.readUInt32BE(offset + 8);
      const height = buffer.readUInt32BE(offset + 12);
      if (!width || !height || width > 12000 || height > 12000) return false;
      hasHeader = true;
    } else if (type === 'IHDR') return false;
    if (type === 'IDAT') hasData = true;
    if (type === 'IEND') {
      if (length !== 0 || !hasData || end !== buffer.length) return false;
      hasEnd = true;
      break;
    }
    offset = end;
  }
  return hasHeader && hasData && hasEnd;
}

function validJpeg(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) return false;
  let offset = 2;
  let hasFrame = false;
  let hasScan = false;
  while (offset < buffer.length - 2) {
    if (buffer[offset++] !== 0xff) return false;
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (!marker || marker === 0x00) return false;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return false;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) return false;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (!width || !height || width > 12000 || height > 12000) return false;
      hasFrame = true;
    }
    if (marker === 0xda) {
      hasScan = hasFrame && length >= 6 && offset + length < buffer.length - 2;
      break;
    }
    offset += length;
  }
  return hasFrame && hasScan;
}

function validWebp(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP'
    || buffer.readUInt32LE(4) !== buffer.length - 8) return false;
  let offset = 12;
  let hasImage = false;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const end = dataStart + length;
    if (end > buffer.length) return false;
    if (type === 'VP8X' && length >= 10) {
      const width = 1 + buffer.readUIntLE(dataStart + 4, 3);
      const height = 1 + buffer.readUIntLE(dataStart + 7, 3);
      if (!width || !height || width > 12000 || height > 12000) return false;
    } else if (type === 'VP8L' && length >= 5) {
      if (buffer[dataStart] !== 0x2f) return false;
      const width = 1 + buffer[dataStart + 1] + ((buffer[dataStart + 2] & 0x3f) << 8);
      const height = 1 + (buffer[dataStart + 2] >> 6) + (buffer[dataStart + 3] << 2) + ((buffer[dataStart + 4] & 0x0f) << 10);
      if (!width || !height || width > 12000 || height > 12000) return false;
      hasImage = true;
    } else if (type === 'VP8 ' && length >= 10) {
      if (buffer[dataStart + 3] !== 0x9d || buffer[dataStart + 4] !== 0x01 || buffer[dataStart + 5] !== 0x2a) return false;
      const width = buffer.readUInt16LE(dataStart + 6) & 0x3fff;
      const height = buffer.readUInt16LE(dataStart + 8) & 0x3fff;
      if (!width || !height || width > 12000 || height > 12000) return false;
      hasImage = true;
    } else if (type === 'ANMF' && length >= 16) hasImage = true;
    offset = end + (length & 1);
  }
  return offset === buffer.length && hasImage;
}

function profileImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > profileImageMaxBytes) return '';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return validPng(buffer) ? 'image/png' : '';
  if (validJpeg(buffer)) return 'image/jpeg';
  if (validWebp(buffer)) return 'image/webp';
  return '';
}

const clientLogoMaxBytes = 2 * 1024 * 1024;
function imageDimensions(buffer, mimeType) {
  if (mimeType === 'image/png') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset < buffer.length - 2) {
      if (buffer[offset++] !== 0xff) return null;
      while (buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset++];
      if (!marker || marker === 0x00) return null;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) return null;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) return null;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
    return null;
  }
  if (mimeType === 'image/webp') {
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const type = buffer.toString('ascii', offset, offset + 4);
      const length = buffer.readUInt32LE(offset + 4);
      const dataStart = offset + 8;
      if (dataStart + length > buffer.length) return null;
      if (type === 'VP8X' && length >= 10) {
        return { width: 1 + buffer.readUIntLE(dataStart + 4, 3), height: 1 + buffer.readUIntLE(dataStart + 7, 3) };
      }
      if (type === 'VP8L' && length >= 5 && buffer[dataStart] === 0x2f) {
        return {
          width: 1 + buffer[dataStart + 1] + ((buffer[dataStart + 2] & 0x3f) << 8),
          height: 1 + (buffer[dataStart + 2] >> 6) + (buffer[dataStart + 3] << 2) + ((buffer[dataStart + 4] & 0x0f) << 10)
        };
      }
      if (type === 'VP8 ' && length >= 10) {
        return { width: buffer.readUInt16LE(dataStart + 6) & 0x3fff, height: buffer.readUInt16LE(dataStart + 8) & 0x3fff };
      }
      offset = dataStart + length + (length & 1);
    }
  }
  return null;
}

function validateClientLogo(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.dataBase64 !== 'string' || typeof value.mimeType !== 'string') {
    throw Object.assign(new Error('ملف شعار العميل غير صالح.'), { status: 400 });
  }
  const encoded = value.dataBase64;
  if (encoded.length > Math.ceil(clientLogoMaxBytes / 3) * 4) {
    throw Object.assign(new Error('يجب ألا يتجاوز شعار العميل 2 ميجابايت.'), { status: 413 });
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw Object.assign(new Error('ترميز شعار العميل غير صالح.'), { status: 400 });
  }
  const fileData = Buffer.from(encoded, 'base64');
  if (!fileData.length || fileData.length > clientLogoMaxBytes) {
    throw Object.assign(new Error('يجب ألا يتجاوز شعار العميل 2 ميجابايت.'), { status: fileData.length ? 413 : 400 });
  }
  const mimeType = profileImageMime(fileData);
  const dimensions = mimeType ? imageDimensions(fileData, mimeType) : null;
  if (!mimeType || value.mimeType !== mimeType || !dimensions
    || !dimensions.width || !dimensions.height || dimensions.width > 12000 || dimensions.height > 12000) {
    throw Object.assign(new Error('يُقبل شعار PNG أو JPG أو WebP صالح فقط، مع أبعاد صورة سليمة.'), { status: 400 });
  }
  return { mimeType, width: dimensions.width, height: dimensions.height, fileData };
}

function savePresentationClientLogo(presentationId, logo, updatedAt) {
  if (logo === undefined) return;
  if (logo === null) {
    database.prepare('DELETE FROM campaign_presentation_client_logos WHERE presentation_id = ?').run(presentationId);
    return;
  }
  database.prepare(`INSERT INTO campaign_presentation_client_logos
    (presentation_id, mime_type, width, height, file_data, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(presentation_id) DO UPDATE SET mime_type = excluded.mime_type,
      width = excluded.width, height = excluded.height, file_data = excluded.file_data,
      updated_at = excluded.updated_at`)
    .run(presentationId, logo.mimeType, logo.width, logo.height, logo.fileData, updatedAt);
}

function validatePresentationSettings(body, current = {}) {
  const mode = body.presentationMode === undefined
    ? current.presentationMode || 'selecting' : body.presentationMode;
  if (!['selecting', 'visits'].includes(mode)) {
    throw Object.assign(new Error('وضع العرض غير صالح.'), { status: 400 });
  }
  const textValue = (value, fallback, maxLength, label) => {
    if (value === undefined) return fallback || '';
    if (typeof value !== 'string' || value.trim().length > maxLength) {
      throw Object.assign(new Error(`${label} غير صالح أو يتجاوز الحد المسموح.`), { status: 400 });
    }
    return value.trim();
  };
  let packageVisitsCount = body.packageVisitsCount === undefined
    ? current.packageVisitsCount ?? null : body.packageVisitsCount;
  if (packageVisitsCount === '' || packageVisitsCount === null) packageVisitsCount = null;
  else {
    packageVisitsCount = Number(packageVisitsCount);
    if (!Number.isSafeInteger(packageVisitsCount) || packageVisitsCount < 0) {
      throw Object.assign(new Error('عدد زيارات الباقة يجب أن يكون رقمًا صحيحًا غير سالب.'), { status: 400 });
    }
  }
  if (mode !== 'visits') packageVisitsCount = null;
  return {
    mode,
    title: textValue(body.headerTitle, current.headerTitle, 120, 'عنوان الرابط'),
    tagline: textValue(body.headerTagline, current.headerTagline, 300, 'السطر التعريفي'),
    packageVisitsCount
  };
}

function profileImageSourceUrl(record) {
  return String(record?.['Profile Image URL'] || record?.Profile_Image_URL || record?.Profile_Picture_URL
    || record?.Avatar_URL || record?.['Profile Picture URL'] || record?.['Profile Image']
    || record?.['Profile Picture'] || record?.['Image URL'] || record?.Photo_URL || '').trim();
}

function profilePlaceholderUrl(record) {
  const gender = String(record?.Gender || '').trim().toLocaleLowerCase();
  if (['male', 'm', 'ذكر'].includes(gender)) return '/assets/avatars/male.svg';
  if (['female', 'f', 'أنثى', 'انثى'].includes(gender)) {
    const hijab = String(record?.Hijab || '').trim().toLocaleLowerCase();
    return ['yes', 'y', 'نعم', 'true', '1'].includes(hijab)
      ? '/assets/avatars/female-hijab.svg' : '/assets/avatars/female.svg';
  }
  return '/assets/avatars/neutral.svg';
}

function isPublicIpv4(address) {
  if (isIP(address) !== 4) return false;
  const [first, second, third] = address.split('.').map(Number);
  return !(first === 0 || first === 10 || first === 127 || first >= 224
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168 || (second === 88 && third === 99)))
    || (first === 192 && second === 0 && third === 2)
    || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
    || (first === 203 && second === 0 && third === 113));
}

async function fetchProfileImage(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('invalid-image-url'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('invalid-image-url');
  }
  let addresses;
  try { addresses = await lookup(url.hostname, { all: true, verbatim: true }); }
  catch { throw new Error('image-host-unavailable'); }
  const address = addresses.find((item) => isPublicIpv4(item.address));
  if (!address) throw new Error('image-host-not-public');
  return new Promise((resolveImage, rejectImage) => {
    let settled = false;
    const finish = (error, image) => {
      if (settled) return;
      settled = true;
      if (error) rejectImage(error);
      else resolveImage(image);
    };
    const request = https.request({
      hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method: 'GET',
      servername: isIP(url.hostname) ? undefined : url.hostname,
      lookup: (_hostname, options, callback) => {
        if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
      headers: { Accept: 'image/jpeg,image/png,image/webp', 'User-Agent': 'FikratakCRM/1.0' }
    }, (response) => {
      if (response.statusCode !== 200 || (response.headers.location && response.statusCode >= 300 && response.statusCode < 400)) {
        response.resume();
        finish(new Error('image-download-failed'));
        return;
      }
      const contentType = String(response.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (!profileImageMimeTypes.has(contentType)
        || Number(response.headers['content-length'] || 0) > profileImageMaxBytes) {
        response.resume();
        finish(new Error('invalid-image-content'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > profileImageMaxBytes) {
          response.destroy();
          finish(new Error('image-too-large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const image = Buffer.concat(chunks);
        finish(profileImageMime(image) === contentType ? null : new Error('invalid-image-content'), image);
      });
      response.on('error', () => finish(new Error('image-download-failed')));
    });
    request.setTimeout(8000, () => request.destroy(new Error('image-download-timeout')));
    request.on('error', () => finish(new Error('image-download-failed')));
    request.end();
  });
}

function parseProfileImageArchive(base64) {
  if (typeof base64 !== 'string' || base64.length > 27_000_000
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw Object.assign(new Error('ملف ZIP للصور غير صالح.'), { status: 400 });
  }
  const buffer = Buffer.from(base64, 'base64');
  const entries = zipEntries(buffer, {
    maxEntries: 1000,
    maxEntryBytes: profileImageMaxBytes,
    maxExpandedBytes: 100 * 1024 * 1024
  });
  const files = [...entries].filter(([name]) => !name.endsWith('/')).map(([name, data]) => ({
    fileName: name.split('/').at(-1) || name,
    buffer: data
  }));
  if (files.length > 500) throw Object.assign(new Error('يتجاوز ZIP الحد الأقصى البالغ 500 صورة.'), { status: 400 });
  return files;
}

function importImageUrl(row) {
  const urlHeaders = new Set(['profileimageurl', 'profilepictureurl', 'avatarurl', 'imageurl', 'photourl']);
  const entry = Object.entries(row || {}).find(([key]) => urlHeaders.has(normalizeImportHeader(key)));
  return typeof entry?.[1] === 'string' ? entry[1].trim() : '';
}

function importImageId(row) {
  const aliases = new Set(['id', 'influencerid', 'recordid', 'معرفالمؤثر', 'معرفالسجل']);
  const entry = Object.entries(row || {}).find(([key]) => aliases.has(normalizeImportHeader(key)));
  const id = String(entry?.[1] || '').trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(id) ? id : '';
}

function importImageAccountKeys(row) {
  const entries = [];
  for (const field of influencerImportAccountFields) {
    const value = row?.[field.username] ?? field.aliases.map((alias) => row?.[alias]).find((item) => String(item || '').trim());
    const username = normalizedImportUsername(value);
    if (username) entries.push({ platform: field.platform, username });
  }
  const genericUsername = Object.entries(row || {}).find(([key, value]) =>
    normalizeImportHeader(key) === 'username' && String(value || '').trim())?.[1];
  const genericPlatform = Object.entries(row || {}).find(([key, value]) =>
    ['platform', 'socialplatform'].includes(normalizeImportHeader(key)) && String(value || '').trim())?.[1];
  const platform = normalizeImportPlatform(genericPlatform);
  const username = normalizedImportUsername(genericUsername);
  if (platform && username) entries.push({ platform, username });
  return [...new Map(entries.map((item) => [`${item.platform}\0${item.username}`, item])).values()];
}

function parseProfileImageFileName(fileName) {
  const dot = fileName.lastIndexOf('.');
  if (dot < 1) return { error: 'unsupported-image-extension' };
  const extension = fileName.slice(dot + 1).toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(extension)) return { error: 'unsupported-image-extension' };
  const stem = fileName.slice(0, dot);
  const idMatch = stem.match(/^id[_-]([a-f0-9]{32})$/i);
  if (idMatch) return { id: idMatch[1].toLowerCase(), extension };
  const platformMatch = stem.match(/^(instagram|ig|tiktok|tik[_ -]?tok|snapchat|snap)[_-]+(.+)$/i);
  if (platformMatch) {
    const platform = normalizeImportPlatform(platformMatch[1].replace(/[_ -]/g, ''));
    const username = normalizedImportUsername(platformMatch[2]);
    return platform && username ? { platform, username, extension } : { error: 'invalid-image-name' };
  }
  const username = normalizedImportUsername(stem);
  return username ? { username, extension } : { error: 'invalid-image-name' };
}

function previewProfileImageImport(rows, imageArchiveBase64) {
  const report = { total: rows.length, matched: 0, missing: 0, issues: [], items: [] };
  const targets = rows.map((row, index) => ({
    row: importIssueRow(row, index),
    name: String(row?.Name || row?.name || '').trim(),
    accounts: importImageAccountKeys(row),
    image: importImageUrl(row) ? { source: 'url', fileName: '' } : null
  }));
  const rowKeys = new Map();
  const rowIds = new Map();
  for (const [index, row] of rows.entries()) {
    const id = importImageId(row);
    if (id) rowIds.set(id, [...(rowIds.get(id) || []), index]);
    for (const key of importImageAccountKeys(row)) {
      const identity = `${key.platform}\0${key.username}`;
      rowKeys.set(identity, [...(rowKeys.get(identity) || []), index]);
    }
  }

  if (imageArchiveBase64) {
    let files;
    try { files = parseProfileImageArchive(imageArchiveBase64); }
    catch (error) {
      files = [];
      report.issues.push({ fileName: 'profile-images.zip', reason: error.message || 'invalid-image-archive' });
    }
    for (const file of files) {
      const identity = parseProfileImageFileName(file.fileName);
      if (identity.error) {
        report.issues.push({ fileName: file.fileName, reason: identity.error });
        continue;
      }
      let rowIndexes = [];
      if (identity.id) rowIndexes = rowIds.get(identity.id) || [];
      else if (identity.platform) rowIndexes = rowKeys.get(`${identity.platform}\0${identity.username}`) || [];
      else rowIndexes = [...new Set([...rowKeys].filter(([key]) => key.endsWith(`\0${identity.username}`))
        .flatMap(([, indexes]) => indexes))];
      rowIndexes = [...new Set(rowIndexes)];
      if (identity.id && !rowIndexes.some((index) => importImageId(rows[index]) === identity.id)) {
        report.issues.push({ fileName: file.fileName, reason: 'image-id-conflict' });
        continue;
      }
      if (rowIndexes.length !== 1) {
        report.issues.push({
          fileName: file.fileName,
          reason: rowIndexes.length ? 'ambiguous-image-match' : 'unmatched-image'
        });
        continue;
      }
      const rowIndex = rowIndexes[0];
      const mimeType = profileImageMime(file.buffer);
      const extension = profileImageMimeTypes.get(mimeType);
      if (!extension || ![extension, ...(extension === 'jpg' ? ['jpeg'] : [])].includes(identity.extension)) {
        report.issues.push({ fileName: file.fileName, reason: 'invalid-image-content' });
        continue;
      }
      if (targets[rowIndex].image) {
        report.issues.push({ fileName: file.fileName, row: rowIndex + 1, reason: 'multiple-images-for-influencer' });
        continue;
      }
      targets[rowIndex].image = { source: 'zip', fileName: file.fileName };
    }
  }

  for (const target of targets) {
    if (target.image) report.matched += 1;
    else report.missing += 1;
    report.items.push({
      row: target.row,
      name: target.name,
      accounts: target.accounts,
      imageSource: target.image?.source || '',
      fileName: target.image?.fileName || ''
    });
  }
  const previewLimit = 200;
  report.items = report.items.slice(0, previewLimit);
  report.truncated = report.total > previewLimit;
  return report;
}

async function importProfileImages(rows, rowTargetIds, imageArchiveBase64) {
  const report = { added: 0, updated: 0, unchanged: 0, failed: 0, issues: [] };
  const candidates = [];
  for (const [index, row] of rows.entries()) {
    const url = importImageUrl(row);
    if (url) {
      const targetId = rowTargetIds[index] || '';
      const declaredId = importImageId(row);
      candidates.push({
        row: importIssueRow(row, index), targetId, url,
        ...(declaredId && declaredId !== targetId ? { identityError: 'image-id-conflict' } : {})
      });
    }
  }
  if (imageArchiveBase64) {
    let files;
    try { files = parseProfileImageArchive(imageArchiveBase64); }
    catch (error) {
      files = [];
      report.failed += 1;
      report.issues.push({ fileName: 'profile-images.zip', reason: error.message || 'invalid-image-archive' });
    }
    const rowKeys = new Map();
    const rowIds = new Map();
    for (const [index, row] of rows.entries()) {
      const id = importImageId(row);
      if (id) rowIds.set(id, [...(rowIds.get(id) || []), index]);
      for (const key of importImageAccountKeys(row)) {
        const identity = `${key.platform}\0${key.username}`;
        rowKeys.set(identity, [...(rowKeys.get(identity) || []), index]);
      }
    }
    const matchedTargets = new Set();
    for (const file of files) {
      const identity = parseProfileImageFileName(file.fileName);
      if (identity.error) {
        report.failed += 1;
        report.issues.push({ fileName: file.fileName, reason: identity.error });
        continue;
      }
      let rowIndexes = [];
      if (identity.id) rowIndexes = rowIds.get(identity.id) || [];
      else if (identity.platform) rowIndexes = rowKeys.get(`${identity.platform}\0${identity.username}`) || [];
      else rowIndexes = [...new Set([...rowKeys].filter(([key]) => key.endsWith(`\0${identity.username}`))
        .flatMap(([, indexes]) => indexes))];
      const targetIds = [...new Set(rowIndexes.map((index) => rowTargetIds[index]).filter(Boolean))];
      if (identity.id && !targetIds.includes(identity.id)) {
        report.failed += 1;
        report.issues.push({ fileName: file.fileName, reason: 'image-id-conflict' });
        continue;
      }
      if (!identity.id) {
        const idConflict = rowIndexes.some((index) => {
          const declaredId = importImageId(rows[index]);
          return declaredId && rowTargetIds[index] && declaredId !== rowTargetIds[index];
        });
        if (idConflict) {
          report.failed += 1;
          report.issues.push({ fileName: file.fileName, reason: 'image-id-conflict' });
          continue;
        }
      }
      if (targetIds.length !== 1) {
        report.failed += 1;
        report.issues.push({ fileName: file.fileName, reason: targetIds.length ? 'ambiguous-image-match' : 'unmatched-image' });
        continue;
      }
      const targetId = targetIds[0];
      if (matchedTargets.has(targetId)) {
        report.failed += 1;
        report.issues.push({ fileName: file.fileName, reason: 'multiple-images-for-influencer' });
        continue;
      }
      matchedTargets.add(targetId);
      candidates.push({
        row: importIssueRow(rows[rowIndexes[0]], rowIndexes[0]),
        fileName: file.fileName, targetId, buffer: file.buffer, extension: identity.extension
      });
    }
  }
  const distinctCandidates = [];
  const candidateTargets = new Set();
  for (const candidate of candidates) {
    if (candidate.targetId && candidateTargets.has(candidate.targetId)) {
      report.failed += 1;
      report.issues.push({
        ...(candidate.row ? { row: candidate.row } : {}),
        ...(candidate.fileName ? { fileName: candidate.fileName } : {}),
        reason: 'multiple-images-for-influencer'
      });
      continue;
    }
    if (candidate.targetId) candidateTargets.add(candidate.targetId);
    distinctCandidates.push(candidate);
  }
  const processCandidate = async (candidate) => {
    try {
      if (candidate.identityError) throw new Error(candidate.identityError);
      if (!candidate.targetId) throw new Error('row-not-imported');
      const image = candidate.buffer || await fetchProfileImage(candidate.url);
      const mimeType = profileImageMime(image);
      const extension = profileImageMimeTypes.get(mimeType);
      if (!extension || (candidate.extension && ![extension, ...(extension === 'jpg' ? ['jpeg'] : [])].includes(candidate.extension))) {
        throw new Error('invalid-image-content');
      }
      const hash = createHash('sha256').update(image).digest('hex');
      const stored = database.prepare(`SELECT i.record_json, image.content_hash AS imageHash,
        image.source_url AS sourceUrl FROM influencers i
        LEFT JOIN influencer_profile_images image ON image.influencer_id = i.id WHERE i.id = ?`).get(candidate.targetId);
      if (!stored) throw new Error('influencer-not-found');
      const record = JSON.parse(stored.record_json || '{}');
      const previousImage = String(record['Profile Image URL'] || '');
      if (stored.imageHash === hash || (candidate.url && stored.sourceUrl === candidate.url)) {
        report.unchanged += 1;
        return;
      }
      record['Profile Image URL'] = `/profile-images/${candidate.targetId}?v=${hash.slice(0, 12)}`;
      const now = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`INSERT INTO influencer_profile_images
          (influencer_id, mime_type, image_data, content_hash, source_url, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(influencer_id) DO UPDATE SET mime_type = excluded.mime_type,
            image_data = excluded.image_data, content_hash = excluded.content_hash,
            source_url = excluded.source_url, updated_at = excluded.updated_at`)
          .run(candidate.targetId, mimeType, image, hash, candidate.url || null, now);
        database.prepare('UPDATE influencers SET record_json = ? WHERE id = ?')
          .run(JSON.stringify(record), candidate.targetId);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      report[previousImage ? 'updated' : 'added'] += 1;
    } catch (error) {
      report.failed += 1;
      report.issues.push({
        ...(candidate.row ? { row: candidate.row } : {}),
        ...(candidate.fileName ? { fileName: candidate.fileName } : {}),
        reason: error.message || 'image-processing-failed'
      });
    }
  };
  let nextCandidate = 0;
  await Promise.all(Array.from({ length: Math.min(4, distinctCandidates.length) }, async () => {
    while (nextCandidate < distinctCandidates.length) await processCandidate(distinctCandidates[nextCandidate++]);
  }));
  return report;
}

const visitImportAliases = {
  name: ['name', 'influencername', 'creatorname', 'اسمالمعلن', 'اسمالمؤثر', 'المعلن', 'المؤثر'],
  username: ['username', 'user', 'handle', 'اسمالمستخدم', 'اسمحساب', 'اليوزر'],
  platform: ['platform', 'socialplatform', 'المنصة', 'منصة'],
  profileUrl: ['profileurl', 'accounturl', 'profilelink', 'accountlink', 'رابطالحساب', 'رابطالملف', 'رابطالحسابالاجتماعي'],
  visitDate: ['visitdate', 'date', 'تاريخالزيارة', 'التاريخ'],
  visitTime: ['visittime', 'time', 'appointmenttime', 'وقت الزيارة', 'وقت', 'الموعد'],
  city: ['city', 'visitcity', 'المدينة'],
  branch: ['branch', 'visitbranch', 'الفرع']
};
function parseImportDate(value) {
  const input = String(value ?? '').trim();
  if (/^\d{5}(?:\.\d+)?$/.test(input)) {
    const day = Math.floor(Number(input));
    if (day < 1 || day > 100000) return '';
    const date = new Date(Date.UTC(1899, 11, 30) + day * 86400000);
    return date.toISOString().slice(0, 10);
  }
  let match = input.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    const [, year, month, day] = match;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return date.toISOString().slice(0, 10) === `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      ? date.toISOString().slice(0, 10) : '';
  }
  match = input.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/);
  if (match) {
    // Day-first interpretation is standard for the Arabic locale.
    return parseImportDate(`${match[3]}-${match[2]}-${match[1]}`);
  }
  return '';
}
function followerImportUpdateDate(row) {
  const entry = Object.entries(row || {}).find(([key]) =>
    ['updatedate', 'followerupdatedate'].includes(normalizeImportHeader(key)));
  return parseImportDate(entry?.[1]);
}
function parseImportTime(value) {
  const input = String(value ?? '').trim();
  if (/^\d+(?:\.\d+)?$/.test(input) && Number(input) >= 0 && Number(input) < 1) {
    const minutes = Math.round(Number(input) * 1440) % 1440;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }
  const match = input.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return '';
  let hour = Number(match[1]);
  if (match[3]) {
    if (hour < 1 || hour > 12) return '';
    hour = (hour % 12) + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  }
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}
function importProfileHandle(value, platform) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input.startsWith('http') ? input : `https://${input}`);
    const host = url.hostname.toLowerCase();
    if (host.includes('instagram.com')) return { platform: 'Instagram', username: url.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '') || '' };
    if (host.includes('tiktok.com')) return { platform: 'TikTok', username: url.pathname.split('/').filter(Boolean).find((part) => part.startsWith('@'))?.slice(1) || '' };
    if (host.includes('snapchat.com')) return { platform: 'Snapchat', username: url.pathname.split('/').filter(Boolean).pop()?.replace(/^@/, '') || '' };
  } catch {}
  return { platform, username: input.replace(/^@/, '') };
}
function visitProfile(record) {
  const links = [];
  for (const [platform, field, host] of [
    ['Instagram', 'Username I', 'https://www.instagram.com/'],
    ['TikTok', 'Username T', 'https://www.tiktok.com/@'],
    ['Snapchat', 'Username', 'https://www.snapchat.com/add/']
  ]) {
    const handle = String(record[field] || '').trim().replace(/^@/, '');
    if (handle) links.push({ platform, username: handle, profileUrl: `${host}${encodeURIComponent(handle)}` });
  }
  return links;
}
function matchVisitImportRows(rows) {
  const headers = rows[0].map(normalizeImportHeader);
  const indexes = Object.fromEntries(Object.entries(visitImportAliases).map(([key, aliases]) => [
    key, headers.findIndex((header) => aliases.map(normalizeImportHeader).includes(header))
  ]));
  if (indexes.visitDate < 0 || indexes.visitTime < 0
    || (indexes.username < 0 && indexes.profileUrl < 0)) {
    throw Object.assign(new Error('يلزم عمودا تاريخ الزيارة ووقتها، مع اسم مستخدم أو رابط حساب للمطابقة.'), { status: 400 });
  }
  const records = database.prepare('SELECT id, record_json FROM influencers').all().map((item) => ({
    id: item.id, record: JSON.parse(item.record_json || '{}')
  }));
  const rowsByUsername = new Map();
  for (const item of records) for (const link of visitProfile(item.record)) {
    const key = `${link.platform}\0${normalizedImportUsername(link.username)}`;
    const matches = rowsByUsername.get(key) || [];
    matches.push(item);
    rowsByUsername.set(key, matches);
  }
  const seen = new Set();
  return rows.slice(1).map((values, index) => {
    const read = (key) => indexes[key] < 0 ? '' : String(values[indexes[key]] ?? '').trim();
    const rawPlatform = read('platform');
    const platform = normalizeImportPlatform(rawPlatform);
    const usernameRaw = read('username');
    const urlHandle = read('profileUrl') ? importProfileHandle(read('profileUrl'), platform) : null;
    const effectivePlatform = urlHandle?.platform || platform;
    const username = urlHandle?.username || usernameRaw;
    const conflictingIdentity = Boolean(urlHandle && (
      (rawPlatform && (!platform || platform !== effectivePlatform))
      || (usernameRaw && normalizedImportUsername(usernameRaw) !== normalizedImportUsername(urlHandle.username))
    ));
    const visitDate = parseImportDate(read('visitDate'));
    const visitTime = parseImportTime(read('visitTime'));
    const potential = username && effectivePlatform
      ? (rowsByUsername.get(`${effectivePlatform}\0${normalizedImportUsername(username)}`) || [])
      : [];
    const candidates = potential.length ? potential : records.filter(({ record }) => {
      const name = read('name').trim().toLocaleLowerCase();
      return name && String(record.Name || '').trim().toLocaleLowerCase() === name;
    }).slice(0, 20);
    let reason = '';
    let status = 'matched';
    let influencerId = candidates.length === 1 && potential.length === 1 ? candidates[0].id : '';
    if (!visitDate || !visitTime) {
      status = 'invalid'; reason = !visitDate ? 'تاريخ الزيارة مفقود أو غير صالح.' : 'وقت الزيارة مفقود أو غير صالح.';
    } else if (conflictingIdentity) {
      status = 'ambiguous'; reason = 'اسم المستخدم أو المنصة لا يتطابق مع رابط الحساب؛ راجع الهوية يدويًا.';
    } else if (candidates.length > 1) {
      status = 'ambiguous'; reason = 'تطابقت بيانات الحساب مع أكثر من سجل؛ اختر المؤثر يدويًا.';
    } else if (!candidates.length) {
      status = 'unmatched'; reason = 'لم تتم مطابقة حساب اجتماعي موجود؛ اختره يدويًا أو صحح اسم المستخدم والمنصة.';
    } else if (!potential.length) {
      status = 'unmatched'; reason = 'الاسم المعروض للمراجعة فقط ولا يثبت الهوية؛ اختر المطابقة يدويًا.';
    } else if (seen.has(influencerId)) {
      status = 'duplicate'; reason = 'المؤثر مكرر في الملف.';
    }
    if (influencerId) seen.add(influencerId);
    return {
      rowNumber: index + 2, name: read('name'), username: username || '',
      platform: effectivePlatform || '', profileUrl: read('profileUrl'),
      visitDate, visitTime, city: read('city'), branch: read('branch'),
      influencerId: status === 'matched' ? influencerId : '',
      candidates: candidates.slice(0, 20).map(({ id, record }) => ({
        id, name: String(record.Name || ''), profiles: visitProfile(record)
      })),
      status, reason
    };
  });
}

function matchCatalogImportRows(rows, catalogId = '') {
  const indexes = importColumnIndexes(rows[0]);
  if (indexes.id < 0 && indexes.username < 0) {
    throw Object.assign(new Error('يجب أن يحتوي الملف على عمود «Username» أو «Influencer ID».'), { status: 400 });
  }
  const records = database.prepare('SELECT id, record_json FROM influencers').all().map((row) => ({
    id: row.id,
    record: JSON.parse(row.record_json)
  }));
  const byId = new Map(records.map((item) => [item.id.toLowerCase(), item]));
  const usernameField = { Instagram: 'Username I', TikTok: 'Username T', Snapchat: 'Username' };
  const byAccount = new Map();
  const byUsername = new Map();
  for (const item of records) {
    for (const [platform, field] of Object.entries(usernameField)) {
      const username = normalizedImportUsername(item.record[field]);
      if (!username) continue;
      const key = `${platform}\0${username}`;
      const matches = byAccount.get(key) || [];
      matches.push({ ...item, platform, username });
      byAccount.set(key, matches);
      const usernameMatches = byUsername.get(username) || [];
      usernameMatches.push({ ...item, platform, username });
      byUsername.set(username, usernameMatches);
    }
  }
  const existingIds = new Set(catalogId
    ? database.prepare('SELECT influencer_id FROM client_catalog_items WHERE catalog_id = ?').all(catalogId).map((row) => row.influencer_id)
    : []);
  const seen = new Set();
  return rows.slice(1).map((values, index) => {
    const valueAt = (key) => indexes[key] < 0 ? '' : String(values[indexes[key]] || '').trim();
    const sourceId = valueAt('id').toLowerCase();
    const username = valueAt('username').replace(/^@/, '');
    const platform = normalizeImportPlatform(valueAt('platform'));
    let match = null;
    let status = 'unmatched';
    let reason = '';
    let candidateAccounts = [];
    if (sourceId) {
      match = /^[a-f0-9]{32}$/.test(sourceId) ? byId.get(sourceId) : null;
      if (!match) reason = 'المعرّف الثابت غير مطابق لأي سجل.';
    } else if (!username) {
      status = 'invalid';
      reason = 'اسم المستخدم غير موجود.';
    } else {
      const matches = platform
        ? byAccount.get(`${platform}\0${normalizedImportUsername(username)}`) || []
        : byUsername.get(normalizedImportUsername(username)) || [];
      const uniqueMatches = [...new Map(matches.map((item) => [`${item.id}\0${item.platform}`, item])).values()];
      match = uniqueMatches.length === 1 ? uniqueMatches[0] : null;
      if (uniqueMatches.length > 1) {
        status = 'invalid';
        reason = 'اسم المستخدم مرتبط بأكثر من منصة أو سجل؛ يلزم اختياره يدويًا.';
        candidateAccounts = uniqueMatches.map((item) => ({
          name: String(item.record.Name || ''),
          username: item.username,
          platform: item.platform
        }));
      }
      else if (!match) reason = 'لم يُعثر على اسم المستخدم في المنصة المحددة.';
    }
    if (match) {
      if (seen.has(match.id)) {
        status = 'duplicate';
        reason = 'المؤثر مكرر في الملف.';
      } else {
        seen.add(match.id);
        if (existingIds.has(match.id)) {
          status = 'already-in-offer';
          reason = 'المؤثر موجود بالفعل في هذا العرض.';
        } else {
          status = 'matched';
        }
      }
    }
    return {
      rowNumber: index + 2, influencerId: match?.id || '', name: match?.record.Name || '',
      username: username || match?.username || match?.record.Main_Username || '',
      platform: platform || match?.platform || match?.record['Best Platform'] || '',
      candidateAccounts,
      status, reason
    };
  });
}

function saveCatalogImportPreview(preview) {
  const now = Date.now();
  for (const [id, entry] of catalogImportPreviews) if (entry.expiresAt <= now) catalogImportPreviews.delete(id);
  if (catalogImportPreviews.size >= 50) catalogImportPreviews.delete(catalogImportPreviews.keys().next().value);
  const id = randomBytes(16).toString('hex');
  catalogImportPreviews.set(id, { ...preview, expiresAt: now + 10 * 60 * 1000 });
  return id;
}

function normalizeUsername(value) {
  return String(value ?? '').trim();
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

function validateEmail(value) {
  return typeof value === 'string' && value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function generatedClientUsername(email) {
  const localPart = normalizeEmail(email).split('@')[0];
  const base = localPart.replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 24);
  const stem = base.length >= 3 ? base : `client${base}`.slice(0, 24);
  let candidate = stem;
  let suffix = 1;
  while (database.prepare('SELECT 1 FROM client_accounts WHERE username = ? COLLATE NOCASE').get(candidate)) {
    const tail = String(suffix++);
    candidate = `${stem.slice(0, 32 - tail.length)}${tail}`;
  }
  return candidate;
}

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

function validateUsername(value) {
  return /^[\p{L}\p{M}\p{N}._ -]{3,32}$/u.test(value);
}

function validatePassword(value) {
  return typeof value === 'string' && value.length >= passwordMinLength && value.length <= passwordMaxLength;
}

function validateLoginPassword(value) {
  return typeof value === 'string' && value.length >= 3 && value.length <= passwordMaxLength;
}

async function derivePassword(password, salt) {
  return scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

async function checkPassword(password, user) {
  const salt = Buffer.from(user?.salt || '00112233445566778899aabbccddeeff', 'hex');
  const expected = Buffer.from(user?.password_hash || randomBytes(64).toString('hex'), 'hex');
  const actual = await derivePassword(password, salt);
  return actual.length === expected.length && timingSafeEqual(actual, expected) && Boolean(user);
}

function makeResetCode() {
  return String(randomInt(100000, 1000000));
}

function hashResetCode(code) {
  return createHash('sha256').update(String(code)).digest('hex');
}

function prepareResetResponse(code) {
  return {
    localCode: code,
    message: 'تم إنشاء رمز التحقق محليًا. لا يتوفر إرسال بريد إلكتروني في هذا الإصدار.'
  };
}

function issueSession(response, user) {
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + sessionDurationMs });
  response.setHeader('Set-Cookie', cookieHeader(token));
  return userView(user);
}

function normalizePhone(record) {
  const full = String(record.Full_Mobile_Number ?? '').trim();
  const toDigits = (value) => String(value ?? '')
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/\D/g, '');
  const rawCode = toDigits(record['Country Code']);
  const source = full || `${record['Country Code'] ?? ''}${record.Number ?? ''}`;
  let digits = toDigits(source);
  if (digits.startsWith('00')) digits = digits.slice(2);
  let dialCode = rawCode.startsWith('00') ? rawCode.slice(2) : rawCode;
  if (dialCode && digits.startsWith(dialCode)) digits = digits.slice(dialCode.length);
  if (digits.startsWith('0') && dialCode) digits = digits.slice(1);
  if (!dialCode) {
    const gulfCode = ['966', '965', '968', '971', '973', '974', '20', '967']
      .find((code) => digits.startsWith(code) && digits.length > code.length + 5);
    if (gulfCode) {
      dialCode = gulfCode;
      digits = digits.slice(gulfCode.length);
    } else if (digits.startsWith('05') && digits.length === 10) {
      dialCode = '966';
      digits = digits.slice(1);
    } else if (digits.startsWith('5') && digits.length === 9) {
      dialCode = '966';
    }
  }
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (!dialCode || digits.length < 6 || digits.length > 12) return null;
  return `+${dialCode}${digits}`;
}

const importPhoneDialCodes = new Set(['966', '965', '968', '971', '973', '974', '20', '967']);
function importedPhoneDigits(record) {
  return normalizePhoneDigits(record?.Full_Mobile_Number || record?.Number);
}
function isMissingImportedPhone(record) {
  const digits = importedPhoneDigits(record);
  const dialCode = normalizePhoneDigits(record?.['Country Code']).replace(/^00/, '');
  const comparableDigits = digits.replace(/^00/, '');
  return !digits || digits.length < 7
    || Boolean(dialCode && comparableDigits === dialCode)
    || importPhoneDialCodes.has(comparableDigits);
}
function normalizeImportedPhone(record) {
  return isMissingImportedPhone(record) ? null : normalizePhone(record);
}

function normalizePhoneFields(record) {
  const toDigits = (value) => String(value ?? '')
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/\D/g, '');
  let dialCode = toDigits(record['Country Code']);
  if (dialCode.startsWith('00')) dialCode = dialCode.slice(2);
  let local = toDigits(record.Number);
  const sourceNumber = String(record.Number ?? '').trim();
  if (dialCode && local.startsWith(dialCode) &&
      (sourceNumber.startsWith('+') || sourceNumber.startsWith('00') || local.length > dialCode.length + 6)) {
    local = local.slice(dialCode.length);
  }
  if (dialCode) record['Country Code'] = `+${dialCode}`;
  if (local) record.Number = local;
  if (dialCode && local) record.Full_Mobile_Number = `+${dialCode}${local}`;
}

function normalizeImportedPhoneFields(record, input) {
  if (isMissingImportedPhone(input)) {
    record.Number = '';
    record.Full_Mobile_Number = '';
    return null;
  }
  const phoneDigits = importedPhoneDigits(input);
  const phoneKey = normalizeImportedPhone(input);
  if (!phoneKey) {
    if (phoneDigits.length >= 11 && phoneDigits.length <= 13) {
      record.Number = phoneDigits;
      record.Full_Mobile_Number = phoneDigits;
      return null;
    }
    throw new Error('invalid-phone');
  }
  const fullDigits = normalizePhoneDigits(phoneKey);
  let dialCode = normalizePhoneDigits(record['Country Code']).replace(/^00/, '');
  if (!dialCode || !fullDigits.startsWith(dialCode)) {
    dialCode = ['966', '965', '968', '971', '973', '974', '967', '20']
      .find((code) => fullDigits.startsWith(code)) || '';
  }
  if (!dialCode || fullDigits.length <= dialCode.length) throw new Error('invalid-phone');
  record['Country Code'] = `+${dialCode}`;
  record.Number = fullDigits.slice(dialCode.length);
  record.Full_Mobile_Number = phoneKey;
  return phoneKey;
}

function recordFingerprint(record) {
  const values = Object.entries(record)
    .filter(([key, value]) => key !== 'id' && String(value ?? '').trim() !== '')
    .map(([key, value]) => [String(key).trim(), String(value).trim()])
    .sort(([left], [right]) => left.localeCompare(right, 'en'));
  return JSON.stringify(values);
}

function stableRecordJson(record) {
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort((a, b) => a.localeCompare(b, 'en'))
        .map((key) => [key, normalize(value[key])]));
    }
    return value;
  };
  return JSON.stringify(normalize(record));
}

function suppliedImportFieldsMatch(existing, canonicalInput, incoming) {
  let compared = false;
  for (const field of influencerImportAccountFields) {
    const suppliedUsername = String(canonicalInput[field.username] ?? '').trim();
    if (suppliedUsername) {
      compared = true;
      if (normalizedImportUsername(suppliedUsername)
        !== normalizedImportUsername(existing[field.username])) return false;
    }
    const suppliedFollowers = String(canonicalInput[field.followers] ?? '').trim();
    if (suppliedFollowers) {
      compared = true;
      const incomingCount = parseImportedFollowerCount(incoming[field.followers]);
      const existingCount = parseImportedFollowerCount(existing[field.followers]);
      if (incomingCount === null || existingCount === null || incomingCount !== existingCount) return false;
    }
  }
  if (!compared) return false;
  return true;
}

function previewInfluencerImport(rows, { allowSensitiveChanges = false, restoreArchivedMatches = false } = {}) {
  const savedRecords = database.prepare('SELECT id, record_json, phone_key, archived_at FROM influencers').all().map((row) => ({
    id: row.id, record: JSON.parse(row.record_json || '{}'), phoneKey: row.phone_key, archivedAt: row.archived_at
  }));
  const byId = new Map(savedRecords.map((record) => [record.id.toLowerCase(), record]));
  const recordsByPhone = new Map();
  const accountOwners = new Map();
  const accountsFor = (record) => influencerImportAccountFields.flatMap((field) =>
    influencerImportAccountValues(record, field).flatMap((value) => {
      const handle = normalizedImportUsername(value);
      return handle ? [[`${field.platform}\0${handle}`, field.platform]] : [];
    }));
  const addPhoneOwner = (phoneKey, owner) => {
    if (!phoneKey) return;
    const owners = recordsByPhone.get(phoneKey) || new Set();
    owners.add(owner);
    recordsByPhone.set(phoneKey, owners);
  };
  for (const saved of savedRecords) {
    addPhoneOwner(saved.phoneKey || normalizePhone(saved.record), saved);
    for (const [key] of accountsFor(saved.record)) {
      const owners = accountOwners.get(key) || new Set();
      owners.add(saved.id);
      accountOwners.set(key, owners);
    }
  }
  const duplicateRows = findDuplicateImportRows(rows);
  const duplicatePhones = findDuplicateImportPhoneRows(rows);
  const result = {
    total: rows.length, valid: 0, conflicts: 0, duplicates: 0, creates: 0, updates: 0,
    unchanged: 0, skipped: 0, matchedByPhone: 0, matchedByAccount: 0,
    needsReview: 0, sharedPhoneRows: [], issues: [], accountMatches: []
  };
  const registerAccountOwners = (record, id, remove = false) => {
    for (const [key] of accountsFor(record)) {
      const owners = accountOwners.get(key) || new Set();
      if (remove) owners.delete(id);
      else owners.add(id);
      if (owners.size) accountOwners.set(key, owners);
      else accountOwners.delete(key);
    }
  };
  const removePhoneOwner = (phoneKey, ownerId) => {
    if (!phoneKey) return;
    const owners = recordsByPhone.get(phoneKey);
    owners?.delete(ownerId);
    if (!owners?.size) recordsByPhone.delete(phoneKey);
  };
  for (const [index, input] of rows.entries()) {
    const row = importIssueRow(input, index);
    const reject = (reason, details = {}) => {
      result.conflicts += 1;
      if (influencerImportReviewReasons.has(reason)) result.needsReview += 1;
      else result.skipped += 1;
      result.issues.push({ row, reason, ...details });
    };
    const duplicate = duplicateRows.get(index);
    if (duplicate) {
      reject('duplicate-account-in-file', { accounts: duplicate.accounts });
      continue;
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) { reject('invalid-row'); continue; }
    try {
      const canonicalInput = { ...input };
      for (const key of Object.keys(canonicalInput)) {
        if (influencerImportIdHeaders.has(normalizeImportHeader(key))
          || ['profileimageurl', 'profilepictureurl', 'avatarurl', 'imageurl', 'photourl'].includes(normalizeImportHeader(key))) {
          delete canonicalInput[key];
        }
      }
      for (const field of influencerImportAccountFields) {
        if (!String(canonicalInput[field.username] || '').trim()) {
          const alias = field.aliases.find((name) => String(canonicalInput[name] || '').trim());
          if (alias) canonicalInput[field.username] = canonicalInput[alias];
        }
        const count = canonicalInput[field.followers];
        if (count !== undefined && String(count ?? '').trim()) {
          const parsed = parseImportedFollowerCount(count);
          if (parsed === null) throw new Error('invalid-follower-count');
          canonicalInput[field.followers] = String(parsed);
        }
      }
      const incoming = normalizedImportRecord(canonicalInput);
      const phoneKey = normalizePhone(incoming);
      const rowAccounts = accountsFor(incoming);
      if (!rowAccounts.length && !phoneKey) { reject('missing-stable-identity'); continue; }
      const owners = new Set();
      for (const [key] of rowAccounts) {
        for (const owner of accountOwners.get(key) || []) owners.add(owner);
      }
      if (owners.size > 1) { reject('identity-conflict', { accounts: rowAccounts.map(([, platform]) => platform) }); continue; }

      const existingId = owners.values().next().value || '';
      const existing = existingId ? byId.get(existingId.toLowerCase()) : null;
      if (existing?.archivedAt && !restoreArchivedMatches) {
        reject('archived-match-needs-restore'); continue;
      }
      const existingPhoneKey = existing?.phoneKey || (existing ? normalizePhone(existing.record) : null);
      if (existing && phoneKey
        && [...(recordsByPhone.get(phoneKey) || [])].some((owner) => owner.id !== existing.id)) {
        reject('identity-conflict', { accounts: rowAccounts.map(([, platform]) => platform) });
        continue;
      }
      if (existing && phoneKey && existingPhoneKey && phoneKey !== existingPhoneKey) {
        reject('phone-number-changed-needs-review', { matchedByAccount: true });
        continue;
      }

      const sharedPhone = Boolean(phoneKey
        && (duplicatePhones.has(index)
          || [...(recordsByPhone.get(phoneKey) || [])].some((owner) => owner.id !== existing?.id)));
      const sharedPhoneMark = sharedPhone ? 'رقم مشترك' : '';
      if (sharedPhone) result.sharedPhoneRows.push(row);

      if (!existing) {
        if (sharedPhoneMark) incoming['Phone Shared'] = sharedPhoneMark;
        result.valid += 1;
        result.creates += 1;
        const created = { id: `preview-${index}`, record: incoming, phoneKey };
        byId.set(created.id, created);
        addPhoneOwner(phoneKey, created);
        registerAccountOwners(incoming, created.id);
        continue;
      }

      const merged = { ...existing.record };
      for (const [key, value] of Object.entries(canonicalInput)) {
        if (['Name', 'Gender'].includes(key) && String(value ?? '').trim()
          && String(incoming[key] ?? '') !== String(existing.record[key] ?? '') && !allowSensitiveChanges) continue;
        const normalizedValue = incoming[key] === undefined ? value : incoming[key];
        if (Array.isArray(normalizedValue)) {
          if (normalizedValue.length) merged[key] = normalizedValue;
        } else if (String(normalizedValue ?? '').trim() !== '') merged[key] = normalizedValue;
      }
      if (sharedPhoneMark) merged['Phone Shared'] = sharedPhoneMark;
      const updatedRecord = normalizedImportRecord(merged);
      const nextPhoneKey = phoneKey || existingPhoneKey;
      result.valid += 1;
      result.matchedByAccount += 1;
      if (suppliedImportFieldsMatch(existing.record, canonicalInput, incoming)
        && nextPhoneKey === existing.phoneKey) {
        result.unchanged += 1;
        result.duplicates += 1;
      } else result.updates += 1;
      registerAccountOwners(existing.record, existing.id, true);
      removePhoneOwner(existingPhoneKey, existing.id);
      existing.record = updatedRecord;
      existing.phoneKey = nextPhoneKey;
      addPhoneOwner(nextPhoneKey, existing);
      registerAccountOwners(updatedRecord, existing.id);
    } catch (error) {
      const reason = ['invalid-username', 'invalid-phone', 'invalid-follower-count'].includes(error.message)
        ? error.message : 'invalid-row';
      reject(reason);
    }
  }
  return result;
}

function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('بيانات السجل غير صالحة.'), { status: 400 });
  const record = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = String(rawKey).trim().slice(0, 150);
    if (!key || key === 'id') continue;
    if (['Interests', 'Unmapped Interests', 'Unmapped Content Update', 'Unmapped Language'].includes(key)) {
      record[key] = rawValue;
    } else {
      record[key] = String(rawValue ?? '').slice(0, 10000);
    }
  }
  const suppliedInterests = splitInterestValues(record.Interests);
  const interestSources = Array.isArray(record.Interests) || suppliedInterests.length
    ? suppliedInterests
    : [
      ...splitInterestValues(record['Full Classification']),
      ...splitInterestValues(record.Classification),
      ...['Categories 1', 'Categories 2', 'Categories 3', 'Categories 4'].flatMap((field) => splitInterestValues(record[field]))
    ];
  const interestValues = canonicalizeInterests(interestSources);
  const existingUnmappedInterests = canonicalizeInterests(record['Unmapped Interests']);
  record.Interests = [...new Set([...interestValues.interests, ...existingUnmappedInterests.interests])];
  record['Unmapped Interests'] = [...new Set([...existingUnmappedInterests.unmapped, ...interestValues.unmapped])];
  record['Full Classification'] = record.Interests.join(', ');
  delete record.Classification;
  for (let index = 1; index <= 4; index += 1) delete record[`Categories ${index}`];

  const contentUpdate = String(record['Content Update'] ?? '').trim();
  const normalizedContentUpdate = canonicalYesNo(record['Content Update']);
  const unmappedContentUpdate = splitInterestValues(record['Unmapped Content Update']);
  if (contentUpdate && !normalizedContentUpdate && !unmappedContentUpdate.includes(contentUpdate)) unmappedContentUpdate.push(contentUpdate);
  record['Content Update'] = normalizedContentUpdate;
  record['Unmapped Content Update'] = [...new Set(unmappedContentUpdate)];

  const language = String(record.language ?? '').trim();
  const normalizedLanguage = canonicalLanguage(record.language);
  const unmappedLanguages = splitInterestValues(record['Unmapped Language']);
  if (language && !normalizedLanguage && !unmappedLanguages.includes(language)) unmappedLanguages.push(language);
  record.language = normalizedLanguage;
  record['Unmapped Language'] = [...new Set(unmappedLanguages)];
  record.Main_Username = String(record.Main_Username ?? '').trim();
  const status = String(record['Influencer Status'] || '').trim().toLowerCase();
  record['Influencer Status'] = ['inactive', 'غير نشط'].includes(status) ? 'Inactive' : 'Active';
  normalizePhoneFields(record);
  return deriveInfluencerFields(record);
}

const interestCatalogMigrationKey = 'influencer-interest-catalog-v2';

async function migrateInterestCatalogAndClassification() {
  const tableExists = Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'interest_catalog'"
  ).get());
  const migrationValue = database.prepare('SELECT value FROM app_settings WHERE key = ?')
    .get(interestCatalogMigrationKey)?.value;
  const rows = database.prepare('SELECT id, record_json FROM influencers').all();
  if (tableExists && migrationValue === 'complete') {
    refreshInterestNames(database.prepare('SELECT name FROM interest_catalog ORDER BY name COLLATE NOCASE').all().map((row) => row.name));
    return;
  }
  if (rows.length) await createBackup(true);

  const candidates = [...influencerFieldOptions.interests];
  for (const row of rows) {
    const record = JSON.parse(row.record_json || '{}');
    candidates.push(
      ...splitInterestValues(record.Interests),
      ...splitInterestValues(record['Unmapped Interests']),
      ...['Categories 1', 'Categories 2', 'Categories 3', 'Categories 4']
        .flatMap((field) => splitInterestValues(record[field])),
      ...splitInterestValues(record.Classification),
      ...splitInterestValues(record['Full Classification'])
    );
  }
  const normalizedCandidates = new Map();
  for (const candidate of candidates) {
    const value = String(candidate || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!value) continue;
    const alias = value.toLocaleLowerCase('en-US') === 'blogging' ? 'Bloging' : value;
    normalizedCandidates.set(normalizeInterestKey(alias), alias);
  }

  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS interest_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  try {
    const now = new Date().toISOString();
    const insertInterest = database.prepare(`INSERT INTO interest_catalog (id, name, normalized_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(normalized_name) DO NOTHING`);
    for (const [normalized, name] of normalizedCandidates) {
      insertInterest.run(randomBytes(16).toString('hex'), name, normalized, now, now);
    }
    refreshInterestNames(database.prepare('SELECT name FROM interest_catalog ORDER BY name COLLATE NOCASE').all().map((row) => row.name));
    const updateRecord = database.prepare('UPDATE influencers SET record_json = ? WHERE id = ?');
    for (const row of rows) {
      const record = JSON.parse(row.record_json || '{}');
      const interests = [
        ...splitInterestValues(record.Interests),
        ...splitInterestValues(record['Unmapped Interests']),
        ...['Categories 1', 'Categories 2', 'Categories 3', 'Categories 4']
          .flatMap((field) => splitInterestValues(record[field])),
        ...splitInterestValues(record.Classification),
        ...splitInterestValues(record['Full Classification'])
      ];
      const normalized = normalizeRecord({ ...record, Interests: interests });
      updateRecord.run(JSON.stringify(normalized), row.id);
    }
    database.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, 'complete', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(interestCatalogMigrationKey, now);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrateInfluencerChoiceFields() {
  const rows = database.prepare('SELECT id, record_json FROM influencers').all();
  const updates = [];
  const review = [];
  for (const row of rows) {
    const record = normalizeRecord(JSON.parse(row.record_json || '{}'));
    const recordJson = JSON.stringify(record);
    if (recordJson !== row.record_json) updates.push({ id: row.id, recordJson });
    const unmappedInterests = splitInterestValues(record['Unmapped Interests']);
    const unmappedContentUpdate = splitInterestValues(record['Unmapped Content Update']);
    const unmappedLanguage = splitInterestValues(record['Unmapped Language']);
    if (unmappedInterests.length || unmappedContentUpdate.length || unmappedLanguage.length) {
      review.push({
        id: row.id,
        interests: unmappedInterests,
        contentUpdate: unmappedContentUpdate,
        language: unmappedLanguage
      });
    }
  }
  const report = {
    migration: 'influencer-choice-fields-v1',
    updatedRecords: updates.length,
    unresolvedRecords: review.length,
    unresolvedValues: review,
    updatedAt: new Date().toISOString()
  };
  const currentReport = database.prepare("SELECT value FROM app_settings WHERE key = 'influencer_choice_migration_review'").get()?.value || '';
  const update = database.prepare('UPDATE influencers SET record_json = ? WHERE id = ?');
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const item of updates) update.run(item.recordJson, item.id);
    if (!currentReport || updates.length) {
      database.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run('influencer_choice_migration_review', JSON.stringify(report), report.updatedAt);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  if (review.length) console.warn(`Influencer field migration retained ${review.length} record(s) with unmapped values; review app_settings.influencer_choice_migration_review.`);
}

function getDerivedInfluencerUpdates() {
  const rows = database.prepare('SELECT id, record_json FROM influencers').all();
  return rows.map((row) => {
    const record = normalizeRecord(JSON.parse(row.record_json || '{}'));
    const recordJson = JSON.stringify(record);
    return recordJson === row.record_json ? null : { id: row.id, recordJson };
  }).filter(Boolean);
}

function migrateDerivedInfluencerFields() {
  const updates = getDerivedInfluencerUpdates();
  if (!updates.length) return;
  const update = database.prepare('UPDATE influencers SET record_json = ? WHERE id = ?');
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const item of updates) update.run(item.recordJson, item.id);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

await migrateInterestCatalogAndClassification();
migrateInfluencerChoiceFields();
migrateDerivedInfluencerFields();

function getInfluencers() {
  return database.prepare('SELECT id, record_json FROM influencers WHERE archived_at IS NULL ORDER BY rowid DESC').all().map((row) => ({
    ...deriveMainAccountFields(JSON.parse(row.record_json)),
    id: row.id
  }));
}

function influencerFilter(field, value) {
  return `normalized_filter('${field}', json_extract(i.record_json, '$."${field}"')) = ?`;
}

function buildInfluencerWhere(params, scope = 'database') {
  const clauses = [];
  const values = [];
  const query = String(params.get('q') || '').trim().replace(/^@/, '');
  if (query) {
    if (scope === 'lookup') {
      const accountQuery = query.replace(/^https?:\/\/[^/]+\/@?/i, '').split('/').filter(Boolean).pop() || query;
      const terms = ['Main_Username', 'Username I', 'Username T', 'Username'];
      const phoneQuery = normalizePhoneDigits(query);
      const phoneClause = phoneQuery.length >= 5
        ? ` OR instr(phone_digits(json_extract(i.record_json, '$."Full_Mobile_Number"')), ?) > 0
           OR instr(phone_digits(json_extract(i.record_json, '$."Number"')), ?) > 0`
        : '';
      clauses.push(`(${terms.map((field) => `instr(lower(CAST(json_extract(i.record_json, '$."${field}"') AS TEXT)), lower(?)) > 0`).join(' OR ')}${phoneClause})`);
      for (const _field of terms) values.push(accountQuery);
      if (phoneClause) values.push(phoneQuery, phoneQuery);
      clauses[clauses.length - 1] = `(${clauses[clauses.length - 1].slice(1, -1)} OR ${[
        'Username I', 'Username T', 'Username'
      ].map((field) => `account_username(json_extract(i.record_json, '$."${field}"')) = account_username(?)`).join(' OR ')})`;
      values.push(accountQuery, accountQuery, accountQuery);
    } else if (scope === 'campaign') {
      const terms = ['Name', 'Main_Username', 'Username I', 'Username T', 'Username'];
      clauses.push(`(${terms.map((field) => `instr(lower(CAST(json_extract(i.record_json, '$."${field}"') AS TEXT)), lower(?)) > 0`).join(' OR ')})`);
      for (const _field of terms) values.push(query);
    } else if ([...query].length >= 3) {
      const platformFields = params.get('platform') === 'Instagram' ? ['Username I']
        : params.get('platform') === 'TikTok' ? ['Username T']
          : params.get('platform') === 'Snapchat' ? ['Username']
            : ['Username I', 'Username T', 'Username'];
      clauses.push(`(i.id IN (SELECT influencer_id FROM influencer_search WHERE search_text LIKE ? ESCAPE '\\')
        OR ${platformFields.map((field) => `account_username(json_extract(i.record_json, '$."${field}"')) = account_username(?)`).join(' OR ')})`);
      values.push(`%${query.replace(/[\\%_]/g, '\\$&')}%`, ...platformFields.map(() => query));
    } else {
      clauses.push(`EXISTS (SELECT 1 FROM json_each(i.record_json) WHERE instr(lower(CAST(value AS TEXT)), lower(?)) > 0)`);
      values.push(query);
    }
  }

  if (params.get('status') === 'Archived') {
    clauses.push('i.archived_at IS NOT NULL');
  } else {
    clauses.push('i.archived_at IS NULL');
  }

  if (scope === 'database' || scope === 'campaign') {
    const platform = params.get('platform') || '';
    const platformFields = { Instagram: 'Username I', TikTok: 'Username T', Snapchat: 'Username' };
    if (platformFields[platform]) {
      clauses.push(`trim(COALESCE(json_extract(i.record_json, '$."${platformFields[platform]}"'), '')) <> ''`);
    }
    const country = params.get('country') || '';
    if (country) {
      clauses.push(`country_iso(json_extract(i.record_json, '$."Country"')) = ?`);
      values.push(country);
    }
    for (const field of ['Area', 'City']) {
      const value = params.get(field.toLowerCase()) || '';
      if (value) {
        clauses.push(`normalized_filter('${field}', json_extract(i.record_json, '$."${field}"')) = normalized_filter('${field}', ?)`);
        values.push(value);
      }
    }
    const classification = params.get('classification') || '';
    if (classification) {
      clauses.push(`(EXISTS (SELECT 1 FROM json_each(i.record_json, '$."Interests"') selected
          WHERE lower(trim(CAST(selected.value AS TEXT))) = lower(trim(?)))
        OR lower(trim(json_extract(i.record_json, '$."Full Classification"'))) = lower(trim(?))
        OR EXISTS (SELECT 1 FROM json_each(i.record_json, '$."Unmapped Interests"') legacy WHERE lower(trim(CAST(legacy.value AS TEXT))) = lower(trim(?))))`);
      values.push(classification, classification, classification);
    }
    const tier = params.get('tier') || '';
    if (tier) {
      const tierFields = platform === 'Instagram' ? ['Followers Count I']
        : platform === 'TikTok' ? ['Followers Count T']
          : platform === 'Snapchat' ? ['Followers Count S']
            : ['Followers Count I', 'Followers Count T', 'Followers Count S'];
      clauses.push(`(${tierFields.map((field) => `follower_tier(json_extract(i.record_json, '$."${field}"')) = ?`).join(' OR ')})`);
      values.push(...tierFields.map(() => tier));
    }
    const followerFields = platform && { Instagram: ['Followers Count I'], TikTok: ['Followers Count T'], Snapchat: ['Followers Count S'] }[platform]
      ? { Instagram: ['Followers Count I'], TikTok: ['Followers Count T'], Snapchat: ['Followers Count S'] }[platform]
      : ['Followers Count I', 'Followers Count T', 'Followers Count S'];
    const minFollowers = params.get('minFollowers');
    const maxFollowers = params.get('maxFollowers');
    const followerCounts = followerFields.map((field) => `follower_count(json_extract(i.record_json, '$."${field}"'))`);
    const followerExpression = followerCounts.length === 1 ? followerCounts[0] : `MAX(${followerCounts.join(', ')})`;
    if (minFollowers && /^\d{1,10}$/.test(minFollowers)) {
      clauses.push(`${followerExpression} >= ?`);
      values.push(Number(minFollowers));
    }
    if (maxFollowers && /^\d{1,10}$/.test(maxFollowers)) {
      clauses.push(`${followerExpression} <= ?`);
      values.push(Number(maxFollowers));
    }
    for (const [field, param] of [
      ['Gender', 'gender'], ['Face Appearance', 'appearance'], ['Speak', 'speak'],
      ['Verified', 'verified'], ['Mawthouq', 'mawthouq'], ['Paid or Voucher', 'payment'],
      ['Content Update', 'contentUpdate'], ['language', 'language']
    ]) {
      const value = params.get(param) || '';
      if (value) {
        clauses.push(influencerFilter(field, value));
        values.push(normalizeFilter(field, value));
      }
    }
    const status = params.get('status') || '';
    if (status === 'Active') clauses.push(`COALESCE(json_extract(i.record_json, '$."Influencer Status"'), 'Active') <> 'Inactive'`);
    if (status === 'Inactive') clauses.push(`json_extract(i.record_json, '$."Influencer Status"') = 'Inactive'`);
    const workflow = params.get('workflow') || '';
    if (workflow) {
      clauses.push(`workflow_status(json_extract(i.record_json, '$."Workflow Status"')) = ?`);
      values.push(workflow);
    }
  }
  if (scope === 'database' || scope === 'catalog' || scope === 'campaign') {
    const requestedInterests = params.getAll('interest');
    if (requestedInterests.length) {
      const interests = requestedInterests.map((value) =>
        interestByNormalizedName.get(String(value).trim().normalize('NFKC').toLocaleLowerCase('en-US')) || ''
      );
      if (interests.some((value) => !value)) {
        clauses.push('0 = 1');
      } else {
        const membership = interests.map(() => 'lower(?)').join(', ');
        clauses.push(`(
          EXISTS (SELECT 1 FROM json_each(i.record_json, '$."Interests"') AS selected_interest
            WHERE lower(trim(CAST(selected_interest.value AS TEXT))) IN (${membership}))
          OR EXISTS (SELECT 1 FROM json_each(i.record_json, '$."Unmapped Interests"') AS legacy_interest
            WHERE lower(trim(CAST(legacy_interest.value AS TEXT))) IN (${membership}))
          )`);
          values.push(...interests, ...interests);
      }
    }
  }
  if (scope === 'campaign' && params.get('includeInactive') !== 'true') {
    clauses.push(`COALESCE(json_extract(i.record_json, '$."Influencer Status"'), 'Active') <> 'Inactive'`);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function influencerSortOrder(sort, scope = 'database') {
  if (scope !== 'database') return 'i.rowid DESC';
  if (sort === 'name-asc') return `json_extract(i.record_json, '$."Name"') COLLATE NOCASE ASC, i.rowid DESC`;
  if (sort === 'name-desc') return `json_extract(i.record_json, '$."Name"') COLLATE NOCASE DESC, i.rowid DESC`;
  const maxFollowers = `MAX(
    follower_count(json_extract(i.record_json, '$."Followers Count T"')),
    follower_count(json_extract(i.record_json, '$."Followers Count I"')),
    follower_count(json_extract(i.record_json, '$."Followers Count S"'))
  )`;
  if (sort === 'followers-asc') return `${maxFollowers} ASC, i.rowid DESC`;
  if (sort === 'followers-desc') return `${maxFollowers} DESC, i.rowid DESC`;
  return 'i.rowid DESC';
}

function getInfluencerPage(params, scope = 'database', { defaultPageSize = 50, maxPageSize = 100 } = {}) {
  const pageSize = Math.max(1, Math.min(maxPageSize, Number.parseInt(params.get('pageSize') || String(defaultPageSize), 10) || defaultPageSize));
  const requestedPage = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
  const where = buildInfluencerWhere(params, scope);
  const count = Number(database.prepare(`SELECT COUNT(*) AS count FROM influencers i ${where.sql}`).get(...where.values).count);
  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.min(requestedPage, pageCount);
  const sort = influencerSortOrder(params.get('sort') || 'recent', scope);
  const rows = database.prepare(`
    SELECT i.id, i.record_json FROM influencers i ${where.sql}
    ORDER BY ${sort} LIMIT ? OFFSET ?
  `).all(...where.values, pageSize, (page - 1) * pageSize).map((row) => ({
    ...deriveMainAccountFields(JSON.parse(row.record_json)),
    id: row.id
  }));
  return { rows, total: count, page, pageSize, pageCount };
}

function getInfluencerPageMetadata(rows, includeNotes) {
  const ids = rows.map((row) => row.id);
  if (!ids.length) return { archivedIds: [], noteCounts: {}, notePreviews: {} };
  const placeholders = ids.map(() => '?').join(', ');
  const archivedIds = database.prepare(`SELECT id FROM influencers WHERE archived_at IS NOT NULL AND id IN (${placeholders})`)
    .all(...ids).map((row) => row.id);
  if (!includeNotes) return { archivedIds, noteCounts: {}, notePreviews: {}, statusPreviews: {} };
  const statusPreviews = Object.fromEntries(database.prepare(`SELECT h.influencer_id, h.reason, h.status
      FROM influencer_status_history h
      WHERE h.influencer_id IN (${placeholders})
        AND h.id = (SELECT latest.id FROM influencer_status_history latest
          WHERE latest.influencer_id = h.influencer_id ORDER BY latest.changed_at DESC, latest.id DESC LIMIT 1)`)
    .all(...ids).map((row) => [row.influencer_id, { reason: row.reason, status: row.status }]));
  const noteCounts = Object.fromEntries(database.prepare(`SELECT influencer_id, COUNT(*) AS count
      FROM influencer_advertiser_notes WHERE deleted_at IS NULL AND influencer_id IN (${placeholders})
      GROUP BY influencer_id`).all(...ids).map((row) => [row.influencer_id, Number(row.count)]));
  const notePreviews = Object.fromEntries(database.prepare(`SELECT n.influencer_id, n.note_text AS noteText
      FROM influencer_advertiser_notes n
      WHERE n.deleted_at IS NULL AND n.influencer_id IN (${placeholders})
        AND n.created_at = (SELECT MAX(recent.created_at) FROM influencer_advertiser_notes recent
          WHERE recent.influencer_id = n.influencer_id AND recent.deleted_at IS NULL)`)
    .all(...ids).map((row) => [row.influencer_id, row.noteText]));
  return { archivedIds, noteCounts, notePreviews, statusPreviews };
}

function getInfluencerFilterOptions() {
  const fields = ['Country', 'Area', 'City', 'Gender', 'Face Appearance', 'Speak', 'Verified', 'Mawthouq', 'Paid or Voucher', 'Content Update', 'language'];
  const values = Object.fromEntries(fields.map((field) => [field, database.prepare(
    `SELECT DISTINCT json_extract(record_json, '$."${field}"') AS value FROM influencers
     WHERE trim(COALESCE(json_extract(record_json, '$."${field}"'), '')) <> '' ORDER BY value COLLATE NOCASE`
  ).all().map((row) => String(row.value))]));
  values['Content Update'] = [...influencerFieldOptions.yesNo];
  values.language = [...influencerFieldOptions.languages];
  const interests = database.prepare('SELECT name FROM interest_catalog ORDER BY name COLLATE NOCASE').all().map((row) => row.name);
  return {
    values,
    interests,
    languages: [...influencerFieldOptions.languages],
    yesNo: [...influencerFieldOptions.yesNo],
    classifications: interests,
    tiers: [...followerTiers],
    locations: database.prepare(`SELECT DISTINCT
      json_extract(record_json, '$."Country"') AS country,
      json_extract(record_json, '$."Area"') AS area,
      json_extract(record_json, '$."City"') AS city
      FROM influencers WHERE trim(COALESCE(json_extract(record_json, '$."Country"'), '')) <> ''
        OR trim(COALESCE(json_extract(record_json, '$."Area"'), '')) <> ''
        OR trim(COALESCE(json_extract(record_json, '$."City"'), '')) <> ''`).all()
      .map(({ country, area, city }) => ({ country: String(country || ''), area: String(area || ''), city: String(city || '') }))
  };
}

function validateInterestName(value) {
  const name = String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || name.length > 100 || /[,،;؛|\r\n]/u.test(name)) {
    throw Object.assign(new Error('اسم الاهتمام مطلوب، وبحد أقصى 100 حرف، ولا يقبل فواصل.'), { status: 400 });
  }
  return { name, normalizedName: normalizeInterestKey(name) };
}

function renameInterest(id, name, normalizedName) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const current = database.prepare('SELECT id, name FROM interest_catalog WHERE id = ?').get(id);
    if (!current) throw Object.assign(new Error('الاهتمام غير موجود.'), { status: 404 });
    const conflict = database.prepare('SELECT id FROM interest_catalog WHERE normalized_name = ? AND id <> ?')
      .get(normalizedName, id);
    if (conflict) throw Object.assign(new Error('يوجد اهتمام بالاسم نفسه.'), { status: 409 });
    const now = new Date().toISOString();
    database.prepare('UPDATE interest_catalog SET name = ?, normalized_name = ?, updated_at = ? WHERE id = ?')
      .run(name, normalizedName, now, id);
    refreshInterestNames(database.prepare('SELECT name FROM interest_catalog ORDER BY name COLLATE NOCASE').all().map((row) => row.name));
    const rows = database.prepare('SELECT id, record_json FROM influencers').all();
    const updateRecord = database.prepare('UPDATE influencers SET record_json = ? WHERE id = ?');
    for (const row of rows) {
      const record = JSON.parse(row.record_json || '{}');
      const interests = splitInterestValues(record.Interests).map((value) =>
        normalizeInterestKey(value) === normalizeInterestKey(current.name) ? name : value);
      if (JSON.stringify(interests) === JSON.stringify(record.Interests || [])) continue;
      const updated = normalizeRecord({ ...record, Interests: interests });
      updateRecord.run(JSON.stringify(updated), row.id);
    }
    database.exec('COMMIT');
    return { id, name };
  } catch (error) {
    database.exec('ROLLBACK');
    refreshInterestNames(database.prepare('SELECT name FROM interest_catalog ORDER BY name COLLATE NOCASE').all().map((row) => row.name));
    throw error;
  }
}

function getInfluencerStats() {
  const totals = database.prepare(`SELECT COUNT(*) AS total,
    COUNT(DISTINCT NULLIF(lower(ltrim(trim(COALESCE(
      NULLIF(trim(json_extract(record_json, '$."Username I"')), ''),
      NULLIF(trim(json_extract(record_json, '$."Instagram_Username"')), ''),
      NULLIF(trim(json_extract(record_json, '$."Instagram"')), '')
    )), '@')), '')) AS instagram,
    COUNT(DISTINCT NULLIF(lower(ltrim(trim(COALESCE(
      NULLIF(trim(json_extract(record_json, '$."Username T"')), ''),
      NULLIF(trim(json_extract(record_json, '$."TikTok_Username"')), ''),
      NULLIF(trim(json_extract(record_json, '$."TikTok"')), '')
    )), '@')), '')) AS tiktok,
    SUM(CASE WHEN trim(COALESCE(json_extract(record_json, '$."Username"'), '')) <> '' THEN 1 ELSE 0 END) AS snapchat,
    COUNT(DISTINCT NULLIF(lower(ltrim(trim(COALESCE(
      NULLIF(trim(json_extract(record_json, '$."Username"')), ''),
      NULLIF(trim(json_extract(record_json, '$."Username S"')), ''),
      NULLIF(trim(json_extract(record_json, '$."Snapchat_Username"')), ''),
      NULLIF(trim(json_extract(record_json, '$."Snapchat"')), '')
    )), '@')), '')) AS snapchatAccounts,
    SUM(CASE WHEN lower(trim(COALESCE(json_extract(record_json, '$."Gender"'), ''))) IN ('female', '\u0623\u0646\u062b\u0649', '\u0627\u0646\u062b\u0649') THEN 1 ELSE 0 END) AS female,
    SUM(CASE WHEN lower(trim(COALESCE(json_extract(record_json, '$."Gender"'), ''))) IN ('male', '\u0630\u0643\u0631') THEN 1 ELSE 0 END) AS male,
    SUM(CASE WHEN lower(trim(COALESCE(json_extract(record_json, '$."Verified"'), ''))) IN ('yes', 'true', 'نعم', '1') THEN 1 ELSE 0 END) AS verified,
    SUM(CASE WHEN lower(trim(COALESCE(json_extract(record_json, '$."Mawthouq"'), ''))) IN ('yes', 'true', 'نعم', '1') THEN 1 ELSE 0 END) AS mawthouq,
    COUNT(DISTINCT NULLIF(lower(trim(json_extract(record_json, '$."City"'))), '')) AS cities
    FROM influencers WHERE archived_at IS NULL`).get();
  const locations = database.prepare(`SELECT
    CASE WHEN trim(COALESCE(json_extract(record_json, '$."Country"'), '')) = '' THEN trim(json_extract(record_json, '$."City"'))
    ELSE trim(json_extract(record_json, '$."City"')) || ' · ' || trim(json_extract(record_json, '$."Country"')) END AS label,
    COUNT(*) AS count FROM influencers
    WHERE archived_at IS NULL AND trim(COALESCE(json_extract(record_json, '$."City"'), '')) <> ''
    GROUP BY label ORDER BY count DESC, label LIMIT 5`).all();
  const tiers = database.prepare(`SELECT label, COUNT(*) AS count FROM (
    SELECT follower_tier(json_extract(record_json, '$."Followers Count I"')) AS label FROM influencers WHERE archived_at IS NULL
    UNION ALL SELECT follower_tier(json_extract(record_json, '$."Followers Count T"')) FROM influencers WHERE archived_at IS NULL
    UNION ALL SELECT follower_tier(json_extract(record_json, '$."Followers Count S"')) FROM influencers WHERE archived_at IS NULL
  ) WHERE label <> '' GROUP BY label
  ORDER BY CASE label WHEN 'Nano' THEN 1 WHEN 'Micro' THEN 2 WHEN 'Macro' THEN 3 WHEN 'Semi Mega' THEN 4 WHEN 'Mega' THEN 5 ELSE 6 END`).all();
  const categories = database.prepare(`SELECT label, COUNT(*) AS count FROM (
    SELECT trim(CAST(interest.value AS TEXT)) AS label
      FROM influencers i, json_each(i.record_json, '$."Interests"') AS interest WHERE i.archived_at IS NULL
    UNION ALL
    SELECT trim(CAST(interest.value AS TEXT)) AS label
      FROM influencers i, json_each(i.record_json, '$."Unmapped Interests"') AS interest WHERE i.archived_at IS NULL
  ) WHERE label <> '' GROUP BY label ORDER BY count DESC, label LIMIT 6`).all();
  const classifications = categories;
  const genders = database.prepare(`SELECT CASE
      WHEN lower(trim(json_extract(record_json, '$."Gender"'))) IN ('female', 'أنثى', 'انثى') THEN 'أنثى'
      WHEN lower(trim(json_extract(record_json, '$."Gender"'))) IN ('male', 'ذكر') THEN 'ذكر'
      ELSE trim(json_extract(record_json, '$."Gender"')) END AS label, COUNT(*) AS count
    FROM influencers WHERE archived_at IS NULL AND trim(COALESCE(json_extract(record_json, '$."Gender"'), '')) <> ''
    GROUP BY label ORDER BY count DESC, label`).all();
  const paymentModes = database.prepare(`SELECT CASE
      WHEN lower(trim(json_extract(record_json, '$."Paid or Voucher"'))) IN ('both', 'كلاهما', 'الاثنان') THEN 'Both'
      WHEN lower(trim(json_extract(record_json, '$."Paid or Voucher"'))) IN ('voucher', 'قسيمة', 'coupon') THEN 'Voucher'
      WHEN lower(trim(json_extract(record_json, '$."Paid or Voucher"'))) IN ('paid', 'مدفوع', 'cash') THEN 'Paid'
      ELSE trim(json_extract(record_json, '$."Paid or Voucher"')) END AS label, COUNT(*) AS count
    FROM influencers WHERE archived_at IS NULL AND trim(COALESCE(json_extract(record_json, '$."Paid or Voucher"'), '')) <> ''
    GROUP BY label ORDER BY count DESC, label`).all();
  const recent = database.prepare('SELECT id, record_json FROM influencers WHERE archived_at IS NULL ORDER BY rowid DESC LIMIT 4').all().map((row) => ({
    ...JSON.parse(row.record_json), id: row.id
  }));
  return {
    total: Number(totals.total || 0), instagram: Number(totals.instagram || 0),
    tiktok: Number(totals.tiktok || 0), snapchat: Number(totals.snapchat || 0),
    snapchatAccounts: Number(totals.snapchatAccounts || 0),
    female: Number(totals.female || 0), male: Number(totals.male || 0),
    verified: Number(totals.verified || 0), mawthouq: Number(totals.mawthouq || 0), cities: Number(totals.cities || 0),
    classifications, locations, tiers, categories, genders, paymentModes, recent
  };
}

function getInfluencersByIds(ids) {
  const allIds = [...new Set(ids.map((id) => String(id)))];
  const uniqueIds = allIds.filter((id) => /^[a-f0-9]{32}$/i.test(id));
  const rows = [];
  for (let start = 0; start < uniqueIds.length; start += 500) {
    const batch = uniqueIds.slice(start, start + 500);
    if (!batch.length) continue;
    rows.push(...database.prepare(`SELECT id, record_json FROM influencers WHERE id IN (${batch.map(() => '?').join(',')})`).all(...batch));
  }
  const records = rows.map((row) => ({
    ...deriveMainAccountFields(JSON.parse(row.record_json)),
    id: row.id
  }));
  const foundIds = new Set(records.map((record) => record.id));
  return { rows: records, missingIds: allIds.filter((id) => !foundIds.has(id)) };
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

const presentationFieldKeys = new Set([
  'name', 'profileImage', 'platform', 'username', 'visitDate', 'visitTime',
  'visitCity', 'visitBranch', 'visitAddress', 'followers', 'price'
]);

function normalizedPresentationDate(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? date : '';
}

function normalizedPresentationTime(value) {
  const match = String(value || '').match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : '';
}

function riyadhClock(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function completedPresentationVisits(rows) {
  const now = riyadhClock();
  return rows.reduce((count, row) => {
    const visitDate = normalizedPresentationDate(row.visitDate);
    if (!visitDate) return count;
    if (visitDate < now.date) return count + 1;
    if (visitDate > now.date) return count;
    const visitTime = normalizedPresentationTime(row.visitTime);
    return visitTime && visitTime <= now.time ? count + 1 : count;
  }, 0);
}

function parseYouTubeVideoUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  const rawUrl = value.trim();
  try { url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawUrl) ? rawUrl : `https://${rawUrl}`); } catch { return null; }
  const allowedHosts = new Set([
    'youtube.com', 'www.youtube.com', 'm.youtube.com',
    'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be'
  ]);
  if (url.protocol !== 'https:' || !allowedHosts.has(url.hostname.toLowerCase())
    || url.username || url.password || url.port) return null;
  let videoId = '';
  if (url.hostname.toLowerCase() === 'youtu.be') videoId = url.pathname.split('/').filter(Boolean)[0] || '';
  else if (url.pathname === '/watch') videoId = url.searchParams.get('v') || '';
  else videoId = url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] || '';
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

function validatePresentationVideos(value) {
  if (!Array.isArray(value) || value.length > 50) {
    throw Object.assign(new Error('قائمة نماذج الفيديو غير صالحة أو تتجاوز 50 فيديو.'), { status: 400 });
  }
  const seen = new Set();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error('بيانات أحد فيديوهات العرض غير صالحة.'), { status: 400 });
    }
    const parsed = parseYouTubeVideoUrl(item.url);
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    if (!parsed || (item.title !== undefined && typeof item.title !== 'string') || title.length > 200 || seen.has(parsed.videoId)) {
      throw Object.assign(new Error('تحقق من روابط YouTube والعناوين، ولا تكرر الفيديو نفسه.'), { status: 400 });
    }
    seen.add(parsed.videoId);
    return { id: typeof item.id === 'string' ? item.id : '', ...parsed, title };
  });
}

function savePresentationVideos(presentationId, videos) {
  const existingIds = new Set(database.prepare(
    'SELECT id FROM campaign_presentation_videos WHERE presentation_id = ?'
  ).all(presentationId).map((row) => row.id));
  const usedIds = new Set();
  const insert = database.prepare(`INSERT INTO campaign_presentation_videos
    (id, presentation_id, youtube_video_id, video_url, title, position)
    VALUES (?, ?, ?, ?, ?, ?)`);
  database.prepare('DELETE FROM campaign_presentation_videos WHERE presentation_id = ?').run(presentationId);
  videos.forEach((video, position) => {
    const id = existingIds.has(video.id) && !usedIds.has(video.id) ? video.id : randomBytes(16).toString('hex');
    usedIds.add(id);
    insert.run(id, presentationId, video.videoId, video.url, video.title, position);
  });
}

function presentationVideos(presentationId) {
  return database.prepare(`SELECT id, youtube_video_id AS videoId, video_url AS url,
      title, position FROM campaign_presentation_videos WHERE presentation_id = ? ORDER BY position`)
    .all(presentationId);
}

const defaultPresentationDisplayOptions = Object.freeze({
  showInfluencerDetails: true,
  showSocialAccounts: true,
  showFollowers: true,
  showAdditionalDetails: true,
  showCompanyWork: false
});

function presentationDisplayOptions(presentationId) {
  const row = database.prepare(`SELECT show_influencer_details AS showInfluencerDetails,
      show_social_accounts AS showSocialAccounts, show_followers AS showFollowers,
      show_additional_details AS showAdditionalDetails, show_company_work AS showCompanyWork
    FROM campaign_presentation_display_options WHERE presentation_id = ?`).get(presentationId);
  if (!row) return { ...defaultPresentationDisplayOptions };
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Boolean(value)]));
}

function validatePresentationDisplayOptions(value, fallback = defaultPresentationDisplayOptions) {
  if (value === undefined) return { ...fallback };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('خيارات عرض العميل غير صالحة.'), { status: 400 });
  }
  const result = {};
  for (const key of Object.keys(defaultPresentationDisplayOptions)) {
    const option = value[key] === undefined ? fallback[key] : value[key];
    if (typeof option !== 'boolean') {
      throw Object.assign(new Error('يجب تحديد إظهار أو إخفاء كل خيار للعرض.'), { status: 400 });
    }
    result[key] = option;
  }
  return result;
}

function validateCompanyWorkVideoIds(value, retainedIds = []) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50
    || value.some((id) => typeof id !== 'string' || !/^[a-f0-9]{32}$/i.test(id))
    || new Set(value).size !== value.length) {
    throw Object.assign(new Error('اختيارات فيديوهات أعمال فكرتك غير صالحة.'), { status: 400 });
  }
  if (!value.length) return [];
  const rows = database.prepare(`SELECT id, active FROM company_work_videos
    WHERE id IN (${value.map(() => '?').join(',')})`).all(...value);
  const retained = new Set(retainedIds);
  if (rows.length !== value.length || rows.some((row) => !row.active && !retained.has(row.id))) {
    throw Object.assign(new Error('تأكد أن جميع فيديوهات العرض موجودة ومفعّلة في مكتبة أعمال فكرتك.'), { status: 400 });
  }
  return value;
}

function savePresentationDisplayOptions(presentationId, options) {
  database.prepare(`INSERT INTO campaign_presentation_display_options
    (presentation_id, show_influencer_details, show_social_accounts, show_followers,
      show_additional_details, show_company_work)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(presentation_id) DO UPDATE SET
      show_influencer_details = excluded.show_influencer_details,
      show_social_accounts = excluded.show_social_accounts,
      show_followers = excluded.show_followers,
      show_additional_details = excluded.show_additional_details,
      show_company_work = excluded.show_company_work`)
    .run(presentationId, Number(options.showInfluencerDetails), Number(options.showSocialAccounts),
      Number(options.showFollowers), Number(options.showAdditionalDetails), Number(options.showCompanyWork));
}

function savePresentationCompanyWorkVideos(presentationId, videoIds) {
  database.prepare('DELETE FROM campaign_presentation_work_videos WHERE presentation_id = ?').run(presentationId);
  const insert = database.prepare(`INSERT INTO campaign_presentation_work_videos
    (presentation_id, video_id, position) VALUES (?, ?, ?)`);
  videoIds.forEach((videoId, position) => insert.run(presentationId, videoId, position));
}

function companyWorkVideoList(includeInactive = true) {
  return database.prepare(`SELECT id, youtube_video_id AS videoId, video_url AS url, title,
      active, created_at AS createdAt, updated_at AS updatedAt
    FROM company_work_videos ${includeInactive ? '' : 'WHERE active = 1'}
    ORDER BY created_at DESC, id`).all().map((video) => ({ ...video, active: Boolean(video.active) }));
}

const catalogAccountFields = {
  Instagram: { username: 'Username I', followers: 'Followers Count I' },
  TikTok: { username: 'Username T', followers: 'Followers Count T' },
  Snapchat: { username: 'Username', followers: 'Followers Count S' }
};

function validateCatalogAccountVisibility(value, influencerIds, influencers) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('إعدادات ظهور الحسابات غير صالحة.'), { status: 400 });
  }
  const allowedIds = new Set(influencerIds);
  const records = new Map(influencers.map((item) => [item.id, item]));
  const normalized = new Map();
  for (const [influencerId, platforms] of Object.entries(value)) {
    if (!allowedIds.has(influencerId) || !records.has(influencerId)
      || !platforms || typeof platforms !== 'object' || Array.isArray(platforms)
      || Object.keys(platforms).some((platform) => !Object.hasOwn(catalogAccountFields, platform))
      || Object.values(platforms).some((visible) => typeof visible !== 'boolean')) {
      throw Object.assign(new Error('إعدادات ظهور أحد الحسابات غير صالحة.'), { status: 400 });
    }
    normalized.set(influencerId, Object.fromEntries(
      Object.keys(catalogAccountFields).map((platform) => [platform, platforms[platform] !== false])
    ));
  }
  return normalized;
}

function saveCatalogAccountVisibility(catalogId, visibilityByInfluencer, influencers) {
  if (!visibilityByInfluencer) return;
  const recordById = new Map(influencers.map((item) => [item.id, item]));
  const remove = database.prepare('DELETE FROM client_catalog_account_visibility WHERE catalog_id = ? AND influencer_id = ?');
  const insert = database.prepare(`INSERT INTO client_catalog_account_visibility
    (catalog_id, influencer_id, platform, visible) VALUES (?, ?, ?, ?)`);
  for (const [influencerId, platforms] of visibilityByInfluencer) {
    const record = recordById.get(influencerId);
    if (!record) continue;
    remove.run(catalogId, influencerId);
    for (const [platform, fields] of Object.entries(catalogAccountFields)) {
      if (!String(record[fields.username] || '').trim()) continue;
      insert.run(catalogId, influencerId, platform, Number(platforms[platform]));
    }
  }
}

function catalogAccountVisibilityMap(catalogId, influencerId, record) {
  const stored = new Map(database.prepare(`SELECT platform, visible FROM client_catalog_account_visibility
    WHERE catalog_id = ? AND influencer_id = ?`).all(catalogId, influencerId)
    .map((row) => [row.platform, Boolean(row.visible)]));
  return Object.fromEntries(Object.entries(catalogAccountFields)
    .filter(([, fields]) => String(record[fields.username] || '').trim())
    .map(([platform]) => [platform, stored.get(platform) ?? true]));
}

function coverageVideoList({ query = '', campaignId = '', influencerId = '', page = 1, pageSize = 50 } = {}) {
  const values = [];
  const conditions = [];
  if (campaignId) { conditions.push('v.campaign_id = ?'); values.push(campaignId); }
  if (influencerId) { conditions.push('v.influencer_id = ?'); values.push(influencerId); }
  if (query) {
    const match = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(`(v.title LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\'
      OR json_extract(i.record_json, '$.Name') LIKE ? ESCAPE '\\'
      OR json_extract(i.record_json, '$.Main_Username') LIKE ? ESCAPE '\\'
      OR json_extract(i.record_json, '$."Username I"') LIKE ? ESCAPE '\\'
      OR json_extract(i.record_json, '$."Username T"') LIKE ? ESCAPE '\\'
      OR json_extract(i.record_json, '$."Username"') LIKE ? ESCAPE '\\')`);
    values.push(...Array(7).fill(match));
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM coverage_videos v
    LEFT JOIN influencers i ON i.id = v.influencer_id ${where}`).get(...values).count);
  const rows = database.prepare(`SELECT v.id, v.youtube_video_id AS videoId, v.video_url AS url,
      v.title, v.description, v.influencer_id AS influencerId, v.campaign_id AS campaignId,
      v.created_at AS createdAt, v.updated_at AS updatedAt,
      COALESCE(json_extract(i.record_json, '$.Name'), '') AS influencerName,
      COALESCE(json_extract(i.record_json, '$.Main_Username'), '') AS mainUsername,
      COALESCE(c.campaign_name, '') AS campaignName, COALESCE(c.company_name, '') AS companyName
    FROM coverage_videos v
    LEFT JOIN influencers i ON i.id = v.influencer_id
    LEFT JOIN campaigns c ON c.id = v.campaign_id
    ${where}
    ORDER BY v.updated_at DESC, v.created_at DESC, v.id
    LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
  const influencers = database.prepare(`SELECT DISTINCT i.id,
      COALESCE(json_extract(i.record_json, '$.Name'), '') AS name,
      COALESCE(json_extract(i.record_json, '$.Main_Username'), '') AS mainUsername
    FROM coverage_videos v JOIN influencers i ON i.id = v.influencer_id
    ORDER BY name COLLATE NOCASE, mainUsername COLLATE NOCASE`).all();
  const campaigns = database.prepare(`SELECT DISTINCT c.id, c.campaign_name AS campaignName
    FROM coverage_videos v JOIN campaigns c ON c.id = v.campaign_id
    ORDER BY campaignName COLLATE NOCASE`).all();
  return {
    rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)),
    filters: { influencers, campaigns }
  };
}

function coverageVideoById(id) {
  return database.prepare(`SELECT v.id, v.youtube_video_id AS videoId, v.video_url AS url,
      v.title, v.description, v.influencer_id AS influencerId, v.campaign_id AS campaignId,
      v.created_at AS createdAt, v.updated_at AS updatedAt,
      COALESCE(json_extract(i.record_json, '$.Name'), '') AS influencerName,
      COALESCE(json_extract(i.record_json, '$.Main_Username'), '') AS mainUsername,
      COALESCE(c.campaign_name, '') AS campaignName, COALESCE(c.company_name, '') AS companyName
    FROM coverage_videos v
    LEFT JOIN influencers i ON i.id = v.influencer_id
    LEFT JOIN campaigns c ON c.id = v.campaign_id
    WHERE v.id = ?`).get(id);
}

function coverageReferenceIds(body, current = {}) {
  const influencerId = body.influencerId === undefined ? current.influencerId : body.influencerId;
  const campaignId = body.campaignId === undefined ? current.campaignId : body.campaignId;
  if (typeof influencerId !== 'string' || !/^[a-f0-9]{32}$/i.test(influencerId)
    || !database.prepare('SELECT 1 FROM influencers WHERE id = ?').get(influencerId)) {
    throw Object.assign(new Error('اختر مؤثرًا موجودًا في قاعدة البيانات.'), { status: 400 });
  }
  if (typeof campaignId !== 'string' || !/^[a-f0-9]{32}$/i.test(campaignId)
    || !database.prepare('SELECT 1 FROM campaigns WHERE id = ?').get(campaignId)) {
    throw Object.assign(new Error('اختر حملة موجودة في النظام.'), { status: 400 });
  }
  return { influencerId, campaignId };
}

function presentationCompanyWorkVideos(presentationId) {
  return database.prepare(`SELECT v.id, v.youtube_video_id AS videoId, v.video_url AS url, v.title
    FROM campaign_presentation_work_videos pv JOIN company_work_videos v ON v.id = pv.video_id
    WHERE pv.presentation_id = ? AND v.active = 1 ORDER BY pv.position`)
    .all(presentationId);
}

function presentationFileInfo(row) {
  return {
    id: row.id, kind: row.kind, platform: row.platform || '', phase: row.phase || '',
    captureDate: row.capture_date || '', note: row.note || '', fileName: row.file_name,
    mimeType: row.mime_type, createdAt: row.created_at,
    url: `/api/campaigns/${row.campaign_id}/workspace/${row.kind === 'evidence' ? 'evidence' : 'files'}/${row.id}`
  };
}

function readPresentation(token) {
  const presentation = database.prepare(`SELECT p.id, p.campaign_id AS campaignId,
      p.client_account_id AS clientAccountId, p.fields_json AS fieldsJson,
      p.brand_id AS brandId, p.brand_snapshot_json AS brandSnapshotJson,
      p.presentation_mode AS presentationMode, p.header_title AS headerTitle,
      p.header_tagline AS headerTagline, p.package_visits_count AS packageVisitsCount,
      a.client_name AS clientName, a.company_name AS clientCompany,
      c.campaign_name AS campaignName, c.company_name AS companyName, c.execution_mode AS campaignType,
      c.service_type AS serviceType
    FROM campaign_presentations p JOIN campaigns c ON c.id = p.campaign_id
    JOIN client_account_campaigns ac ON ac.campaign_id = c.id AND ac.account_id = p.client_account_id
    JOIN client_accounts a ON a.id = p.client_account_id AND a.active = 1
    WHERE p.token_hash = ? AND p.active = 1`).get(tokenHash(token));
  if (!presentation || !['visit', 'mix'].includes(presentation.campaignType)) return null;
  const visitsMode = presentation.presentationMode === 'visits';
  let fields = [];
  try { fields = JSON.parse(presentation.fieldsJson); } catch {}
  fields = Array.isArray(fields) ? [...new Set(fields.filter((field) => presentationFieldKeys.has(field)))] : [];
  if (visitsMode) {
    fields = fields.filter((field) => field !== 'price');
    for (const requiredField of ['visitDate', 'visitTime']) {
      if (!fields.includes(requiredField)) fields.push(requiredField);
    }
  }
  const priceSelection = visitsMode ? '' : ', ct.campaign_price AS campaignPrice';
  const rows = database.prepare(`SELECT pt.influencer_id AS influencerId,
      ct.visit_date AS visitDate, ct.visit_time AS visitTime, ct.visit_city AS visitCity,
      ct.visit_branch AS visitBranch, ct.visit_address AS visitAddress${priceSelection},
      i.record_json AS recordJson,
      image.content_hash AS profileImageHash
    FROM campaign_presentation_targets pt
    JOIN campaign_targets ct ON ct.campaign_id = pt.campaign_id AND ct.influencer_id = pt.influencer_id
    JOIN influencers i ON i.id = pt.influencer_id
    LEFT JOIN influencer_profile_images image ON image.influencer_id = i.id
    WHERE pt.presentation_id = ? AND ct.execution_type = 'visit'
    ORDER BY COALESCE(ct.visit_date, ''), COALESCE(ct.visit_time, ''), pt.position`).all(presentation.id);
  const clientLogo = database.prepare(`SELECT 1 AS present
    FROM campaign_presentation_client_logos WHERE presentation_id = ?`).get(presentation.id);
  const brand = getBrandSnapshot(presentation);
  const displayOptions = presentation.brandId === 'ryfaq'
    ? { ...presentationDisplayOptions(presentation.id), showCompanyWork: false }
    : presentationDisplayOptions(presentation.id);
  const visibleRows = visitsMode ? rows.filter((row) => normalizedPresentationDate(row.visitDate)) : rows;
  const targets = visibleRows.map((row) => {
    const record = JSON.parse(row.recordJson || '{}');
    const accounts = [
      { platform: 'Instagram', username: record['Username I'] || record.Instagram_Username || record.Instagram, followers: record['Followers Count I'] },
      { platform: 'TikTok', username: record['Username T'] || record.TikTok_Username || record.TikTok, followers: record['Followers Count T'] },
      { platform: 'Snapchat', username: record.Username || record['Username S'] || record.Snapchat_Username || record.Snapchat, followers: record['Followers Count S'] }
    ].filter((account) => String(account.username || '').trim());
    const platforms = accounts.map((account) => account.platform);
    const preferredPlatform = normalizeImportPlatform(record['Best Platform']);
    const followerAccount = accounts.find((account) => account.platform === preferredPlatform) || accounts[0];
    const placeholderImage = profilePlaceholderUrl(record);
    const profileImage = row.profileImageHash
      ? `/profile-images/${row.influencerId}?v=${row.profileImageHash.slice(0, 12)}`
      : profileImageSourceUrl(record) || placeholderImage;
    const values = {
      name: String(record.Name || ''), profileImage, placeholderImage,
      platform: platforms.join(' · '),
      username: String(followerAccount?.username || ''),
      visitDate: visitsMode ? normalizedPresentationDate(row.visitDate) || '' : row.visitDate || '',
      visitTime: visitsMode ? normalizedPresentationTime(row.visitTime) : row.visitTime || '',
      visitCity: row.visitCity || '', visitBranch: row.visitBranch || '', visitAddress: row.visitAddress || '',
      followers: String(followerAccount?.followers ?? '')
    };
    if (!visitsMode) values.price = String(row.campaignPrice || '');
    if (!displayOptions.showInfluencerDetails) {
      values.name = '';
      values.profileImage = '';
      values.placeholderImage = '';
    }
    if (!displayOptions.showSocialAccounts) {
      values.platform = '';
      values.username = '';
    }
    if (!displayOptions.showFollowers) values.followers = '';
    if (!displayOptions.showAdditionalDetails) {
      for (const field of ['visitDate', 'visitTime', 'visitCity', 'visitBranch', 'visitAddress']) {
        if (!visitsMode || !['visitDate', 'visitTime'].includes(field)) values[field] = '';
      }
      if (!visitsMode) values.price = '';
    }
    return {
      influencerId: row.influencerId,
      ...Object.fromEntries(fields.map((field) => [field, values[field]])),
      ...(fields.includes('profileImage') && displayOptions.showInfluencerDetails ? { placeholderImage } : {})
    };
  });
  return {
    brand,
    campaign: {
      name: presentation.campaignName, company: presentation.companyName,
      serviceType: presentation.serviceType, clientName: presentation.clientName,
      clientCompany: presentation.clientCompany
    },
    presentation: {
      mode: visitsMode ? 'visits' : 'selecting',
      title: presentation.headerTitle || '',
      tagline: presentation.headerTagline || '',
      packageVisitsCount: visitsMode ? presentation.packageVisitsCount : null,
      packageVisitsCompleted: visitsMode && presentation.packageVisitsCount !== null
        ? completedPresentationVisits(rows) : null,
      clientLogoUrl: clientLogo
        ? `/api/campaign-presentations/${token}/client-logo` : ''
    },
    fields, displayOptions, targets, videoReferences: presentation.brandId === 'ryfaq' ? [] : presentationVideos(presentation.id).map((video) => ({
      id: video.id, videoId: video.videoId, title: video.title, url: video.url
    })), companyWorkVideos: presentation.brandId !== 'ryfaq' && displayOptions.showCompanyWork
      ? presentationCompanyWorkVideos(presentation.id) : []
  };
}

function primaryUsername(record) {
  return String(record.Main_Username || '').trim();
}

function clientShowcaseRecord(record, feedback = {}, visibility = {}) {
  const platforms = [
    { name: 'TikTok', username: 'Username T', followers: 'Followers Count T' },
    { name: 'Instagram', username: 'Username I', followers: 'Followers Count I' },
    { name: 'Snapchat', username: 'Username', followers: 'Followers Count S' }
  ];
  const socialAccounts = platforms.flatMap((platform) => {
    if (visibility[platform.name] === false) return [];
    const username = String(record[platform.username] || '').replace(/^@/, '').trim();
    if (!username) return [];
    const encoded = encodeURIComponent(username);
    const url = platform.name === 'TikTok' ? `https://www.tiktok.com/@${encoded}`
      : platform.name === 'Instagram' ? `https://www.instagram.com/${encoded}/`
        : `https://www.snapchat.com/add/${encoded}`;
    return [{
      platform: platform.name,
      username,
      followers: String(record[platform.followers] || ''),
      profileUrl: url
    }];
  });
  const categories = [...new Set([
    ...(Array.isArray(record.Interests) ? record.Interests : []),
    ...(Array.isArray(record['Unmapped Interests']) ? record['Unmapped Interests'] : [])
  ].map((value) => String(value || '').trim()).filter(Boolean))];
  const isYes = (value) => ['yes', 'y', 'نعم', 'true', '1'].includes(String(value || '').trim().toLowerCase());
  const hiddenUsernames = platforms.filter((platform) => visibility[platform.name] === false)
    .map((platform) => String(record[platform.username] || '').replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean);
  const visibleUsernames = socialAccounts.map((account) => account.username.toLowerCase());
  const mainUsernameValue = primaryUsername(record);
  const normalizedMainUsername = mainUsernameValue.replace(/^@/, '').trim().toLowerCase();
  return {
    name: String(record.Name || ''),
    mainUsername: hiddenUsernames.includes(normalizedMainUsername) && !visibleUsernames.includes(normalizedMainUsername)
      ? '' : mainUsernameValue,
    socialAccounts,
    city: String(record.City || ''),
    area: String(record.Area || ''),
    categories,
    verified: isYes(record.Verified),
    mawthouq: isYes(record.Mawthouq),
    favorite: Boolean(feedback.isFavorite),
    comment: String(feedback.comment || '')
  };
}

function publicOfferAccount(record, usernameField, followersField) {
  const username = String(record[usernameField] || '').replace(/^@/, '').trim();
  const rawFollowers = String(record[followersField] || '').trim();
  const followers = parseFollowerValue(rawFollowers) === null ? '' : rawFollowers;
  return {
    username,
    followers
  };
}

function accountLinkForRecord(record) {
  const platform = String(record['Best Platform'] || '').toLowerCase();
  const accountUsername = platform.includes('tik') ? record['Username T']
    : platform.includes('snap') ? record.Username
      : platform.includes('insta') ? record['Username I'] : '';
  const username = String(accountUsername || '').replace(/^@/, '').trim();
  if (!username) return '';
  const host = platform.includes('tik') ? 'www.tiktok.com/@'
    : platform.includes('snap') ? 'www.snapchat.com/add/'
      : platform.includes('insta') ? 'www.instagram.com/' : '';
  return host ? `https://${host}${encodeURIComponent(username)}` : '';
}

function sanitizeClientRecord(record, { showCity, showCategory, showDetails }) {
  const publicDetailKeys = new Set([
    'gender', 'verified', 'mawthouq', 'speak', 'language', 'face appearance', 'hijab'
  ]);
  const basicDetailKeys = new Set([
    'city', 'area', 'country',
    'full classification', 'classification',
    'categories 1', 'categories 2', 'categories 3', 'categories 4'
  ]);
  const output = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (!key) continue;
    const normalized = String(key).trim().toLowerCase();
    if (!basicDetailKeys.has(normalized) && !publicDetailKeys.has(normalized)) continue;
    if (value === null || value === undefined || String(value).trim() === '') continue;
    if (['Nano', 'Micro', 'Macro', 'Semi Mega', 'Mega'].includes(String(value).trim())) continue;
    if (!showCity && ['city', 'area', 'country'].includes(normalized)) continue;
    if (!showCategory && (normalized.includes('categor') || normalized.includes('classif') || normalized.includes('influencer type'))) continue;
    if (!showDetails && !basicDetailKeys.has(normalized)) continue;
    output[key] = value;
  }
  return output;
}

function catalogCoverageVideos(catalog) {
  if (!catalog || catalog.brandId === 'ryfaq') return [];
  return database.prepare(`SELECT v.id, v.youtube_video_id AS videoId, v.title, v.description,
      COALESCE(json_extract(i.record_json, '$.Name'), '') AS influencerName
    FROM coverage_videos v
    JOIN campaigns c ON c.id = v.campaign_id
    JOIN client_catalog_items ci ON ci.influencer_id = v.influencer_id AND ci.catalog_id = ?
    JOIN influencers i ON i.id = v.influencer_id AND i.archived_at IS NULL
    WHERE lower(trim(c.company_name)) = lower(trim(?))
    ORDER BY ci.position, v.updated_at DESC, v.created_at DESC, v.id`)
    .all(catalog.id, catalog.company_name || '');
}

function catalogClientPresentation(catalog) {
  if (!catalog) return null;
  const linkedAccount = database.prepare('SELECT account_id FROM client_account_catalogs WHERE catalog_id = ?').get(catalog.id);
  const items = database.prepare(`
    SELECT i.id, i.record_json, image.content_hash AS profileImageHash
    FROM client_catalog_items ci
    JOIN influencers i ON i.id = ci.influencer_id
    LEFT JOIN influencer_profile_images image ON image.influencer_id = i.id
    WHERE ci.catalog_id = ?
    ORDER BY ci.position, i.rowid DESC
  `).all(catalog.id);
  const decisions = database.prepare('SELECT influencer_id, decision FROM client_catalog_decisions WHERE catalog_id = ?').all(catalog.id);
  const decisionMap = new Map(decisions.map((row) => [row.influencer_id, row.decision]));
  const companyWorkVideos = catalog.brandId === 'ryfaq' ? [] : catalog.show_company_work
    ? database.prepare(`SELECT v.id, v.youtube_video_id AS videoId, v.video_url AS url, v.title
        FROM client_catalog_work_videos cv
        JOIN company_work_videos v ON v.id = cv.video_id
        WHERE cv.catalog_id = ? AND v.active = 1
        ORDER BY cv.position`).all(catalog.id)
    : [];
  return {
    clientName: String(catalog.client_name || ''),
    offerName: catalog.offer_name || catalog.company_name,
    companyName: catalog.company_name,
    brand: getBrandSnapshot(catalog),
    decisionsEnabled: !catalog.portal_linked && !linkedAccount,
    showCity: Boolean(catalog.show_city !== 0),
    showCategory: Boolean(catalog.show_category !== 0),
    showDetails: Boolean(catalog.show_details !== 0),
    showCompanyWork: catalog.brandId !== 'ryfaq' && Boolean(catalog.show_company_work),
    companyWorkVideos,
    coverageVideos: catalogCoverageVideos(catalog),
    influencers: items.map(({ id, record_json, profileImageHash }) => {
      const record = JSON.parse(record_json);
      const accountVisibility = catalogAccountVisibilityMap(catalog.id, id, record);
      const bestPlatformValue = String(record['Best Platform'] || '').trim();
      const bestPlatformLower = bestPlatformValue.toLowerCase();
      const bestPlatform = bestPlatformLower.includes('tik') ? 'TikTok'
        : bestPlatformLower.includes('snap') ? 'Snapchat'
          : bestPlatformLower.includes('insta') ? 'Instagram' : '';
      const platform = bestPlatform && accountVisibility[bestPlatform] === false ? '' : bestPlatformValue;
      const mainUsernameValue = primaryUsername(record);
      const hiddenAccounts = Object.entries(catalogAccountFields)
        .filter(([name]) => accountVisibility[name] === false)
        .map(([, fields]) => String(record[fields.username] || '').replace(/^@/, '').trim().toLowerCase())
        .filter(Boolean);
      const visibleAccounts = Object.entries(catalogAccountFields)
        .filter(([name]) => accountVisibility[name] !== false)
        .map(([, fields]) => String(record[fields.username] || '').replace(/^@/, '').trim().toLowerCase())
        .filter(Boolean);
      const mainUsername = hiddenAccounts.includes(mainUsernameValue.replace(/^@/, '').trim().toLowerCase())
        && !visibleAccounts.includes(mainUsernameValue.replace(/^@/, '').trim().toLowerCase())
        ? '' : mainUsernameValue;
      const instagram = publicOfferAccount(record, 'Username I', 'Followers Count I');
      const tiktok = publicOfferAccount(record, 'Username T', 'Followers Count T');
      const snapchat = publicOfferAccount(record, 'Username', 'Followers Count S');
      return {
        influencerId: id,
        name: String(record.Name || ''),
        profileImage: profileImageHash ? `/profile-images/${id}?v=${profileImageHash.slice(0, 12)}` : profileImageSourceUrl(record),
        placeholderImage: profilePlaceholderUrl(record),
        platform,
        bestPlatform: platform ? bestPlatformValue : '',
        mainUsername,
        decision: catalog.portal_linked || linkedAccount ? 'pending' : decisionMap.get(id) || 'pending',
        instagramUsername: accountVisibility.Instagram === false ? '' : instagram.username,
        instagramFollowers: accountVisibility.Instagram === false ? '' : instagram.followers,
        tiktokUsername: accountVisibility.TikTok === false ? '' : tiktok.username,
        tiktokFollowers: accountVisibility.TikTok === false ? '' : tiktok.followers,
        snapchatUsername: accountVisibility.Snapchat === false ? '' : snapchat.username,
        snapchatFollowers: accountVisibility.Snapchat === false ? '' : snapchat.followers,
        details: sanitizeClientRecord(record, {
          showCity: Boolean(catalog.show_city !== 0),
          showCategory: Boolean(catalog.show_category !== 0),
          showDetails: Boolean(catalog.show_details !== 0)
        })
      };
    })
  };
}

function normalizeCatalogExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw Object.assign(new Error('تاريخ انتهاء الصلاحية غير صالح.'), { status: 400 });
  }
  const expiresAt = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.toISOString().slice(0, 10) !== value
    || expiresAt.getTime() <= Date.now()) {
    throw Object.assign(new Error('اختر تاريخ انتهاء مستقبليًا وصالحًا.'), { status: 400 });
  }
  return expiresAt.toISOString();
}

function publicCatalog(token, { logAccess = false } = {}) {
  const catalog = database.prepare(`SELECT id, client_name, company_name, offer_name, offer_status, portal_linked,
      show_city, show_category, show_details, show_company_work, brand_id AS brandId,
      brand_snapshot_json AS brandSnapshotJson, expires_at AS expiresAt, active
    FROM client_catalogs
    WHERE token_hash = ?`).get(tokenHash(token));
  if (!catalog) return null;
  const expired = catalog.expiresAt && Date.parse(catalog.expiresAt) <= Date.now();
  const eventType = expired ? 'expired'
    : catalog.active && catalog.offer_status === 'published' ? 'view' : 'unavailable';
  if (logAccess) {
    database.prepare(`INSERT INTO client_catalog_access_events (catalog_id, event_type, accessed_at)
      VALUES (?, ?, ?)`).run(catalog.id, eventType, new Date().toISOString());
  }
  if (expired || !catalog.active || catalog.offer_status !== 'published') {
    return { unavailable: true, expired: Boolean(expired) };
  }
  return { catalog: catalogClientPresentation(catalog), expired: false };
}

function clientCatalogSummaries() {
  const outcomes = new Map();
  const acceptedInfluencers = new Map();
  const decidedInfluencers = new Map();
  for (const row of database.prepare(`
    SELECT catalog_id, decision, COUNT(*) AS count
    FROM client_catalog_decisions
    GROUP BY catalog_id, decision
  `).all()) {
    const current = outcomes.get(row.catalog_id) || { acceptedCount: 0, rejectedCount: 0 };
    if (row.decision === 'accepted') current.acceptedCount += Number(row.count || 0);
    if (row.decision === 'rejected') current.rejectedCount += Number(row.count || 0);
    outcomes.set(row.catalog_id, current);
  }
  for (const row of database.prepare(`
    SELECT d.catalog_id AS catalogId, i.record_json AS recordJson
    FROM client_catalog_decisions d
    JOIN client_catalog_items ci ON ci.catalog_id = d.catalog_id AND ci.influencer_id = d.influencer_id
    JOIN influencers i ON i.id = d.influencer_id
    WHERE d.decision = 'accepted'
    ORDER BY d.catalog_id, ci.position
  `).all()) {
    const accounts = acceptedInfluencers.get(row.catalogId) || [];
    const username = primaryUsername(JSON.parse(row.recordJson)).replace(/^@/, '');
    accounts.push(username ? `@${username}` : 'اسم المستخدم الرئيسي غير متوفر');
    acceptedInfluencers.set(row.catalogId, accounts);
  }
  for (const row of database.prepare(`
    SELECT d.catalog_id AS catalogId, d.decision, i.id AS influencerId,
      i.record_json AS recordJson
    FROM client_catalog_decisions d
    JOIN client_catalog_items ci ON ci.catalog_id = d.catalog_id AND ci.influencer_id = d.influencer_id
    JOIN influencers i ON i.id = d.influencer_id
    WHERE d.decision IN ('accepted', 'rejected')
    ORDER BY d.catalog_id, d.decision, ci.position
  `).all()) {
    const records = decidedInfluencers.get(row.catalogId) || { accepted: [], rejected: [] };
    const record = JSON.parse(row.recordJson);
    const accounts = [
      { platform: 'Instagram', username: record['Username I'] || '', followers: record['Followers Count I'] },
      { platform: 'TikTok', username: record['Username T'] || '', followers: record['Followers Count T'] },
      { platform: 'Snapchat', username: record.Username || '', followers: record['Followers Count S'] }
    ].filter((account) => String(account.username || '').trim())
      .map((account) => ({ ...account, username: String(account.username).replace(/^@/, '') }));
    records[row.decision].push({
      id: row.influencerId,
      name: String(record.Name || ''),
      accounts
    });
    decidedInfluencers.set(row.catalogId, records);
  }
  const assignedAccounts = new Map();
  for (const row of database.prepare(`SELECT ac.catalog_id AS catalogId,
      a.id AS accountId, a.client_name AS clientName, a.client_type AS clientType
    FROM client_account_catalogs ac
    JOIN client_accounts a ON a.id = ac.account_id
    ORDER BY a.client_name COLLATE NOCASE`).all()) {
    const assigned = assignedAccounts.get(row.catalogId) || [];
    assigned.push({ id: row.accountId, clientName: row.clientName, clientType: row.clientType });
    assignedAccounts.set(row.catalogId, assigned);
  }
  const catalogWorkVideos = new Map();
  for (const row of database.prepare(`SELECT cv.catalog_id AS catalogId, v.id, v.youtube_video_id AS videoId,
      v.video_url AS url, v.title, v.active
    FROM client_catalog_work_videos cv
    JOIN company_work_videos v ON v.id = cv.video_id
    ORDER BY cv.catalog_id, cv.position`).all()) {
    const videos = catalogWorkVideos.get(row.catalogId) || [];
    videos.push({ ...row, active: Boolean(row.active) });
    catalogWorkVideos.set(row.catalogId, videos);
  }
  return database.prepare(`
    SELECT c.id, c.client_name AS clientName, c.company_name AS companyName,
      c.brand_id AS brandId, c.brand_snapshot_json AS brandSnapshotJson,
      c.show_city AS showCity, c.show_category AS showCategory, c.show_details AS showDetails,
      c.show_company_work AS showCompanyWork,
      c.offer_name AS offerName, c.offer_status AS offerStatus,
      c.expires_at AS expiresAt,
      c.active, c.created_at AS createdAt, c.updated_at AS updatedAt,
      COUNT(ci.influencer_id) AS influencerCount,
      (SELECT COUNT(*) FROM client_catalog_access_events e WHERE e.catalog_id = c.id) AS accessCount,
      (SELECT MAX(e.accessed_at) FROM client_catalog_access_events e WHERE e.catalog_id = c.id) AS lastAccessedAt
    FROM client_catalogs c
    LEFT JOIN client_catalog_items ci ON ci.catalog_id = c.id
    GROUP BY c.id
    ORDER BY c.created_at DESC
  `).all().map((row) => {
    const outcome = outcomes.get(row.id) || { acceptedCount: 0, rejectedCount: 0 };
    const influencerCount = Number(row.influencerCount || 0);
    return {
      ...row,
      brand: getBrandSnapshot(row),
      active: Boolean(row.active),
      showCity: Boolean(row.showCity !== 0),
      showCategory: Boolean(row.showCategory !== 0),
      showDetails: Boolean(row.showDetails !== 0),
      showCompanyWork: Boolean(row.showCompanyWork),
      companyWorkVideos: catalogWorkVideos.get(row.id) || [],
      workVideoIds: (catalogWorkVideos.get(row.id) || []).map((video) => video.id),
      acceptedCount: outcome.acceptedCount,
      acceptedInfluencers: acceptedInfluencers.get(row.id) || [],
      rejectedCount: outcome.rejectedCount,
      acceptedInfluencerRecords: (decidedInfluencers.get(row.id) || { accepted: [], rejected: [] }).accepted,
      rejectedInfluencers: (decidedInfluencers.get(row.id) || { accepted: [], rejected: [] }).rejected,
      pendingCount: Math.max(influencerCount - outcome.acceptedCount - outcome.rejectedCount, 0),
      accounts: assignedAccounts.get(row.id) || []
    };
  });
}

function clientOfferPresentation(account) {
  const visibleFields = new Set(account.portalConfig?.fields?.requestApproval || []);
  const displayMode = displayModeFor(account);
  return database.prepare(`SELECT c.id, c.offer_name AS offerName, c.client_name AS clientName,
      c.company_name AS companyName, c.show_city AS showCity, c.show_category AS showCategory,
      c.show_details AS showDetails, c.offer_status AS offerStatus
    FROM client_account_catalogs ac
    JOIN client_catalogs c ON c.id = ac.catalog_id
    WHERE ac.account_id = ? AND c.active = 1 AND c.offer_status = 'published'
    ORDER BY c.updated_at DESC, c.created_at DESC`).all(account.id).map((catalog) => {
    const decisions = database.prepare(`SELECT d.influencer_id AS influencerId, d.decision,
        d.created_at AS updatedAt
      FROM client_catalog_decisions d
      JOIN client_catalog_items ci ON ci.catalog_id = d.catalog_id AND ci.influencer_id = d.influencer_id
      WHERE d.catalog_id = ?`).all(catalog.id);
    const decisionMap = new Map(decisions.map((row) => [row.influencerId, row]));
    const historyRows = database.prepare(`SELECT h.influencer_id AS influencerId,
        h.event_type AS eventType, h.previous_decision AS previousDecision,
        h.decision, h.actor_label AS actorLabel, a.username AS actorUsername,
        h.created_at AS createdAt
      FROM client_catalog_decision_history h
      LEFT JOIN client_accounts a ON a.id = h.client_account_id
      WHERE h.catalog_id = ?
      ORDER BY h.created_at, h.id`).all(catalog.id);
    const historyByInfluencer = new Map();
    for (const row of historyRows) {
      const entries = historyByInfluencer.get(row.influencerId) || [];
      entries.push({
        eventType: row.eventType,
        previousDecision: row.previousDecision || '',
        decision: row.decision || '',
        actor: row.actorUsername || row.actorLabel || 'العميل',
        createdAt: row.createdAt
      });
      historyByInfluencer.set(row.influencerId, entries);
    }
    const items = database.prepare(`SELECT i.id, i.record_json AS recordJson
      FROM client_catalog_items ci JOIN influencers i ON i.id = ci.influencer_id
      WHERE ci.catalog_id = ? ORDER BY ci.position, i.rowid DESC`).all(catalog.id);
    return {
      ...catalog,
      brand: getBrandSnapshot(catalog),
      showCity: Boolean(catalog.showCity),
      showCategory: Boolean(catalog.showCategory),
      showDetails: Boolean(catalog.showDetails),
      decisionsEnabled: displayMode === 'selecting',
      influencers: items.map(({ id, recordJson }) => {
        const record = JSON.parse(recordJson || '{}');
        const accountVisibility = catalogAccountVisibilityMap(catalog.id, id, record);
        const decision = decisionMap.get(id);
        const bestPlatform = String(record['Best Platform'] || '').trim().toLowerCase();
        const platformName = bestPlatform.includes('tik') ? 'TikTok'
          : bestPlatform.includes('snap') ? 'Snapchat'
            : bestPlatform.includes('insta') ? 'Instagram' : '';
        const platform = platformName && accountVisibility[platformName] === false ? '' : platformName;
        const followerField = platformName === 'TikTok' ? 'Followers Count T'
          : platformName === 'Snapchat' ? 'Followers Count S' : 'Followers Count I';
        const hiddenUsernames = Object.entries(catalogAccountFields)
          .filter(([name]) => accountVisibility[name] === false)
          .map(([, fields]) => String(record[fields.username] || '').replace(/^@/, '').trim().toLowerCase())
          .filter(Boolean);
        const visibleUsernames = Object.entries(catalogAccountFields)
          .filter(([name]) => accountVisibility[name] !== false)
          .map(([, fields]) => String(record[fields.username] || '').replace(/^@/, '').trim().toLowerCase())
          .filter(Boolean);
        const mainUsernameValue = primaryUsername(record);
        const normalizedMainUsername = mainUsernameValue.replace(/^@/, '').trim().toLowerCase();
        const mainUsername = hiddenUsernames.includes(normalizedMainUsername)
          && !visibleUsernames.includes(normalizedMainUsername) ? '' : mainUsernameValue;
        return {
          influencerId: id,
          name: String(record.Name || ''),
          ...(displayMode !== 'selecting' || visibleFields.has('platform') ? { platform } : {}),
          ...(displayMode !== 'existing' && visibleFields.has('username') ? { mainUsername } : {}),
          profiles: visitProfile(record).filter((profile) => accountVisibility[profile.platform] !== false),
          decision: displayMode === 'selecting' ? decision?.decision || 'pending' : 'pending',
          decisionUpdatedAt: displayMode === 'selecting' ? decision?.updatedAt || '' : '',
          history: displayMode === 'selecting' ? historyByInfluencer.get(id) || [] : [],
          ...(displayMode === 'selecting' && visibleFields.has('followers') && platform
            ? { followers: String(record[followerField] || '') } : {}),
          ...(visibleFields.has('accountLink') ? { accountLink: platform ? accountLinkForRecord(record) : '' } : {}),
          details: {}
        };
      })
    };
  });
}

function campaignSummaries() {
  const schedules = new Map();
  const coverageCounts = new Map(database.prepare(`SELECT campaign_id AS campaignId, COUNT(*) AS count
    FROM coverage_videos WHERE campaign_id IS NOT NULL GROUP BY campaign_id`).all()
    .map((row) => [row.campaignId, Number(row.count)]));
  for (const row of database.prepare(`
    SELECT campaign_id AS campaignId, scheduled_at AS scheduledAt
    FROM campaign_schedule
    ORDER BY campaign_id, position
  `).all()) {
    const entries = schedules.get(row.campaignId) || [];
    entries.push(row.scheduledAt);
    schedules.set(row.campaignId, entries);
  }
  const targets = new Map();
  for (const row of database.prepare(`
    SELECT ct.campaign_id AS campaignId, i.id,
      json_extract(i.record_json, '$.Name') AS name,
      json_extract(i.record_json, '$."Profile Image URL"') AS profileImage,
      json_extract(i.record_json, '$.Gender') AS gender,
      json_extract(i.record_json, '$.Main_Username') AS username,
      json_extract(i.record_json, '$.Influencer Status') AS influencerStatus,
      json_extract(i.record_json, '$.Note') AS note,
      json_extract(i.record_json, '$.Price') AS price,
      json_extract(i.record_json, '$.Best Platform') AS platformRaw,
      json_extract(i.record_json, '$.Followers Count I') AS followersInstagram,
      json_extract(i.record_json, '$.Followers Count T') AS followersTikTok,
      json_extract(i.record_json, '$.Followers Count S') AS followersSnapchat,
      json_extract(i.record_json, '$.City') AS influencerCity,
      ct.execution_type AS executionType, ct.visit_date AS visitDate, ct.shipping_status AS shippingStatus,
      ct.visit_time AS visitTime, ct.visit_city AS visitCity, ct.visit_branch AS visitBranch,
      ct.visit_address AS visitAddress, ct.visit_status AS visitStatus,
      ct.visit_notes AS visitNotes, ct.coverage_notes AS coverageNotes,
      ct.contact_status AS contactStatus, ct.participation_status AS participationStatus,
      ct.campaign_price AS campaignPrice, ct.operations_notes AS operationsNotes,
      ct.after_confirmation AS afterConfirmation,
      (SELECT n.note_text FROM campaign_influencer_notes n
        WHERE n.campaign_id = ct.campaign_id AND n.influencer_id = ct.influencer_id) AS campaignInfluencerNote,
      ct.delivery_recipient_name AS recipientName, ct.delivery_recipient_phone AS recipientPhone,
      ct.delivery_courier_contact AS courierContact, ct.delivery_city AS deliveryCity,
      ct.delivery_district AS deliveryDistrict, ct.delivery_address AS deliveryAddress,
      ct.delivery_map_link AS deliveryMapLink, ct.delivery_order_details AS orderDetails,
      ct.delivery_notes AS deliveryNotes,
      ct.visit_location AS visitLocation,
      ct.shipping_carrier AS shippingCarrier, ct.tracking_number AS trackingNumber,
      ct.delivery_date AS deliveryDate,
      ct.coverage_status AS coverageStatus,
      ct.visited_at AS visitedAt
    FROM campaign_targets ct
    JOIN influencers i ON i.id = ct.influencer_id
    ORDER BY ct.campaign_id, ct.position
  `).all()) {
    const entries = targets.get(row.campaignId) || [];
    entries.push({
      id: row.id,
      platform: String(row.platformRaw || ''),
      followers: String(String(row.platformRaw || '').toLowerCase().includes('tik') ? row.followersTikTok || ''
        : String(row.platformRaw || '').toLowerCase().includes('snap') ? row.followersSnapchat || '' : row.followersInstagram || ''),
      influencerCity: String(row.influencerCity || ''),
      executionType: row.executionType === 'delivery' ? 'delivery' : 'visit',
      name: String(row.name || 'اسم غير مسجل'),
      profileImage: String(row.profileImage || ''),
      placeholderImage: profilePlaceholderUrl({ Gender: row.gender }),
      username: String(row.username || ''),
      influencerStatus: row.influencerStatus === 'Inactive' ? 'Inactive' : 'Active',
      note: String(row.note || ''),
      price: String(row.price || ''),
      visitDate: row.visitDate || '',
      visitTime: row.visitTime || '',
      visitCity: row.visitCity || '',
      visitBranch: row.visitBranch || '',
      visitAddress: row.visitAddress || '',
      visitStatus: row.visitStatus || 'pending_confirmation',
      visitNotes: row.visitNotes || '',
      coverageNotes: row.coverageNotes || '',
      contactStatus: row.contactStatus || 'not_contacted',
      participationStatus: row.participationStatus || 'pending',
      campaignPrice: row.campaignPrice || '',
      operationsNotes: row.operationsNotes || '',
      afterConfirmation: row.afterConfirmation || '',
      campaignInfluencerNote: row.campaignInfluencerNote || '',
      visitLocation: row.visitLocation || '',
      shippingStatus: row.shippingStatus || 'not_shipped',
      recipientName: row.recipientName || '',
      recipientPhone: row.recipientPhone || '',
      courierContact: row.courierContact || '',
      deliveryCity: row.deliveryCity || '',
      deliveryDistrict: row.deliveryDistrict || '',
      deliveryAddress: row.deliveryAddress || '',
      deliveryMapLink: row.deliveryMapLink || '',
      orderDetails: row.orderDetails || '',
      deliveryNotes: row.deliveryNotes || '',
      shippingCarrier: row.shippingCarrier || '',
      trackingNumber: row.trackingNumber || '',
      deliveryDate: row.deliveryDate || '',
      coverageStatus: row.coverageStatus || 'pending',
      visitedAt: row.visitedAt || ''
    });
    targets.set(row.campaignId, entries);
  }
  return database.prepare(`
    SELECT id, campaign_name AS campaignName, company_name AS companyName,
      campaign_type AS legacyCampaignType, execution_mode AS campaignType,
      execution_mode AS executionMode, qr_enabled AS qrEnabled, service_type AS serviceType,
      field_visibility AS fieldVisibility,
      start_date AS startDate, end_date AS endDate,
      created_at AS createdAt, updated_at AS updatedAt
    FROM campaigns
    ORDER BY updated_at DESC, created_at DESC
  `).all().map((campaign) => ({
    ...campaign,
    qrEnabled: Boolean(campaign.qrEnabled),
    fieldVisibility: normalizeCampaignVisibility(campaign.fieldVisibility, campaign.campaignType),
    schedules: schedules.get(campaign.id) || [],
    targets: targets.get(campaign.id) || [],
    coverageCount: coverageCounts.get(campaign.id) || 0,
    coverageCompleted: (targets.get(campaign.id) || []).filter((target) => target.coverageStatus === 'completed').length,
    coveragePending: (targets.get(campaign.id) || []).filter((target) => target.coverageStatus === 'pending').length,
    coverageNotCompleted: (targets.get(campaign.id) || []).filter((target) => target.coverageStatus === 'not_completed').length
  }));
}

function normalizeCampaignVisibility(value, campaignType) {
  let input = value;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = {}; }
  }
  if (campaignType === 'mix') {
    return {
      ...normalizeCampaignVisibility(input, 'visit'),
      ...normalizeCampaignVisibility(input, 'delivery')
    };
  }
  const allowed = campaignType === 'visit' ? visitFieldKeys : deliveryFieldKeys;
  const configured = input && typeof input === 'object' && !Array.isArray(input) ? input[campaignType] : null;
  return {
    [campaignType]: Object.fromEntries(allowed.map((field) => [
      field,
      configured && typeof configured[field] === 'boolean' ? configured[field] : defaultCampaignVisibility[campaignType][field]
    ]))
  };
}

function validateCampaignVisibility(value, campaignType, fallback) {
  if (value === undefined) return fallback || structuredClone(defaultCampaignVisibility);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('إعدادات ظهور الحقول غير صالحة.'), { status: 400 });
  }
  const keys = campaignType === 'visit' ? visitFieldKeys : deliveryFieldKeys;
  const scoped = value[campaignType] && typeof value[campaignType] === 'object' ? value[campaignType] : value;
  const result = { [campaignType]: {} };
  for (const key of keys) {
    const visible = scoped[key] ?? fallback?.[campaignType]?.[key] ?? true;
    if (typeof visible !== 'boolean') throw Object.assign(new Error(`إعداد ظهور الحقل ${key} غير صالح.`), { status: 400 });
    result[campaignType][key] = visible;
  }
  return result;
}

function recordClientActivity(accountId, actor, eventType, details = {}) {
  database.prepare(`INSERT INTO client_account_activity
    (id, account_id, actor_user_id, actor_username, event_type, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(randomBytes(16).toString('hex'), accountId, actor?.id || null, actor?.username || '',
      eventType, JSON.stringify(details), new Date().toISOString());
}

function clientAccountSummaries() {
  const rows = database.prepare(`SELECT a.id, a.username, a.client_name AS clientName,
      a.email, a.company_name AS companyName, a.internal_notes AS internalNotes,
      a.active, a.portal_config AS portalConfig,
      a.portal_status AS portalStatus, a.client_type AS clientType, a.display_mode AS displayMode,
      a.created_at AS createdAt,
      a.updated_at AS updatedAt, COUNT(ac.campaign_id) AS campaignCount
    FROM client_accounts a
    LEFT JOIN client_account_campaigns ac ON ac.account_id = a.id
    GROUP BY a.id ORDER BY a.created_at DESC`).all();
  const campaigns = new Map();
  for (const row of database.prepare(`SELECT ac.account_id AS accountId, c.id,
    c.campaign_name AS campaignName, c.execution_mode AS campaignType
    FROM client_account_campaigns ac JOIN campaigns c ON c.id = ac.campaign_id
    ORDER BY c.updated_at DESC`).all()) {
    const list = campaigns.get(row.accountId) || [];
    list.push({ id: row.id, campaignName: row.campaignName, campaignType: row.campaignType });
    campaigns.set(row.accountId, list);
  }
  const catalogs = new Map();
  for (const row of database.prepare(`SELECT ac.account_id AS accountId, c.id,
      c.offer_name AS offerName, c.company_name AS companyName,
      c.offer_status AS offerStatus
    FROM client_account_catalogs ac
    JOIN client_catalogs c ON c.id = ac.catalog_id
    ORDER BY c.updated_at DESC, c.created_at DESC`).all()) {
    const list = catalogs.get(row.accountId) || [];
    list.push({ id: row.id, offerName: row.offerName, companyName: row.companyName, offerStatus: row.offerStatus });
    catalogs.set(row.accountId, list);
  }
  return rows.map((row) => ({
    ...row,
    active: Boolean(row.active),
    portalConfig: validatePortalConfig(row.portalConfig, defaultPortalConfig('request-approval', row.portalStatus)),
    portalStatus: row.portalStatus,
    clientType: row.clientType === 'prospective' ? 'prospective' : 'current',
    displayMode: clientDisplayModes.has(row.displayMode) ? row.displayMode
      : row.clientType === 'prospective' ? 'prospective' : 'selecting',
    campaignCount: Number(row.campaignCount || 0),
    campaigns: campaigns.get(row.id) || [],
    offers: catalogs.get(row.id) || [],
    lastActivityAt: database.prepare(`SELECT MAX(created_at) AS activityAt FROM (
      SELECT h.created_at FROM client_catalog_decision_history h
      JOIN client_account_catalogs ac ON ac.catalog_id = h.catalog_id WHERE ac.account_id = ?
      UNION ALL
      SELECT created_at FROM client_decision_history WHERE client_account_id = ?
      UNION ALL
      SELECT created_at FROM client_campaign_actions WHERE client_account_id = ?
      UNION ALL
      SELECT created_at FROM client_account_activity WHERE account_id = ?
    )`).get(row.id, row.id, row.id, row.id).activityAt || row.updatedAt,
    decisionHistoryCount: Number(database.prepare(`SELECT
      (SELECT COUNT(*) FROM client_catalog_decision_history WHERE client_account_id = ?) +
      (SELECT COUNT(*) FROM client_decision_history WHERE client_account_id = ?) AS count`).get(row.id, row.id).count || 0)
  }));
}

function publishedClientVisitSchedule(accountId) {
  const schedule = database.prepare(`SELECT id FROM client_visit_schedules
    WHERE client_account_id = ? AND status = 'published'`).get(accountId);
  if (!schedule) return null;
  const rows = database.prepare(`SELECT v.visit_date AS visitDate, v.visit_time AS visitTime,
      v.city, v.branch, i.record_json AS recordJson
    FROM client_visits v JOIN influencers i ON i.id = v.influencer_id
    WHERE v.schedule_id = ? ORDER BY v.visit_date, v.visit_time, v.id`).all(schedule.id);
  return {
    visits: rows.map((row) => {
      const record = JSON.parse(row.recordJson || '{}');
      const profiles = visitProfile(record);
      return {
        name: String(record.Name || ''),
        profiles,
        visitDate: row.visitDate,
        visitTime: row.visitTime,
        city: row.city,
        branch: row.branch
      };
    })
  };
}

function existingClientInfluencers(accountId) {
  const rows = database.prepare(`SELECT DISTINCT i.id, i.record_json AS recordJson
    FROM influencers i
    WHERE i.id IN (
      SELECT ci.influencer_id FROM client_account_catalogs ac
      JOIN client_catalog_items ci ON ci.catalog_id = ac.catalog_id
      JOIN client_catalogs c ON c.id = ac.catalog_id AND c.active = 1 AND c.offer_status = 'published'
      WHERE ac.account_id = ?
      UNION
      SELECT ct.influencer_id FROM client_account_campaigns ac
      JOIN campaign_targets ct ON ct.campaign_id = ac.campaign_id
      WHERE ac.account_id = ?
    )
    ORDER BY json_extract(i.record_json, '$.Name') COLLATE NOCASE`).all(accountId, accountId);
  return rows.map((row) => {
    const record = JSON.parse(row.recordJson || '{}');
    return { name: String(record.Name || ''), profiles: visitProfile(record) };
  });
}

function internalClientVisitSchedule(accountId) {
  const schedule = database.prepare(`SELECT id, status, created_at AS createdAt,
      updated_at AS updatedAt, published_at AS publishedAt
    FROM client_visit_schedules WHERE client_account_id = ?`).get(accountId);
  if (!schedule) return { schedule: null, visits: [] };
  const visits = database.prepare(`SELECT v.id, v.influencer_id AS influencerId,
      v.visit_date AS visitDate, v.visit_time AS visitTime, v.city, v.branch,
      i.record_json AS recordJson
    FROM client_visits v JOIN influencers i ON i.id = v.influencer_id
    WHERE v.schedule_id = ? ORDER BY v.visit_date, v.visit_time, v.id`).all(schedule.id)
    .map((visit) => {
      const record = JSON.parse(visit.recordJson || '{}');
      return {
        id: visit.id, influencerId: visit.influencerId,
        name: String(record.Name || ''),
        profiles: visitProfile(record),
        visitDate: visit.visitDate, visitTime: visit.visitTime,
        city: visit.city, branch: visit.branch
      };
    });
  return { schedule, visits };
}

function ensureClientVisitSchedule(accountId) {
  let schedule = database.prepare('SELECT id, status FROM client_visit_schedules WHERE client_account_id = ?').get(accountId);
  if (!schedule) {
    const now = new Date().toISOString();
    const id = randomBytes(16).toString('hex');
    database.prepare(`INSERT INTO client_visit_schedules
      (id, client_account_id, status, created_at, updated_at) VALUES (?, ?, 'draft', ?, ?)`)
      .run(id, accountId, now, now);
    schedule = { id, status: 'draft' };
  }
  return schedule;
}

function validateClientVisitPayload(body) {
  const influencerId = String(body.influencerId || '');
  const visitDate = String(body.visitDate || '');
  const visitTime = parseImportTime(body.visitTime);
  const city = String(body.city || '').trim();
  const branch = String(body.branch || '').trim();
  if (!/^[a-f0-9]{32}$/i.test(influencerId)
    || parseImportDate(visitDate) !== visitDate
    || !visitTime || visitTime !== String(body.visitTime || '').trim()
    || city.length > 100 || branch.length > 150) {
    throw Object.assign(new Error('يلزم اختيار مؤثر موجود وتاريخ ووقت صالحين؛ المدينة والفرع اختياريان.'), { status: 400 });
  }
  if (!database.prepare('SELECT 1 FROM influencers WHERE id = ?').get(influencerId)) {
    throw Object.assign(new Error('المؤثر المحدد غير موجود في قاعدة البيانات.'), { status: 400 });
  }
  return { influencerId, visitDate, visitTime, city, branch };
}

function clientPortalBrand(account) {
  const brands = database.prepare(`SELECT c.brand_id AS brandId,
      c.brand_snapshot_json AS brandSnapshotJson, c.updated_at AS updatedAt
    FROM client_account_catalogs ac
    JOIN client_catalogs c ON c.id = ac.catalog_id
    WHERE ac.account_id = ? AND c.active = 1 AND c.offer_status = 'published'
    UNION ALL
    SELECT p.brand_id AS brandId, p.brand_snapshot_json AS brandSnapshotJson,
      c.updated_at AS updatedAt
    FROM campaign_presentations p
    JOIN campaigns c ON c.id = p.campaign_id
    WHERE p.client_account_id = ? AND p.active = 1
    ORDER BY updatedAt DESC`).all(account.id, account.id);
  const brandIds = new Set(brands.map((row) => row.brandId || 'fkretk'));
  if (brandIds.size > 1) return {
    id: 'neutral', nameAr: 'بوابة العميل', nameEn: 'Client Portal',
    primaryColor: '#627269', secondaryColor: '#FFFFFF', accentColor: '#627269',
    logoPath: '', logoMode: 'text-placeholder', contactEmail: ''
  };
  if (!brands.length) return defaultBrandSettings.fkretk;
  return getBrandSnapshot(brands[0]);
}

function clientCampaignPresentation(account, { preview = false } = {}) {
  const portalConfig = account.portalConfig
    ? validatePortalConfig(account.portalConfig, defaultPortalConfig('request-approval', account.portalStatus))
    : defaultPortalConfig();
  if (portalConfig.status !== 'published' && !preview) {
    throw Object.assign(new Error('بوابة العميل غير منشورة بعد.'), { status: 403 });
  }
  const campaigns = database.prepare(`SELECT c.id, c.campaign_name AS campaignName,
      c.company_name AS companyName, c.execution_mode AS campaignType,
      c.execution_mode AS executionMode,
      c.service_type AS serviceType, c.start_date AS startDate, c.end_date AS endDate
    FROM client_account_campaigns ac
    JOIN campaigns c ON c.id = ac.campaign_id
    WHERE ac.account_id = ? ORDER BY c.updated_at DESC, c.created_at DESC`).all(account.id);
  const displayMode = displayModeFor(account);
  const visitSchedule = displayMode === 'existing'
    ? publishedClientVisitSchedule(account.id)
    : null;
  return {
    brand: clientPortalBrand(account),
    client: {
      clientName: account.clientName,
      companyName: account.companyName,
      clientType: displayMode === 'prospective' ? 'prospective' : 'current',
      displayMode
    },
    portal: {
      template: portalConfig.template,
      status: portalConfig.status,
      sections: displayMode === 'selecting'
        ? portalConfig.sections.filter((section) => section !== 'visitSchedule')
        : displayMode === 'prospective' ? ['requestApproval'] : [],
      fields: portalConfig.fields,
      actions: displayMode === 'selecting'
        ? { ...portalConfig.actions, allowDecisions: true, allowRevert: true,
          allowVisitConfirmation: false, allowVisitChangeRequest: false, allowShippingFollowUp: false }
        : { ...portalConfig.actions, allowDecisions: false, allowRevert: false,
          allowVisitConfirmation: false, allowVisitChangeRequest: false, allowShippingFollowUp: false }
    },
    offers: displayMode === 'existing' ? [] : clientOfferPresentation(account),
    clientInfluencers: displayMode === 'existing' ? existingClientInfluencers(account.id) : [],
    visits: visitSchedule,
    campaigns: displayMode !== 'selecting' ? [] : campaigns.map((campaign) => {
      const targets = database.prepare(`SELECT i.id AS influencerId,
          i.record_json AS recordJson,
          ct.execution_type AS executionType,
          ct.visit_date AS visitDate, ct.visit_time AS visitTime,
          ct.visit_city AS visitCity, ct.visit_branch AS visitBranch,
          ct.visit_address AS visitAddress, ct.visit_status AS visitStatus,
          ct.visit_notes AS visitNotes, ct.coverage_notes AS coverageNotes,
          ct.visit_location AS visitLocation, ct.shipping_status AS shippingStatus,
          ct.delivery_recipient_name AS recipientName,
          ct.delivery_recipient_phone AS recipientPhone,
          ct.delivery_courier_contact AS courierContact,
          ct.delivery_city AS deliveryCity, ct.delivery_district AS deliveryDistrict,
          ct.delivery_address AS deliveryAddress, ct.delivery_map_link AS deliveryMapLink,
          ct.delivery_order_details AS orderDetails, ct.delivery_notes AS deliveryNotes,
          ct.shipping_carrier AS shippingCarrier, ct.tracking_number AS trackingNumber,
          ct.delivery_date AS deliveryDate, ct.coverage_status AS coverageStatus,
          ct.visited_at AS visitedAt, d.decision
        FROM campaign_targets ct
        JOIN influencers i ON i.id = ct.influencer_id
        LEFT JOIN campaign_target_decisions d
          ON d.campaign_id = ct.campaign_id AND d.influencer_id = ct.influencer_id
          AND d.client_account_id = ?
        WHERE ct.campaign_id = ? ORDER BY ct.position`).all(account.id, campaign.id);
      const executionTypes = new Set(targets.map((target) => target.executionType === 'delivery' ? 'delivery' : 'visit'));
      const historyRows = database.prepare(`SELECT h.influencer_id AS influencerId,
          h.event_type AS eventType, h.previous_decision AS previousDecision,
          h.decision, h.created_at AS createdAt, a.username AS actorUsername
        FROM client_decision_history h
        LEFT JOIN client_accounts a ON a.id = h.client_account_id
        WHERE h.client_account_id = ? AND h.campaign_id = ?
        ORDER BY h.created_at, h.id`).all(account.id, campaign.id);
      const history = new Map();
      for (const entry of historyRows) {
        const entries = history.get(entry.influencerId) || [];
        entries.push({
          eventType: entry.eventType,
          previousDecision: entry.previousDecision || '',
          decision: entry.decision || '',
          actorUsername: entry.actorUsername || '',
          createdAt: entry.createdAt
        });
        history.set(entry.influencerId, entries);
      }
      const actionRows = database.prepare(`SELECT influencer_id AS influencerId,
          action_type AS actionType, details, created_at AS createdAt
        FROM client_campaign_actions
        WHERE client_account_id = ? AND campaign_id = ?
        ORDER BY created_at, id`).all(account.id, campaign.id);
      const actionHistory = new Map();
      for (const entry of actionRows) {
        const entries = actionHistory.get(entry.influencerId) || [];
        entries.push({ actionType: entry.actionType, details: entry.details, createdAt: entry.createdAt });
        actionHistory.set(entry.influencerId, entries);
      }
      const activeSections = portalConfig.sections;
      const showRequest = activeSections.includes('requestApproval');
      const showReport = activeSections.includes('campaignReport');
      const presentedTargets = targets.map((target) => {
        const executionType = target.executionType === 'delivery' ? 'delivery' : 'visit';
        const sectionKey = executionType === 'visit' ? 'visitSchedule' : 'deliveryCampaign';
        const campaignFields = portalConfig.fields[sectionKey] || [];
        const showCampaignDetails = activeSections.includes(sectionKey) && sectionKey !== 'visitSchedule';
        const record = JSON.parse(target.recordJson || '{}');
        const bestPlatform = String(record['Best Platform'] || '');
        const isTikTok = /tik/i.test(bestPlatform);
        const isSnapchat = /snap/i.test(bestPlatform);
        const isInstagram = /insta/i.test(bestPlatform);
        const handle = String(record.Main_Username || '').replace(/^@/, '');
        const accountHandle = String(isTikTok ? record['Username T'] : isSnapchat ? record.Username : isInstagram ? record['Username I'] : '').replace(/^@/, '');
        const followerField = isTikTok ? 'Followers Count T' : isSnapchat ? 'Followers Count S' : 'Followers Count I';
        const profile = {};
        if (showRequest) {
          for (const field of portalConfig.fields.requestApproval) {
            if (field === 'name') profile.name = String(record.Name || '');
            else if (field === 'username') profile.username = handle;
            else if (field === 'platform') profile.platform = bestPlatform;
            else if (field === 'accountLink' && accountHandle) {
              const host = isTikTok ? 'www.tiktok.com/@' : isSnapchat ? 'www.snapchat.com/add/' : 'www.instagram.com/';
              profile.accountLink = `https://${host}${encodeURIComponent(accountHandle)}`;
            } else if (field === 'followers') profile.followers = String(record[followerField] || '');
            // Never expose internal costs or notes through the client portal.
          }
        }
        const presented = {
          influencerId: target.influencerId,
          executionType,
          decision: target.decision || 'pending',
          history: history.get(target.influencerId) || [],
          clientActions: actionHistory.get(target.influencerId) || []
        };
        if (showRequest) presented.profile = profile;
        if (showCampaignDetails) {
          for (const field of campaignFields) {
            if (field === 'name') presented.name = String(record.Name || '');
            else if (field === 'username') presented.username = handle;
            else if (field === 'visitDate') presented.visitDate = target.visitDate || '';
            else if (field === 'visitTime') presented.visitTime = target.visitTime || '';
            else if (field === 'visitCity') presented.visitCity = target.visitCity || '';
            else if (field === 'visitBranch') presented.visitBranch = target.visitBranch || '';
            else if (field === 'visitAddress') presented.visitAddress = target.visitAddress || target.visitLocation || '';
            else if (field === 'visitStatus') presented.visitStatus = target.visitStatus || 'pending_confirmation';
            else if (field === 'visitNotes') presented.visitNotes = target.visitNotes || '';
            else if (field === 'coverageStatus') presented.coverageStatus = target.coverageStatus || 'pending';
            else if (field === 'coverageNotes') presented.coverageNotes = target.coverageNotes || '';
            else if (field === 'recipientName') presented.recipientName = target.recipientName || '';
            else if (field === 'recipientPhone') presented.recipientPhone = target.recipientPhone || '';
            else if (field === 'courierContact') presented.courierContact = target.courierContact || '';
            else if (field === 'deliveryCity') presented.deliveryCity = target.deliveryCity || '';
            else if (field === 'deliveryDistrict') presented.deliveryDistrict = target.deliveryDistrict || '';
            else if (field === 'deliveryAddress') presented.deliveryAddress = target.deliveryAddress || '';
            else if (field === 'deliveryMapLink') presented.deliveryMapLink = target.deliveryMapLink || '';
            else if (field === 'orderDetails') presented.orderDetails = target.orderDetails || '';
            else if (field === 'deliveryNotes') presented.deliveryNotes = target.deliveryNotes || '';
            else if (field === 'shippingStatus') presented.shippingStatus = target.shippingStatus || 'pending_preparation';
            else if (field === 'shippingCarrier') presented.shippingCarrier = target.shippingCarrier || '';
            else if (field === 'trackingNumber') presented.trackingNumber = target.trackingNumber || '';
            else if (field === 'deliveryDate') presented.deliveryDate = target.deliveryDate || '';
          }
        }
        if (showReport) {
          const reportFields = portalConfig.fields.campaignReport;
          presented.report = {};
          if (reportFields.includes('campaignSummary')) presented.report.campaignSummary = `${campaign.campaignName} · ${campaign.startDate} – ${campaign.endDate}`;
          if (reportFields.includes('targetCount')) presented.report.targetCount = targets.length;
          if (reportFields.includes('coverageSummary')) presented.report.coverageSummary = {
            completed: targets.filter((row) => row.coverageStatus === 'completed').length,
            pending: targets.filter((row) => row.coverageStatus === 'pending').length,
            notCompleted: targets.filter((row) => row.coverageStatus === 'not_completed').length
          };
          if (reportFields.includes('deliverySummary') && executionTypes.has('delivery')) presented.report.deliverySummary = {
            pendingPreparation: targets.filter((row) => row.executionType === 'delivery' && ['not_shipped', 'pending_preparation'].includes(row.shippingStatus)).length,
            ready: targets.filter((row) => row.executionType === 'delivery' && row.shippingStatus === 'ready').length,
            shipped: targets.filter((row) => row.executionType === 'delivery' && ['in_progress', 'shipped'].includes(row.shippingStatus)).length,
            delivered: targets.filter((row) => row.executionType === 'delivery' && row.shippingStatus === 'delivered').length,
            failed: targets.filter((row) => row.executionType === 'delivery' && row.shippingStatus === 'failed').length
          };
        }
        return presented;
      });
      return {
        ...campaign,
        sections: activeSections.filter((section) => {
          if (section === 'visitSchedule') return false;
          if (section === 'deliveryCampaign') return executionTypes.has('delivery');
          return true;
        }),
        actions: portalConfig.actions,
        targets: presentedTargets
      };
    })
  };
}

function normalizeCampaignTargets(body, campaignType, startDate, endDate) {
  const rawTargets = Array.isArray(body.targets) ? body.targets : [];
  const targetIds = Array.isArray(body.targetIds) ? body.targetIds : rawTargets.map((target) => target?.id);
  const ids = [...new Set(targetIds.filter((id) => typeof id === 'string'))];
  if (!ids.length) throw Object.assign(new Error('حدد مؤثرًا واحدًا على الأقل في قائمة الكامبين.'), { status: 400 });
  const detailsById = new Map(rawTargets.filter((target) => target && typeof target.id === 'string').map((target) => [target.id, target]));
  const targets = ids.map((id) => {
    const detail = detailsById.get(id) || {};
    const executionType = campaignType === 'mix' ? String(detail.executionType || 'visit') : campaignType;
    if (!['visit', 'delivery'].includes(executionType)) {
      throw Object.assign(new Error('اختر زيارة أو توصيلًا لكل مؤثر في الحملة المختلطة.'), { status: 400 });
    }
    const visitDate = String(detail.visitDate || startDate).trim();
    const visitTime = String(detail.visitTime || '').trim();
    const visitCity = String(detail.visitCity || '').trim();
    const visitBranch = String(detail.visitBranch || '').trim();
    const visitLocation = String(detail.visitLocation || '').trim();
    const visitAddress = String(detail.visitAddress || '').trim();
    const visitStatus = String(detail.visitStatus || 'pending_confirmation');
    const visitNotes = String(detail.visitNotes || '').trim();
    const coverageNotes = String(detail.coverageNotes || '').trim();
    const shippingAliases = { not_shipped: 'pending_preparation', in_progress: 'shipped' };
    const shippingStatus = shippingAliases[String(detail.shippingStatus || 'pending_preparation')] || String(detail.shippingStatus || 'pending_preparation');
    const recipientName = String(detail.recipientName || '').trim().replace(/\s+/g, ' ');
    const recipientPhone = String(detail.recipientPhone || '').trim();
    const courierContact = String(detail.courierContact || '').trim();
    const deliveryCity = String(detail.deliveryCity || '').trim();
    const deliveryDistrict = String(detail.deliveryDistrict || '').trim();
    const deliveryAddress = String(detail.deliveryAddress || '').trim();
    const deliveryMapLink = String(detail.deliveryMapLink || '').trim();
    const orderDetails = String(detail.orderDetails || '').trim();
    const deliveryNotes = String(detail.deliveryNotes || '').trim();
    const shippingCarrier = String(detail.shippingCarrier || '').trim();
    const trackingNumber = String(detail.trackingNumber || '').trim();
    const deliveryDate = String(detail.deliveryDate || '').trim();
    const coverageStatus = String(detail.coverageStatus || 'pending');
    if (!shippingStatuses.has(shippingStatus)) throw Object.assign(new Error('حالة الشحن غير صالحة.'), { status: 400 });
    if (!visitStatuses.has(visitStatus)) throw Object.assign(new Error('حالة الزيارة غير صالحة.'), { status: 400 });
    if (!['pending', 'completed', 'not_completed'].includes(coverageStatus)) throw Object.assign(new Error('حالة التغطية غير صالحة.'), { status: 400 });
    if (visitTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(visitTime)) throw Object.assign(new Error('وقت الزيارة غير صالح.'), { status: 400 });
    if (executionType === 'delivery' && recipientName.split(' ').filter(Boolean).length < 2) throw Object.assign(new Error('اسم المستلم مطلوب ويتكون من اسمين على الأقل.'), { status: 400 });
    if (executionType === 'delivery' && recipientPhone && normalizePhoneDigits(recipientPhone).length < 7) throw Object.assign(new Error('رقم هاتف المستلم غير صالح.'), { status: 400 });
    const lengths = [
      [visitCity,100], [visitBranch,150], [visitLocation,500], [visitAddress,500], [visitNotes,2000], [coverageNotes,2000],
      [recipientName,150], [recipientPhone,40], [courierContact,150], [deliveryCity,100],
      [deliveryDistrict,120], [deliveryAddress,500], [deliveryMapLink,1000], [orderDetails,2000],
      [deliveryNotes,2000], [shippingCarrier,100], [trackingNumber,150]
    ];
    if (lengths.some(([value, max]) => value.length > max)) throw Object.assign(new Error('أحد تفاصيل الزيارة أو التوصيل يتجاوز الحد المسموح.'), { status: 400 });
    if (deliveryMapLink) {
      let mapUrl;
      try { mapUrl = new URL(deliveryMapLink); } catch {}
      if (!mapUrl || !['http:', 'https:'].includes(mapUrl.protocol)) throw Object.assign(new Error('رابط الموقع يجب أن يبدأ بـ HTTPS أو HTTP.'), { status: 400 });
    }
    if (executionType === 'visit') {
      const visitTimestamp = Date.parse(`${visitDate}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(visitDate) || visitDate < startDate || visitDate > endDate || !Number.isFinite(visitTimestamp) || new Date(visitTimestamp).toISOString().slice(0, 10) !== visitDate) {
        throw Object.assign(new Error('حدد تاريخ زيارة صحيحًا لكل مؤثر داخل فترة الحملة.'), { status: 400 });
      }
    } else if (deliveryDate) {
      const deliveryTimestamp = Date.parse(`${deliveryDate}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) || !Number.isFinite(deliveryTimestamp) || new Date(deliveryTimestamp).toISOString().slice(0, 10) !== deliveryDate) {
        throw Object.assign(new Error('تاريخ التوصيل غير صالح.'), { status: 400 });
      }
    }
    return {
      id,
      executionType,
      visitDate: executionType === 'visit' ? visitDate : '',
      visitTime: executionType === 'visit' ? visitTime : '',
      visitCity: executionType === 'visit' ? visitCity : '',
      visitBranch: executionType === 'visit' ? visitBranch : '',
      visitLocation: executionType === 'visit' ? visitLocation : '',
      visitAddress: executionType === 'visit' ? visitAddress : '',
      visitStatus: executionType === 'visit' ? visitStatus : '',
      visitNotes: executionType === 'visit' ? visitNotes : '',
      coverageNotes,
      shippingStatus: executionType === 'delivery' ? shippingStatus : '',
      recipientName: executionType === 'delivery' ? recipientName : '',
      recipientPhone: executionType === 'delivery' ? recipientPhone : '',
      courierContact: executionType === 'delivery' ? courierContact : '',
      deliveryCity: executionType === 'delivery' ? deliveryCity : '',
      deliveryDistrict: executionType === 'delivery' ? deliveryDistrict : '',
      deliveryAddress: executionType === 'delivery' ? deliveryAddress : '',
      deliveryMapLink: executionType === 'delivery' ? deliveryMapLink : '',
      orderDetails: executionType === 'delivery' ? orderDetails : '',
      deliveryNotes: executionType === 'delivery' ? deliveryNotes : '',
      shippingCarrier: executionType === 'delivery' ? shippingCarrier : '',
      trackingNumber: executionType === 'delivery' ? trackingNumber : '',
      deliveryDate: executionType === 'delivery' ? deliveryDate : '',
      coverageStatus
    };
  });
  return targets;
}

function validateCampaignDetails(body) {
  const campaignName = String(body.campaignName || '').trim();
  const companyName = String(body.companyName || '').trim();
  const campaignType = String(body.campaignType || '').trim();
  const serviceType = String(body.serviceType || 'influencer').trim();
  let startDate = String(body.startDate || '').trim();
  let endDate = String(body.endDate || '').trim();
  const schedules = Array.isArray(body.schedules) ? body.schedules : [];
  const normalizedSchedules = schedules.map((value) => {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
    return new Date(value).toISOString();
  });
  if (schedules.length > 100 || normalizedSchedules.includes(null)) {
    throw Object.assign(new Error('توجد مواعيد غير صالحة أو أكثر من 100 موعد.'), { status: 400 });
  }
  if ((!startDate || !endDate) && normalizedSchedules.length && !normalizedSchedules.includes(null)) {
    const days = normalizedSchedules.map((value) => value.slice(0, 10)).sort();
    startDate ||= days[0];
    endDate ||= days.at(-1);
  }
  if (!campaignName || campaignName.length > 150 || !companyName || companyName.length > 150) {
    throw Object.assign(new Error('أدخل اسم الكامبين واسم الشركة (بحد أقصى 150 حرفًا لكل منهما).'), { status: 400 });
  }
  if (!['visit', 'delivery', 'mix'].includes(campaignType)) throw Object.assign(new Error('اختر نوع التنفيذ: زيارة أو توصيل أو ميكس.'), { status: 400 });
  if (!['ugc', 'influencer', 'mix'].includes(serviceType)) throw Object.assign(new Error('اختر نوع الخدمة: UGC أو مؤثر أو مزيج.'), { status: 400 });
  const validDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const timestamp = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
  };
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
    throw Object.assign(new Error('أدخل تاريخ بداية ونهاية صحيحين للحملة.'), { status: 400 });
  }
  const fieldVisibility = campaignType === 'mix'
    ? {
      ...validateCampaignVisibility(body.fieldVisibility, 'visit'),
      ...validateCampaignVisibility(body.fieldVisibility, 'delivery')
    }
    : validateCampaignVisibility(body.fieldVisibility, campaignType);
  const qrEnabled = body.qrEnabled === undefined ? false : asBoolean(body.qrEnabled, null);
  if (qrEnabled === null) throw Object.assign(new Error('إعداد رمز QR غير صالح.'), { status: 400 });
  return {
    campaignName, companyName, campaignType,
    storedCampaignType: campaignType === 'delivery' ? 'delivery' : 'visit',
    serviceType, startDate, endDate, schedules: normalizedSchedules, fieldVisibility, qrEnabled
  };
}

function saveInfluencer(id, record) {
  const existing = database.prepare('SELECT record_json FROM influencers WHERE id = ?').get(id);
  const fallback = existing ? JSON.parse(existing.record_json || '{}') : null;
  if (!existing) {
    const accountConflict = findChangedSocialAccountConflict(record);
    if (accountConflict) {
      throw Object.assign(new Error(
        `حساب ${accountConflict.platform} مرتبط بالفعل بالمؤثر: ${accountConflict.influencerNames.join('، ') || accountConflict.influencerIds.join('، ')}؛ لم يتم تغيير الملكية.`
      ), { status: 409 });
    }
  }
  deriveMainAccountFields(record, fallback);
  const phoneKey = normalizePhone(record);
  database.prepare(`
    INSERT INTO influencers (id, record_json, phone_key) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json, phone_key = excluded.phone_key
  `).run(id, JSON.stringify(record), phoneKey);
  return { ...record, id };
}

function platformAccountKey(record, field) {
  const value = record?.[field.username]
    || field.aliases.map((alias) => record?.[alias]).find((item) => String(item || '').trim());
  const username = normalizedImportUsername(value);
  return username ? `${field.platform}\0${username}` : '';
}

function findChangedSocialAccountConflict(record, excludedId = '', previousRecord = null) {
  const previousKeys = new Set(previousRecord
    ? influencerImportAccountFields.map((field) => platformAccountKey(previousRecord, field)).filter(Boolean)
    : []);
  const requested = new Map();
  for (const field of influencerImportAccountFields) {
    const key = platformAccountKey(record, field);
    if (key && !previousKeys.has(key)) requested.set(key, field.platform);
  }
  if (!requested.size) return null;

  const conflicts = new Map();
  const existingRecords = database.prepare('SELECT id, record_json FROM influencers WHERE id != ?').all(excludedId);
  for (const row of existingRecords) {
    const existing = JSON.parse(row.record_json || '{}');
    for (const field of influencerImportAccountFields) {
      const candidates = [existing[field.username], ...field.aliases.map((alias) => existing[alias])];
      for (const candidate of candidates) {
        const handle = normalizedImportUsername(candidate);
        if (!handle) continue;
        const key = `${field.platform}\0${handle}`;
        if (!requested.has(key)) continue;
        const owners = conflicts.get(key) || new Map();
        owners.set(row.id, String(existing.Name || '').trim());
        conflicts.set(key, owners);
      }
    }
  }
  const conflict = [...conflicts].find(([, owners]) => owners.size);
  return conflict
    ? {
      platform: requested.get(conflict[0]),
      influencerIds: [...conflict[1].keys()],
      influencerNames: [...new Set([...conflict[1].values()].filter(Boolean))]
    }
    : null;
}

function loginLimit(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.lockedUntil > Date.now()) return { allowed: false, seconds: Math.ceil((entry.lockedUntil - Date.now()) / 1000) };
  if (entry.lockedUntil) loginAttempts.delete(ip);
  return { allowed: true };
}

function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= loginMaxAttempts) entry.lockedUntil = Date.now() + loginLockoutMinutes * 60 * 1000;
  loginAttempts.set(ip, entry);
  return entry;
}

function clearLoginFailures(ip) { loginAttempts.delete(ip); }

function logLoginAttempt(channel, outcome, address, details = {}) {
  console.warn(JSON.stringify({ event: 'auth.login', channel, outcome, address, ...details }));
}

function loginLockedMessage(seconds) {
  return `تم قفل الدخول. حاول مرة أخرى خلال ${Math.max(1, Math.ceil(seconds / 60))} دقيقة.`;
}

function allowResetAttempt(ip, action, limit, windowMs) {
  const key = `${action}:${ip}`;
  const now = Date.now();
  const entry = resetAttempts.get(key);
  if (!entry || entry.expiresAt <= now) {
    resetAttempts.set(key, { count: 1, expiresAt: now + windowMs });
    return { allowed: true };
  }
  if (entry.count >= limit) return { allowed: false, seconds: Math.ceil((entry.expiresAt - now) / 1000) };
  entry.count += 1;
  return { allowed: true };
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;
  const method = request.method || 'GET';
  const usersCount = database.prepare('SELECT COUNT(*) AS count FROM users').get().count;

  if (method !== 'GET' && !verifySameOrigin(request)) {
    json(response, 403, { error: 'تم رفض الطلب لمصدر غير موثوق. تأكد أن FIKRATAK_ALLOWED_ORIGINS يطابق عنوان HTTPS في المتصفح تمامًا، بما في ذلك www إن وُجدت، ثم أعد تشغيل الخدمة.' });
    return;
  }

  const presentationLogoMatch = pathname.match(/^\/api\/campaign-presentations\/([A-Za-z0-9_-]{40,60})\/client-logo$/);
  if (presentationLogoMatch && (method === 'GET' || method === 'HEAD')) {
    const logo = database.prepare(`SELECT logo.mime_type AS mimeType, logo.file_data AS fileData
      FROM campaign_presentations p
      JOIN campaign_presentation_client_logos logo ON logo.presentation_id = p.id
      JOIN campaigns c ON c.id = p.campaign_id AND c.execution_mode IN ('visit', 'mix')
      JOIN client_account_campaigns ac ON ac.campaign_id = c.id AND ac.account_id = p.client_account_id
      JOIN client_accounts a ON a.id = p.client_account_id AND a.active = 1
      WHERE p.token_hash = ? AND p.active = 1`).get(tokenHash(presentationLogoMatch[1]));
    if (!logo) { json(response, 404, { error: 'شعار العميل غير متاح.' }); return; }
    response.writeHead(200, {
      'Content-Type': logo.mimeType,
      'Content-Length': logo.fileData.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow, noarchive'
    });
    response.end(method === 'HEAD' ? undefined : logo.fileData);
    return;
  }

  const publicPresentationMatch = pathname.match(/^\/api\/campaign-presentations\/([A-Za-z0-9_-]{40,60})$/);
  if (publicPresentationMatch && method === 'GET') {
    const presentation = readPresentation(publicPresentationMatch[1]);
    if (!presentation) { json(response, 404, { error: 'العرض غير متاح.' }); return; }
    json(response, 200, presentation);
    return;
  }

  const publicCatalogMatch = pathname.match(/^\/api\/client-catalog\/([A-Za-z0-9_-]{40,60})$/);
  if (publicCatalogMatch && method === 'GET') {
    const result = publicCatalog(publicCatalogMatch[1], { logAccess: true });
    if (!result?.catalog) {
      json(response, result?.expired ? 410 : 404, { error: 'رابط العرض غير متاح.' });
      return;
    }
    json(response, 200, result.catalog);
    return;
  }

  const publicDecisionsMatch = pathname.match(/^\/api\/client-catalog\/([A-Za-z0-9_-]{40,60})\/decisions$/);
  if (publicDecisionsMatch && method === 'POST') {
    const result = publicCatalog(publicDecisionsMatch[1]);
    if (!result?.catalog) { json(response, result?.expired ? 410 : 404, { error: 'رابط العرض غير متاح.' }); return; }
    const catalog = result.catalog;
    const catalogRow = database.prepare('SELECT id, portal_linked FROM client_catalogs WHERE token_hash = ? AND active = 1')
      .get(tokenHash(publicDecisionsMatch[1]));
    if (catalogRow.portal_linked
      || database.prepare('SELECT 1 FROM client_account_catalogs WHERE catalog_id = ?').get(catalogRow.id)) {
      json(response, 403, { error: 'اتخذ القرار من بوابة العميل بعد تسجيل الدخول.' });
      return;
    }
    const body = await readJson(request);
    if (!Array.isArray(body.decisions) || !body.decisions.length || body.decisions.length > 5000) {
      json(response, 400, { error: 'قائمة الاختيارات غير صالحة.' });
      return;
    }
    const decisions = body.decisions.map((item) => ({
      influencerId: typeof item?.influencerId === 'string' ? item.influencerId : '',
      decision: String(item?.decision || '')
    }));
    const ids = decisions.map((item) => item.influencerId);
    if (ids.some((id) => !/^[a-f0-9]{32}$/i.test(id)) || new Set(ids).size !== ids.length
      || decisions.some((item) => !['accepted', 'rejected', 'reverted'].includes(item.decision))) {
      json(response, 400, { error: 'تتضمن الاختيارات قيمة غير صالحة أو مؤثرًا مكررًا.' });
      return;
    }
    const placeholders = ids.map(() => '?').join(', ');
    const selectedIds = new Set(database.prepare(`SELECT influencer_id FROM client_catalog_items
      WHERE catalog_id = ? AND influencer_id IN (${placeholders})`).all(catalogRow.id, ...ids)
      .map((row) => row.influencer_id));
    if (selectedIds.size !== ids.length) {
      json(response, 400, { error: 'تتضمن الاختيارات مؤثرًا غير موجود في هذا العرض.' });
      return;
    }
    const priorRows = database.prepare(`SELECT influencer_id, decision, created_at FROM client_catalog_decisions
      WHERE catalog_id = ? AND influencer_id IN (${placeholders})`).all(catalogRow.id, ...ids);
    const priorById = new Map(priorRows.map((row) => [row.influencer_id, row]));
    if (decisions.some((item) => item.decision === 'reverted' && !priorById.has(item.influencerId))) {
      json(response, 409, { error: 'لا يوجد قرار سابق للتراجع عنه.' });
      return;
    }
    const now = new Date().toISOString();
    const savedDecisions = [];
    for (const item of decisions) {
      const previous = priorById.get(item.influencerId);
      if (item.decision !== 'reverted' && previous?.decision === item.decision) {
        savedDecisions.push({
          influencerId: item.influencerId,
          decision: previous.decision,
          createdAt: previous.created_at,
          unchanged: true
        });
        continue;
      }
      if (item.decision === 'reverted') {
        database.prepare('DELETE FROM client_catalog_decisions WHERE catalog_id = ? AND influencer_id = ?')
          .run(catalogRow.id, item.influencerId);
      } else {
        database.prepare(`INSERT INTO client_catalog_decisions (id, catalog_id, influencer_id, decision, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(catalog_id, influencer_id) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`)
          .run(randomBytes(16).toString('hex'), catalogRow.id, item.influencerId, item.decision, now);
      }
      database.prepare(`INSERT INTO client_catalog_decision_history
        (id, catalog_id, influencer_id, actor_label, event_type, previous_decision, decision, created_at)
        VALUES (?, ?, ?, 'legacy share link', ?, ?, ?, ?)`)
        .run(randomBytes(16).toString('hex'), catalogRow.id, item.influencerId,
          item.decision === 'reverted' ? 'reverted' : item.decision,
          previous?.decision || null, item.decision === 'reverted' ? null : item.decision, now);
      savedDecisions.push({
        influencerId: item.influencerId,
        decision: item.decision === 'reverted' ? 'pending' : item.decision,
        createdAt: item.decision === 'reverted' ? null : now,
        unchanged: false
      });
    }
    json(response, 200, { ok: true, savedAt: now, decisions: savedDecisions });
    return;
  }

  const publicInquiryMatch = pathname.match(/^\/api\/client-catalog\/([A-Za-z0-9_-]{40,60})\/inquiries$/);
  if (publicInquiryMatch && method === 'POST') {
    const result = publicCatalog(publicInquiryMatch[1]);
    if (!result?.catalog) { json(response, result?.expired ? 410 : 404, { error: 'رابط العرض غير متاح.' }); return; }
    const body = await readJson(request);
    const customerName = String(body.customerName || '').trim();
    const customerContact = String(body.customerContact || '').trim();
    const influencerId = typeof body.influencerId === 'string' ? body.influencerId : '';
    if (customerName.length < 2 || customerName.length > 100 || customerContact.length < 5 || customerContact.length > 100) {
      json(response, 400, { error: 'أدخل الاسم ووسيلة تواصل صحيحة.' });
      return;
    }
    const catalogRow = database.prepare('SELECT id FROM client_catalogs WHERE token_hash = ? AND active = 1').get(tokenHash(publicInquiryMatch[1]));
    const selectedInfluencer = database.prepare(`
      SELECT i.id FROM client_catalog_items ci
      JOIN influencers i ON i.id = ci.influencer_id
      WHERE ci.catalog_id = ? AND i.id = ?
    `).get(catalogRow.id, influencerId);
    if (!selectedInfluencer) { json(response, 400, { error: 'المؤثر المحدد غير موجود في العرض.' }); return; }
    database.prepare(`
      INSERT INTO client_inquiries (id, catalog_id, influencer_id, customer_name, customer_contact, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomBytes(16).toString('hex'), catalogRow.id, selectedInfluencer.id, customerName, customerContact, new Date().toISOString());
    json(response, 201, { ok: true });
    return;
  }

  const publicDecisionMatch = pathname.match(/^\/api\/client-catalog\/([A-Za-z0-9_-]{40,60})\/decision$/);
  if (publicDecisionMatch && method === 'POST') {
    const result = publicCatalog(publicDecisionMatch[1]);
    if (!result?.catalog) { json(response, result?.expired ? 410 : 404, { error: 'رابط العرض غير متاح.' }); return; }
    const body = await readJson(request);
    const influencerId = typeof body.influencerId === 'string' ? body.influencerId : '';
    const decision = String(body.decision || '').trim();
    if (!['accepted', 'rejected', 'reverted'].includes(decision)) {
      json(response, 400, { error: 'اختيار الموافقة أو الرفض غير صالح.' });
      return;
    }
    const catalogRow = database.prepare('SELECT id, portal_linked FROM client_catalogs WHERE token_hash = ? AND active = 1').get(tokenHash(publicDecisionMatch[1]));
    if (!catalogRow) { json(response, 404, { error: 'رابط العرض غير متاح.' }); return; }
    if (catalogRow.portal_linked || database.prepare('SELECT 1 FROM client_account_catalogs WHERE catalog_id = ?').get(catalogRow.id)) {
      json(response, 403, { error: 'اتخذ القرار من بوابة العميل بعد تسجيل الدخول.' });
      return;
    }
    const selectedInfluencer = database.prepare(`
      SELECT i.id
      FROM client_catalog_items ci
      JOIN influencers i ON i.id = ci.influencer_id
      WHERE ci.catalog_id = ? AND i.id = ?
    `).get(catalogRow.id, influencerId);
    if (!selectedInfluencer) { json(response, 400, { error: 'المؤثر المحدد غير موجود في العرض.' }); return; }
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      const previous = database.prepare(`SELECT decision FROM client_catalog_decisions
        WHERE catalog_id = ? AND influencer_id = ?`).get(catalogRow.id, selectedInfluencer.id)?.decision || null;
      if (decision === 'reverted' && !previous) {
        database.exec('ROLLBACK');
        json(response, 409, { error: 'لا يوجد قرار سابق للتراجع عنه.' });
        return;
      }
      if (decision !== 'reverted' && previous === decision) {
        database.exec('COMMIT');
        json(response, 200, { ok: true, decision, unchanged: true });
        return;
      }
      if (decision === 'reverted') {
        database.prepare('DELETE FROM client_catalog_decisions WHERE catalog_id = ? AND influencer_id = ?')
          .run(catalogRow.id, selectedInfluencer.id);
      } else {
        database.prepare(`INSERT INTO client_catalog_decisions (id, catalog_id, influencer_id, decision, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(catalog_id, influencer_id) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`)
          .run(randomBytes(16).toString('hex'), catalogRow.id, selectedInfluencer.id, decision, now);
      }
      database.prepare(`INSERT INTO client_catalog_decision_history
        (id, catalog_id, influencer_id, actor_label, event_type, previous_decision, decision, created_at)
        VALUES (?, ?, ?, 'legacy share link', ?, ?, ?, ?)`)
        .run(randomBytes(16).toString('hex'), catalogRow.id, selectedInfluencer.id,
          decision, previous, decision === 'reverted' ? null : decision, now);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 200, { ok: true, decision: decision === 'reverted' ? 'pending' : decision });
    return;
  }

  if (pathname === '/api/client-portal/session' && method === 'GET') {
    const account = getClientSessionAccount(request);
    json(response, 200, {
      account: account ? {
        clientName: account.clientName,
        companyName: account.companyName,
        clientType: account.clientType,
        displayMode: account.displayMode,
        email: account.email || '',
        brand: clientPortalBrand(account)
      } : null
    });
    return;
  }

  if (pathname === '/api/client-portal/login' && method === 'POST') {
    const ip = `client:${requestAddress(request)}`;
    const limit = loginLimit(ip);
    if (!limit.allowed) {
      logLoginAttempt('client-portal', 'locked', ip.slice('client:'.length), { retryAfter: limit.seconds });
      json(response, 429, { code: 'LOGIN_LOCKED', error: loginLockedMessage(limit.seconds), retryAfter: limit.seconds });
      return;
    }
    const body = await readJson(request);
    const identifier = normalizeUsername(body.email || body.username);
    const useEmail = identifier.includes('@');
    const account = database.prepare(`SELECT id, username, email, client_name AS clientName,
      company_name AS companyName, client_type AS clientType, display_mode AS displayMode,
      salt, password_hash, active
      FROM client_accounts WHERE ${useEmail ? 'email' : 'username'} = ? COLLATE NOCASE`)
      .get(useEmail ? normalizeEmail(identifier) : identifier);
    const password = typeof body.password === 'string' ? body.password : '';
    const valid = validateLoginPassword(password) && await checkPassword(password, account);
    if (!account || !valid || !account.active) {
      const failure = recordLoginFailure(ip);
      logLoginAttempt('client-portal', 'bad_credentials', ip.slice('client:'.length), {
        attempts: failure.count, maxAttempts: loginMaxAttempts
      });
      json(response, 401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
      return;
    }
    clearLoginFailures(ip);
    const token = randomBytes(32).toString('base64url');
    clientSessions.set(token, { accountId: account.id, expiresAt: Date.now() + sessionDurationMs });
    response.setHeader('Set-Cookie', clientCookieHeader(token));
    json(response, 200, {
      account: {
        clientName: account.clientName,
        companyName: account.companyName,
        clientType: account.clientType,
        displayMode: account.displayMode,
        email: account.email || '',
        brand: clientPortalBrand(account)
      }
    });
    return;
  }

  if (pathname === '/api/client-portal/logout' && method === 'POST') {
    clientSessions.delete(requestCookie(request, 'client_sid'));
    json(response, 200, { ok: true }, { 'Set-Cookie': clearClientCookieHeader() });
    return;
  }

  if (pathname === '/api/client-portal/showcases' && method === 'GET') {
    const account = getClientSessionAccount(request);
    if (!account) { json(response, 401, { error: 'يلزم تسجيل الدخول إلى بوابة العميل.' }); return; }
    if (account.portalStatus !== 'published') { json(response, 403, { error: 'بوابة العميل غير منشورة.' }); return; }
    const lists = database.prepare(`SELECT c.id, c.offer_name AS title, c.company_name AS companyName,
      COUNT(ci.influencer_id) AS total,
      (SELECT COUNT(*) FROM client_showcase_feedback sf
        WHERE sf.account_id = ac.account_id AND sf.catalog_id = c.id AND sf.is_favorite = 1) AS favoriteCount
      FROM client_account_catalogs ac
      JOIN client_catalogs c ON c.id = ac.catalog_id
      LEFT JOIN client_catalog_items ci ON ci.catalog_id = c.id
      WHERE ac.account_id = ? AND c.active = 1 AND c.offer_status = 'published'
      GROUP BY c.id ORDER BY c.updated_at DESC, c.created_at DESC`).all(account.id)
      .map((list) => ({ ...list, total: Number(list.total || 0), favoriteCount: Number(list.favoriteCount || 0) }));
    json(response, 200, { client: { name: account.clientName, company: account.companyName }, lists });
    return;
  }

  const clientShowcaseMatch = pathname.match(/^\/api\/client-portal\/showcases\/([a-f0-9]{32})(?:\/feedback\/([a-f0-9]{32}))?$/);
  if (clientShowcaseMatch && method === 'GET') {
    const account = getClientSessionAccount(request);
    if (!account) { json(response, 401, { error: 'يلزم تسجيل الدخول إلى بوابة العميل.' }); return; }
    if (account.portalStatus !== 'published') { json(response, 403, { error: 'بوابة العميل غير منشورة.' }); return; }
    const catalogId = clientShowcaseMatch[1];
    const list = database.prepare(`SELECT c.id, c.offer_name AS title, c.company_name AS companyName,
        c.brand_id AS brandId,
        (SELECT COUNT(*) FROM client_catalog_items ci JOIN influencers i ON i.id = ci.influencer_id
          WHERE ci.catalog_id = c.id AND i.archived_at IS NULL) AS total
      FROM client_account_catalogs ac JOIN client_catalogs c ON c.id = ac.catalog_id
      WHERE ac.account_id = ? AND c.id = ? AND c.active = 1 AND c.offer_status = 'published'`)
      .get(account.id, catalogId);
    if (!list) { json(response, 404, { error: 'القائمة غير متاحة لهذا الحساب.' }); return; }

    const query = new URL(request.url, 'http://127.0.0.1').searchParams;
    const clauses = ['ci.catalog_id = ?', 'i.archived_at IS NULL'];
    const values = [catalogId];
    const search = String(query.get('q') || '').trim().slice(0, 120).toLocaleLowerCase();
    if (search) {
      const searchable = ['Name', 'Main_Username', 'Username I', 'Username T', 'Username', 'City', 'Area'];
      clauses.push(`(${searchable.map((field) => `instr(lower(COALESCE(json_extract(i.record_json, '$."${field}"'), '')), ?) > 0`).join(' OR ')})`);
      values.push(...searchable.map(() => search));
    }
    const category = String(query.get('category') || '').trim().slice(0, 100);
    if (category) {
      clauses.push(`(
        EXISTS (SELECT 1 FROM json_each(i.record_json, '$."Interests"') AS selected_interest
          WHERE lower(trim(CAST(selected_interest.value AS TEXT))) = lower(?))
        OR EXISTS (SELECT 1 FROM json_each(i.record_json, '$."Unmapped Interests"') AS legacy_interest
          WHERE lower(trim(CAST(legacy_interest.value AS TEXT))) = lower(?))
      )`);
      values.push(category, category);
    }
    const city = String(query.get('city') || '').trim().slice(0, 100);
    if (city) { clauses.push(`lower(trim(COALESCE(json_extract(i.record_json, '$."City"'), ''))) = lower(?)`); values.push(city); }
    const platform = String(query.get('platform') || '');
    const platformUsername = { TikTok: 'Username T', Instagram: 'Username I', Snapchat: 'Username' }[platform];
    if (platformUsername) { clauses.push(`trim(COALESCE(json_extract(i.record_json, '$."${platformUsername}"'), '')) <> ''`); }
    const tier = String(query.get('tier') || '').trim();
    if (followerTiers.includes(tier)) {
      const accountFollowerFields = platform === 'Instagram' ? ['Followers Count I']
        : platform === 'TikTok' ? ['Followers Count T']
          : platform === 'Snapchat' ? ['Followers Count S']
            : ['Followers Count I', 'Followers Count T', 'Followers Count S'];
      clauses.push(`(${accountFollowerFields.map((field) => `follower_tier(json_extract(i.record_json, '$."${field}"')) = ?`).join(' OR ')})`);
      values.push(...accountFollowerFields.map(() => tier));
    }
    if (query.get('favorites') === '1') {
      clauses.push('EXISTS (SELECT 1 FROM client_showcase_feedback sf WHERE sf.account_id = ? AND sf.catalog_id = ci.catalog_id AND sf.influencer_id = ci.influencer_id AND sf.is_favorite = 1)');
      values.push(account.id);
    }
    const where = clauses.join(' AND ');
    const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM client_catalog_items ci
      JOIN influencers i ON i.id = ci.influencer_id WHERE ${where}`).get(...values).count);
    const pageSize = Math.max(1, Math.min(48, Number.parseInt(query.get('pageSize') || '24', 10) || 24));
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(Math.max(1, Number.parseInt(query.get('page') || '1', 10) || 1), pageCount);
    const sort = query.get('sort') === 'name'
      ? `json_extract(i.record_json, '$."Name"') COLLATE NOCASE ASC, ci.position ASC`
      : query.get('sort') === 'followers'
        ? `MAX(follower_count(json_extract(i.record_json, '$."Followers Count T"')), follower_count(json_extract(i.record_json, '$."Followers Count I"')), follower_count(json_extract(i.record_json, '$."Followers Count S"'))) DESC, ci.position ASC`
        : 'ci.position ASC';
    const rows = database.prepare(`SELECT i.id, i.record_json, sf.is_favorite AS isFavorite, sf.comment
      FROM client_catalog_items ci JOIN influencers i ON i.id = ci.influencer_id
      LEFT JOIN client_showcase_feedback sf ON sf.account_id = ? AND sf.catalog_id = ci.catalog_id AND sf.influencer_id = i.id
      WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`)
      .all(account.id, ...values, pageSize, (page - 1) * pageSize);
    const categories = database.prepare(`SELECT DISTINCT label FROM (
      SELECT trim(CAST(interest.value AS TEXT)) AS label FROM client_catalog_items ci JOIN influencers i ON i.id = ci.influencer_id, json_each(i.record_json, '$."Interests"') AS interest WHERE ci.catalog_id = ? AND i.archived_at IS NULL UNION ALL
      SELECT trim(CAST(interest.value AS TEXT)) AS label FROM client_catalog_items ci JOIN influencers i ON i.id = ci.influencer_id, json_each(i.record_json, '$."Unmapped Interests"') AS interest WHERE ci.catalog_id = ? AND i.archived_at IS NULL
    ) WHERE label <> '' ORDER BY label`).all(catalogId, catalogId).map((row) => row.label);
    const cities = database.prepare(`SELECT DISTINCT trim(json_extract(i.record_json, '$."City"')) AS label
      FROM client_catalog_items ci JOIN influencers i ON i.id = ci.influencer_id
      WHERE ci.catalog_id = ? AND trim(COALESCE(json_extract(i.record_json, '$."City"'), '')) <> '' ORDER BY label`).all(catalogId).map((row) => row.label);
    json(response, 200, {
      list: { ...list, total: Number(list.total || 0) }, total, page, pageSize, pageCount, categories, cities,
      coverageVideos: catalogCoverageVideos({ id: catalogId, company_name: list.companyName, brandId: list.brandId }),
      items: rows.map((row) => {
        const record = JSON.parse(row.record_json || '{}');
        return {
          id: row.id,
          ...clientShowcaseRecord(record, { isFavorite: row.isFavorite, comment: row.comment },
            catalogAccountVisibilityMap(catalogId, row.id, record))
        };
      })
    });
    return;
  }

  if (clientShowcaseMatch && method === 'PUT' && clientShowcaseMatch[2]) {
    const account = getClientSessionAccount(request);
    if (!account) { json(response, 401, { error: 'يلزم تسجيل الدخول إلى بوابة العميل.' }); return; }
    if (account.portalStatus !== 'published') { json(response, 403, { error: 'بوابة العميل غير منشورة.' }); return; }
    const [, catalogId, influencerId] = clientShowcaseMatch;
    const assigned = database.prepare(`SELECT 1 FROM client_account_catalogs ac
      JOIN client_catalogs c ON c.id = ac.catalog_id
      JOIN client_catalog_items ci ON ci.catalog_id = c.id
      WHERE ac.account_id = ? AND c.id = ? AND c.active = 1 AND c.offer_status = 'published' AND ci.influencer_id = ?`)
      .get(account.id, catalogId, influencerId);
    if (!assigned) { json(response, 404, { error: 'المؤثر غير موجود في قوائم هذا الحساب.' }); return; }
    const body = await readJson(request);
    if (typeof body.favorite !== 'boolean') { json(response, 400, { error: 'حالة المفضلة غير صالحة.' }); return; }
    const comment = String(body.comment || '').trim();
    if (comment.length > 600) { json(response, 400, { error: 'يجب ألا يتجاوز التعليق 600 حرف.' }); return; }
    const updatedAt = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`INSERT INTO client_showcase_feedback
        (account_id, catalog_id, influencer_id, is_favorite, comment, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, catalog_id, influencer_id) DO UPDATE SET
          is_favorite = excluded.is_favorite, comment = excluded.comment, updated_at = excluded.updated_at`)
        .run(account.id, catalogId, influencerId, Number(body.favorite), comment, updatedAt);
      recordClientActivity(account.id, { username: account.username }, 'showcase_feedback_updated', {
        catalogId, influencerId, favorite: body.favorite, comment
      });
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 200, { ok: true, favorite: body.favorite, comment, updatedAt });
    return;
  }

  if (pathname === '/api/client-portal/campaigns' && method === 'GET') {
    const account = getClientSessionAccount(request);
    if (!account) { json(response, 401, { error: 'يلزم تسجيل الدخول إلى بوابة العميل.' }); return; }
    json(response, 200, clientCampaignPresentation(account));
    return;
  }

  if (pathname === '/api/client-portal/visits' && method === 'GET') {
    const account = getClientSessionAccount(request);
    if (!account) { json(response, 401, { error: 'يلزم تسجيل الدخول إلى بوابة العميل.' }); return; }
    if (displayModeFor(account) !== 'existing') {
      json(response, 403, { error: 'جدول الزيارات متاح للعملاء الموجودين فقط.' }); return;
    }
    if (account.portalStatus !== 'published') {
      json(response, 403, { error: 'بوابة العميل غير منشورة.' }); return;
    }
    json(response, 200, { schedule: publishedClientVisitSchedule(account.id) });
    return;
  }

  const portalOfferDecisionMatch = pathname.match(/^\/api\/client-portal\/offers\/([a-f0-9]{32})\/targets\/([a-f0-9]{32})\/decision$/);
  if (portalOfferDecisionMatch && method === 'POST') {
    const account = getClientSessionAccount(request);
    if (!account) { json(response, 401, { error: 'يلزم تسجيل الدخول إلى بوابة العميل.' }); return; }
    if (account.portalStatus !== 'published') { json(response, 403, { error: 'بوابة العميل غير منشورة.' }); return; }
    if (displayModeFor(account) !== 'selecting') {
      json(response, 403, { error: 'طريقة عرض هذا العميل مخصصة للمشاهدة فقط ولا تسمح بالقرارات.' }); return;
    }
    const [, catalogId, influencerId] = portalOfferDecisionMatch;
    const body = await readJson(request);
    const decision = String(body.decision || '');
    if (!['accepted', 'rejected', 'reverted'].includes(decision)) {
      json(response, 400, { error: 'القرار غير صالح.' });
      return;
    }
    const assigned = database.prepare(`SELECT c.id
      FROM client_account_catalogs ac
      JOIN client_catalogs c ON c.id = ac.catalog_id
      JOIN client_catalog_items ci ON ci.catalog_id = c.id
      WHERE ac.account_id = ? AND c.id = ? AND c.active = 1
        AND c.offer_status = 'published' AND ci.influencer_id = ?`).get(account.id, catalogId, influencerId);
    if (!assigned) { json(response, 404, { error: 'العرض أو المؤثر غير موجود ضمن حساب العميل.' }); return; }
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      const previous = database.prepare(`SELECT decision FROM client_catalog_decisions
        WHERE catalog_id = ? AND influencer_id = ?`).get(catalogId, influencerId)?.decision || null;
      if (decision === 'reverted' && !previous) {
        database.exec('ROLLBACK');
        json(response, 409, { error: 'لا يوجد قرار سابق للتراجع عنه.' });
        return;
      }
      if (decision !== 'reverted' && previous === decision) {
        database.exec('COMMIT');
        json(response, 200, { ok: true, decision, unchanged: true });
        return;
      }
      if (decision === 'reverted') {
        database.prepare('DELETE FROM client_catalog_decisions WHERE catalog_id = ? AND influencer_id = ?')
          .run(catalogId, influencerId);
      } else {
        database.prepare(`INSERT INTO client_catalog_decisions (id, catalog_id, influencer_id, decision, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(catalog_id, influencer_id) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`)
          .run(randomBytes(16).toString('hex'), catalogId, influencerId, decision, now);
      }
      database.prepare(`INSERT INTO client_catalog_decision_history
        (id, catalog_id, influencer_id, client_account_id, actor_label, event_type,
         previous_decision, decision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomBytes(16).toString('hex'), catalogId, influencerId, account.id,
          account.username, decision, previous, decision === 'reverted' ? null : decision, now);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 200, { ok: true, decision: decision === 'reverted' ? 'pending' : decision });
    return;
  }

  const portalActionMatch = pathname.match(/^\/api\/client-portal\/campaigns\/([a-f0-9]{32})\/targets\/([a-f0-9]{32})\/action$/);
  if (portalActionMatch && method === 'POST') {
    const account = getClientSessionAccount(request);
    if (!account) { json(response, 401, { error: 'يلزم تسجيل الدخول إلى بوابة العميل.' }); return; }
    if (account.portalStatus !== 'published') { json(response, 403, { error: 'بوابة العميل غير منشورة.' }); return; }
    if (displayModeFor(account) !== 'selecting') {
      json(response, 403, { error: 'هذه طريقة عرض للقراءة فقط ولا تسمح بإجراءات على الزيارات أو الشحن.' }); return;
    }
    const [, campaignId, influencerId] = portalActionMatch;
    const body = await readJson(request);
    const actionType = String(body.action || '');
    if (actionType.startsWith('visit_')) {
      json(response, 403, { error: 'لا يمكن للعميل تعديل أو تأكيد جدول الزيارات من البوابة.' }); return;
    }
    const allowedAction = {
      visit_confirmed: account.portalConfig.actions.allowVisitConfirmation,
      visit_change_requested: account.portalConfig.actions.allowVisitChangeRequest,
      shipping_followup: account.portalConfig.actions.allowShippingFollowUp
    }[actionType];
    if (allowedAction !== true) { json(response, 403, { error: 'هذا الإجراء غير مفعّل في صفحة العميل.' }); return; }
    const campaign = database.prepare(`SELECT c.id, c.execution_mode AS campaignType,
        ct.execution_type AS executionType
      FROM client_account_campaigns ac JOIN campaigns c ON c.id = ac.campaign_id
      JOIN campaign_targets ct ON ct.campaign_id = c.id
      WHERE ac.account_id = ? AND c.id = ? AND ct.influencer_id = ?`).get(account.id, campaignId, influencerId);
    if (!campaign) { json(response, 404, { error: 'الحملة أو المؤثر غير موجود ضمن حساب العميل.' }); return; }
    if ((actionType.startsWith('visit_') && campaign.executionType !== 'visit')
      || (actionType === 'shipping_followup' && campaign.executionType !== 'delivery')) {
      json(response, 400, { error: 'نوع الإجراء لا يطابق نوع الحملة.' }); return;
    }
    const details = String(body.details || '').trim();
    if (details.length > 500) { json(response, 400, { error: 'التفاصيل تتجاوز الحد المسموح.' }); return; }
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      if (actionType === 'visit_confirmed') {
        const changed = database.prepare(`UPDATE campaign_targets
          SET visit_status = 'confirmed'
          WHERE campaign_id = ? AND influencer_id = ? AND visit_status = 'pending_confirmation'`)
          .run(campaignId, influencerId);
        if (!changed.changes) {
          database.exec('ROLLBACK');
          const status = database.prepare('SELECT visit_status AS visitStatus FROM campaign_targets WHERE campaign_id = ? AND influencer_id = ?').get(campaignId, influencerId)?.visitStatus;
          json(response, status === 'confirmed' ? 200 : 409, { ok: status === 'confirmed', action: status === 'confirmed' ? actionType : '', message: status === 'confirmed' ? 'تم تأكيد الزيارة مسبقًا.' : 'لا يمكن تأكيد هذه الزيارة بحالتها الحالية.' });
          return;
        }
      }
      database.prepare(`INSERT INTO client_campaign_actions
        (id, campaign_id, influencer_id, client_account_id, action_type, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(randomBytes(16).toString('hex'), campaignId, influencerId, account.id, actionType, details, now);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 201, { ok: true, action: actionType, createdAt: now });
    return;
  }

  const portalDecisionMatch = pathname.match(/^\/api\/client-portal\/campaigns\/([a-f0-9]{32})\/targets\/([a-f0-9]{32})\/decision$/);
  if (portalDecisionMatch && method === 'POST') {
    const account = getClientSessionAccount(request);
    if (!account) { json(response, 401, { error: 'يلزم تسجيل الدخول إلى بوابة العميل.' }); return; }
    if (account.portalStatus !== 'published') { json(response, 403, { error: 'بوابة العميل غير منشورة.' }); return; }
    const [, campaignId, influencerId] = portalDecisionMatch;
    if (displayModeFor(account) !== 'selecting') {
      json(response, 403, { error: 'طريقة عرض هذا العميل لا تسمح بتغيير القرارات.' }); return;
    }
    const body = await readJson(request);
    const decision = String(body.decision || '').trim();
    if (!['accepted', 'rejected', 'reverted', 'pending'].includes(decision)) {
      json(response, 400, { error: 'القرار غير صالح.' });
      return;
    }
    const reverting = decision === 'reverted' || decision === 'pending';
    const assignment = database.prepare(`SELECT ct.campaign_id
      FROM client_account_campaigns ac
      JOIN campaigns c ON c.id = ac.campaign_id
      JOIN campaign_targets ct ON ct.campaign_id = c.id
      WHERE ac.account_id = ? AND c.id = ? AND ct.influencer_id = ?`).get(account.id, campaignId, influencerId);
    if (!assignment) { json(response, 404, { error: 'الحملة أو المؤثر غير موجود ضمن حساب العميل.' }); return; }
    const now = new Date().toISOString();
    const isRevert = reverting;
    database.exec('BEGIN IMMEDIATE');
    try {
      const current = database.prepare(`SELECT id, decision FROM campaign_target_decisions
        WHERE client_account_id = ? AND campaign_id = ? AND influencer_id = ?`)
        .get(account.id, campaignId, influencerId);
      const next = isRevert ? '' : decision;
      if ((current?.decision || '') !== next) {
        if (isRevert) {
          if (current) database.prepare('DELETE FROM campaign_target_decisions WHERE id = ?').run(current.id);
        } else {
          database.prepare(`INSERT INTO campaign_target_decisions
            (id, campaign_id, influencer_id, client_account_id, decision, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(client_account_id, campaign_id, influencer_id) DO UPDATE SET
              decision = excluded.decision, updated_at = excluded.updated_at`)
            .run(randomBytes(16).toString('hex'), campaignId, influencerId, account.id, decision, now, now);
        }
        database.prepare(`INSERT INTO client_decision_history
          (id, campaign_id, influencer_id, client_account_id, event_type,
           previous_decision, decision, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            randomBytes(16).toString('hex'), campaignId, influencerId, account.id,
            isRevert ? 'reverted' : decision, current?.decision || null, next || null, now
          );
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 200, { ok: true, decision: isRevert ? 'pending' : decision });
    return;
  }

  const followerHistoryMatch = pathname.match(/^\/api\/influencers\/([^/]+)\/follower-(history|updates)$/);
  if (followerHistoryMatch && ['GET', 'POST'].includes(method)) {
    const user = getSessionUser(request);
    if (!requireRole(user, ['admin', 'editor'])) {
      json(response, user ? 403 : 401, { error: 'تحديث سجل المتابعين متاح للمدير والمحرر فقط.' });
      return;
    }
    let influencerId;
    try { influencerId = decodeURIComponent(followerHistoryMatch[1]); }
    catch { json(response, 400, { error: 'معرّف السجل غير صالح.' }); return; }
    const body = method === 'POST' ? await readJson(request) : {};
    const platform = String(method === 'GET' ? url.searchParams.get('platform') || '' : body.platform || '').trim();
    const platformFields = followerPlatformFields[platform];
    if (!platformFields) {
      json(response, 400, { error: 'منصة المتابعين غير صالحة.' });
      return;
    }
    const influencerRow = database.prepare('SELECT id, record_json FROM influencers WHERE id = ?').get(influencerId);
    if (!influencerRow) { json(response, 404, { error: 'السجل غير موجود.' }); return; }
    if (method === 'GET') {
      const record = JSON.parse(influencerRow.record_json || '{}');
      const history = database.prepare(`SELECT followers_count AS followersCount,
          previous_count AS previousCount, source, actor_username AS actorUsername, recorded_at AS recordedAt
        FROM influencer_follower_history WHERE influencer_id = ? AND platform = ?
        ORDER BY recorded_at DESC, rowid DESC LIMIT 50`).all(influencerId, platform);
      json(response, 200, {
        influencerId,
        name: String(record.Name || ''),
        platform,
        username: String(record[platformFields.username] || ''),
        currentCount: parseFollowerValue(record[platformFields.followers]),
        history
      });
      return;
    }
    const followersCount = parseManualFollowerCount(body.followersCount);
    if (followersCount === null) {
      json(response, 400, { error: 'أدخل عددًا صحيحًا غير سالب للمتابعين.' });
      return;
    }
    const recordedAt = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      const currentRow = database.prepare('SELECT record_json FROM influencers WHERE id = ?').get(influencerId);
      if (!currentRow) {
        database.exec('ROLLBACK');
        json(response, 404, { error: 'السجل غير موجود.' });
        return;
      }
      const record = JSON.parse(currentRow.record_json || '{}');
      const latest = database.prepare(`SELECT followers_count AS followersCount
        FROM influencer_follower_history WHERE influencer_id = ? AND platform = ?
        ORDER BY recorded_at DESC, rowid DESC LIMIT 1`).get(influencerId, platform);
      const previousCount = latest?.followersCount ?? parseFollowerValue(record[platformFields.followers]);
      const delta = previousCount === null ? null : followersCount - previousCount;
      record[platformFields.followers] = String(followersCount);
      deriveInfluencerFields(record);
      saveInfluencer(influencerId, record);
      database.prepare(`INSERT INTO influencer_follower_history
        (id, influencer_id, platform, followers_count, previous_count, source, actor_username, recorded_at)
        VALUES (?, ?, ?, ?, ?, 'manual', ?, ?)`)
        .run(randomBytes(16).toString('hex'), influencerId, platform, followersCount,
          previousCount, user.username, recordedAt);
      database.exec('COMMIT');
      const history = database.prepare(`SELECT followers_count AS followersCount,
          previous_count AS previousCount, source, actor_username AS actorUsername, recorded_at AS recordedAt
        FROM influencer_follower_history WHERE influencer_id = ? AND platform = ?
        ORDER BY recorded_at DESC, rowid DESC LIMIT 50`).all(influencerId, platform);
      json(response, 200, {
        ok: true,
        influencerId,
        platform,
        followersCount,
        previousCount,
        delta,
        growthPercent: previousCount > 0 ? (delta / previousCount) * 100 : null,
        recordedAt,
        record: { ...record, id: influencerId },
        history
      });
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return;
  }

  const campaignCheckinMatch = pathname.match(/^\/api\/campaign-checkin\/([A-Za-z0-9_-]{24,48})$/);
  if (campaignCheckinMatch && method === 'POST') {
    const user = getSessionUser(request);
    if (!requireRole(user, ['admin', 'editor'])) {
      json(response, user ? 403 : 401, { error: 'يلزم تسجيل الدخول بحساب إدارة لتأكيد الحضور.' }); return;
    }
    const body = await readJson(request);
    const actionType = String(body.action || 'visit');
    if (!['visit', 'coverage'].includes(actionType)) { json(response, 400, { error: 'نوع تأكيد QR غير صالح.' }); return; }
    const checkedAt = new Date().toISOString();
    const target = database.prepare(`SELECT c.id AS campaignId, c.campaign_name AS campaignName,
        c.qr_enabled AS qrEnabled, i.id AS influencerId, i.record_json AS recordJson,
        ct.visit_date AS visitDate, ct.visited_at AS visitedAt,
        ct.visit_status AS visitStatus, ct.coverage_status AS coverageStatus
      FROM campaign_targets ct JOIN campaigns c ON c.id = ct.campaign_id
      JOIN influencers i ON i.id = ct.influencer_id
      WHERE ct.checkin_token = ? AND ct.execution_type = 'visit'`)
      .get(campaignCheckinMatch[1]);
    if (!target || !target.qrEnabled) { json(response, 404, { error: 'رمز QR غير صالح أو غير مفعّل.' }); return; }
    database.exec('BEGIN IMMEDIATE');
    try {
      const previous = database.prepare(`SELECT id FROM campaign_checkin_history
        WHERE campaign_id = ? AND influencer_id = ? AND action_type = ?`)
        .get(target.campaignId, target.influencerId, actionType);
      if (previous || (actionType === 'visit' && target.visitedAt)
        || (actionType === 'coverage' && target.coverageStatus === 'completed')) {
        database.exec('ROLLBACK');
        json(response, 409, { error: 'تم تسجيل هذا الإجراء مسبقًا.' });
        return;
      }
      if (actionType === 'visit') {
        database.prepare(`UPDATE campaign_targets SET visited_at = ?, visit_status = 'completed'
          WHERE campaign_id = ? AND influencer_id = ? AND execution_type = 'visit'`)
          .run(checkedAt, target.campaignId, target.influencerId);
      } else {
        database.prepare(`UPDATE campaign_targets SET coverage_status = 'completed'
          WHERE campaign_id = ? AND influencer_id = ? AND execution_type = 'visit'`)
          .run(target.campaignId, target.influencerId);
      }
      database.prepare(`INSERT INTO campaign_checkin_history
        (id, campaign_id, influencer_id, action_type, actor_user_id, actor_username, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(randomBytes(16).toString('hex'), target.campaignId, target.influencerId,
          actionType, user.id, user.username, checkedAt);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 200, {
      ok: true, action: actionType, campaignName: target.campaignName,
      influencerName: String(JSON.parse(target.recordJson).Name || ''),
      visitDate: target.visitDate, visitedAt: actionType === 'visit' ? checkedAt : target.visitedAt
    });
    return;
  }

  if (pathname === '/api/session' && method === 'GET') {
    const user = getSessionUser(request);
    json(response, 200, {
      setupRequired: usersCount === 0,
      setupTokenRequired: isProduction,
      user: user ? userView(user) : null
    });
    return;
  }

  if (pathname === '/api/setup' && method === 'POST') {
    if (!isProduction && !isLoopbackRequest(request)) { json(response, 403, { error: 'الإعداد الأولي مسموح من هذا الجهاز فقط.' }); return; }
    if (usersCount !== 0) { json(response, 409, { error: 'تم إعداد المدير بالفعل.' }); return; }
    const setupAddress = requestAddress(request);
    const setupAttempt = allowResetAttempt(setupAddress, 'initial-setup', 5, 15 * 60 * 1000);
    if (!setupAttempt.allowed) {
      json(response, 429, { error: 'تجاوزت عدد محاولات الإعداد المسموح. حاول بعد انتهاء المهلة.', retryAfter: setupAttempt.seconds });
      return;
    }
    const body = await readJson(request);
    if (isProduction && !matchesSetupToken(body.setupToken)) {
      json(response, 403, { error: 'رمز الإعداد غير صالح أو انتهت صلاحيته. اضبط FIKRATAK_SETUP_TOKEN في إعدادات الاستضافة، أعد تشغيل الخدمة، ثم أدخل الرمز خلال 30 دقيقة.' });
      return;
    }
    resetAttempts.delete(`initial-setup:${setupAddress}`);
    const username = normalizeUsername(body.username);
    if (!validateUsername(username)) { json(response, 400, { error: 'اكتب اسم مستخدم من 3 إلى 32 حرفًا، باستخدام الحروف أو الأرقام أو المسافات أو إحدى العلامات: . _ -' }); return; }
    if (!validatePassword(body.password)) { json(response, 400, { error: `كلمة المرور يجب أن تكون بين ${passwordMinLength} و${passwordMaxLength} أحرف.` }); return; }
    const credentials = await hashPassword(body.password);
    const user = { id: randomBytes(16).toString('hex'), username, role: 'admin', active: 1 };
    database.exec('BEGIN IMMEDIATE');
    try {
      if (database.prepare('SELECT COUNT(*) AS count FROM users').get().count !== 0) {
        database.exec('ROLLBACK');
        json(response, 409, { error: 'تم إعداد المدير بالفعل.' });
        return;
      }
      database.prepare('INSERT INTO users (id, username, salt, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .run(user.id, user.username, credentials.salt, credentials.hash, user.role, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 201, { user: issueSession(response, user) });
    return;
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (usersCount === 0) {
      logLoginAttempt('internal', 'no_users', requestAddress(request));
      json(response, 409, { code: 'SETUP_REQUIRED', error: 'لا يوجد مستخدمون بعد، شغّل الإعداد الأولي.' });
      return;
    }
    const ip = requestAddress(request);
    const limit = loginLimit(ip);
    if (!limit.allowed) {
      logLoginAttempt('internal', 'locked', ip, { retryAfter: limit.seconds });
      json(response, 429, { code: 'LOGIN_LOCKED', error: loginLockedMessage(limit.seconds), retryAfter: limit.seconds });
      return;
    }
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    const user = database.prepare('SELECT id, username, salt, password_hash, role, active FROM users WHERE username = ? COLLATE NOCASE').get(username);
    const password = typeof body.password === 'string' ? body.password : '';
    const valid = validateLoginPassword(password) && await checkPassword(password, user);
    if (!valid || !user.active) {
      const failure = recordLoginFailure(ip);
      logLoginAttempt('internal', 'bad_credentials', ip, {
        attempts: failure.count, maxAttempts: loginMaxAttempts
      });
      json(response, 401, { error: 'اسم المستخدم أو كلمة المرور غير صحيحة.' });
      return;
    }
    clearLoginFailures(ip);
    json(response, 200, { user: issueSession(response, user) });
    return;
  }

  if (pathname === '/api/password-reset-request' && method === 'POST') {
    if (isProduction) {
      json(response, 503, { error: 'استعادة كلمة المرور غير مفعّلة في الإنتاج؛ تواصل مع المدير لإعادة تعيينها.' });
      return;
    }
    const rate = allowResetAttempt(requestAddress(request), 'request', 3, 10 * 60 * 1000);
    if (!rate.allowed) { json(response, 429, { error: 'تجاوزت عدد طلبات الاستعادة المسموح. حاول مرة أخرى لاحقًا.', retryAfter: rate.seconds }); return; }
    const body = await readJson(request);
    const identifier = normalizeUsername(body.username || body.email || '');
    const user = database.prepare('SELECT id, username, email, active FROM users WHERE active = 1 AND (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) LIMIT 1').get(identifier, identifier);
    if (!user) {
      json(response, 200, { ok: true, message: 'إذا كان الحساب موجودًا، تم إنشاء رمز التحقق.' });
      return;
    }
    const code = makeResetCode();
    const expiresAt = new Date(Date.now() + passwordResetExpiryMs).toISOString();
    database.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
    database.prepare('INSERT INTO password_reset_tokens (id, user_id, code_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(randomBytes(16).toString('hex'), user.id, hashResetCode(code), expiresAt, new Date().toISOString());
    const outcome = prepareResetResponse(code);
    json(response, 200, {
      ok: true,
      message: outcome.message,
      code: outcome.localCode || null,
      localMode: true
    });
    return;
  }

  if (pathname === '/api/password-reset-confirm' && method === 'POST') {
    if (isProduction) {
      json(response, 503, { error: 'استعادة كلمة المرور غير مفعّلة في الإنتاج؛ تواصل مع المدير لإعادة تعيينها.' });
      return;
    }
    const rate = allowResetAttempt(requestAddress(request), 'confirm', 10, 10 * 60 * 1000);
    if (!rate.allowed) { json(response, 429, { error: 'تجاوزت عدد محاولات رمز الاستعادة المسموح. حاول مرة أخرى لاحقًا.', retryAfter: rate.seconds }); return; }
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    const code = String(body.code || '').trim();
    const password = String(body.password || '');
    if (!validateUsername(username)) { json(response, 400, { error: 'اسم المستخدم غير صالح.' }); return; }
    if (!/^\d{6}$/.test(code)) { json(response, 400, { error: 'رمز التحقق غير صالح.' }); return; }
    if (!validatePassword(password)) { json(response, 400, { error: `كلمة المرور الجديدة يجب أن تكون بين ${passwordMinLength} و${passwordMaxLength} أحرف.` }); return; }
    const user = database.prepare('SELECT id, username, active FROM users WHERE username = ? COLLATE NOCASE').get(username);
    if (!user || !user.active) { json(response, 400, { error: 'اسم المستخدم غير موجود أو غير نشط.' }); return; }
    const validReset = database.prepare('SELECT id, code_hash, expires_at FROM password_reset_tokens WHERE user_id = ? AND used = 0 ORDER BY created_at DESC LIMIT 1').get(user.id);
    if (!validReset) { json(response, 400, { error: 'رمز الاستعادة غير موجود أو تم استخدامه بالفعل.' }); return; }
    if (new Date(validReset.expires_at).getTime() <= Date.now()) {
      database.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(user.id);
      json(response, 400, { error: 'انتهت صلاحية رمز التحقق، اطلب رمزًا جديدًا.' });
      return;
    }
    if (validReset.code_hash !== hashResetCode(code)) {
      json(response, 400, { error: 'رمز التحقق غير صحيح.' });
      return;
    }
    const credentials = await hashPassword(password);
    database.prepare('UPDATE users SET salt = ?, password_hash = ? WHERE id = ?').run(credentials.salt, credentials.hash, user.id);
    database.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(validReset.id);
    for (const [token, session] of sessions) if (session.userId === user.id) sessions.delete(token);
    json(response, 200, { ok: true, message: 'تمت إعادة تعيين كلمة المرور بنجاح.' });
    return;
  }

  if (pathname === '/api/logout' && method === 'POST') {
    const token = requestCookie(request, 'sid');
    sessions.delete(token);
    json(response, 200, { ok: true }, { 'Set-Cookie': clearCookieHeader() });
    return;
  }

  const user = getSessionUser(request);
  if (!user) { json(response, 401, { error: 'يلزم تسجيل الدخول للمتابعة.' }); return; }

  const catalogPreviewMatch = pathname.match(/^\/api\/client-catalogs\/([a-f0-9]{32})\/client-preview$/);
  if (catalogPreviewMatch && method === 'GET') {
    if (!requireRole(user, ['admin', 'editor'])) {
      json(response, 403, { error: 'معاينة عرض العميل متاحة للفريق فقط.' });
      return;
    }
    const catalog = database.prepare(`SELECT id, client_name, company_name, offer_name, offer_status, portal_linked,
        show_city, show_category, show_details, show_company_work, brand_id AS brandId,
        brand_snapshot_json AS brandSnapshotJson
      FROM client_catalogs WHERE id = ?`).get(catalogPreviewMatch[1]);
    if (!catalog) { json(response, 404, { error: 'عرض العميل غير موجود.' }); return; }
    const presentation = catalogClientPresentation(catalog);
    json(response, 200, { ...presentation, decisionsEnabled: false, previewMode: true });
    return;
  }

  if (pathname === '/api/system-identity' && method === 'GET') {
    const identity = database.prepare('SELECT value FROM app_settings WHERE key = ?').get('company_identity');
    let value = companyIdentity;
    if (identity) {
      try { value = JSON.parse(identity.value); }
      catch { throw new Error('Company identity settings are invalid.'); }
    }
    json(response, 200, { identity: value });
    return;
  }

  if (pathname === '/api/system-identity' && method === 'PUT') {
    if (user.role !== 'admin') { json(response, 403, { error: 'تعديل هوية النظام متاح للمدير فقط.' }); return; }
    const body = await readJson(request);
    const nameAr = String(body.nameAr || '').trim();
    const nameEn = String(body.nameEn || '').trim();
    const email = normalizeEmail(body.email);
    if (!nameAr || nameAr.length > 100 || !nameEn || nameEn.length > 100 || !validateEmail(email)) {
      json(response, 400, { error: 'تحقق من اسم الشركة والبريد الإلكتروني.' }); return;
    }
    const value = { nameAr, nameEn, email };
    database.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run('company_identity', JSON.stringify(value), new Date().toISOString());
    json(response, 200, { identity: value });
    return;
  }

  if (pathname === '/api/brands' && method === 'GET') {
    const brands = database.prepare(`SELECT brand_id AS id, configuration_json AS configurationJson
      FROM company_brand_settings ORDER BY brand_id`).all().map((row) => {
      try { return JSON.parse(row.configurationJson); }
      catch { throw new Error(`Brand settings are invalid for ${row.id}.`); }
    });
    json(response, 200, { brands });
    return;
  }

  const brandMatch = pathname.match(/^\/api\/brands\/(fkretk|ryfaq)$/);
  if (brandMatch && method === 'PUT') {
    if (user.role !== 'admin') { json(response, 403, { error: 'تعديل الهوية التجارية متاح للمدير فقط.' }); return; }
    const brandId = brandMatch[1];
    const current = getBrandSettings(brandId);
    const body = await readJson(request);
    const next = {
      ...current,
      nameAr: body.nameAr === undefined ? current.nameAr : String(body.nameAr).trim(),
      nameEn: body.nameEn === undefined ? current.nameEn : String(body.nameEn).trim(),
      primaryColor: body.primaryColor === undefined ? current.primaryColor : String(body.primaryColor),
      secondaryColor: body.secondaryColor === undefined ? current.secondaryColor : String(body.secondaryColor),
      accentColor: body.accentColor === undefined ? current.accentColor : String(body.accentColor),
      logoPath: body.logoPath === undefined ? current.logoPath : String(body.logoPath),
      contactEmail: brandId === 'ryfaq' ? '' : body.contactEmail === undefined ? current.contactEmail : normalizeEmail(body.contactEmail)
    };
    if (!next.nameAr || next.nameAr.length > 100 || !next.nameEn || next.nameEn.length > 100
      || !/^#[0-9a-f]{6}$/i.test(next.primaryColor) || !/^#[0-9a-f]{6}$/i.test(next.secondaryColor)
      || !/^#[0-9a-f]{6}$/i.test(next.accentColor)
      || (next.logoPath && !/^\/assets\/[a-z0-9._-]+$/i.test(next.logoPath))
      || (next.contactEmail && !validateEmail(next.contactEmail))) {
      json(response, 400, { error: 'إعدادات الهوية التجارية غير صالحة.' }); return;
    }
    database.prepare(`UPDATE company_brand_settings SET configuration_json = ?, updated_at = ? WHERE brand_id = ?`)
      .run(JSON.stringify(next), new Date().toISOString(), brandId);
    json(response, 200, { brand: next });
    return;
  }

  if (pathname === '/api/audit' && method === 'GET') {
    if (user.role !== 'admin') { json(response, 403, { error: 'سجل العمليات متاح للمدير فقط.' }); return; }
    const params = url.searchParams;
    const clauses = [];
    const values = [];
    for (const [parameter, column] of [['user', 'actor_username'], ['action', 'action'], ['section', 'section']]) {
      const value = String(params.get(parameter) || '').trim().slice(0, 100);
      if (value) {
        clauses.push(`${column} LIKE ?`);
        values.push(`%${value.replace(/[\\%_]/g, '\\$&')}%`);
      }
    }
    const from = String(params.get('from') || '');
    const to = String(params.get('to') || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { clauses.push('occurred_at >= ?'); values.push(`${from}T00:00:00.000Z`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      const exclusiveEnd = new Date(`${to}T00:00:00.000Z`);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      clauses.push('occurred_at < ?');
      values.push(exclusiveEnd.toISOString());
    }
    const query = String(params.get('q') || '').trim().slice(0, 150);
    if (query) {
      clauses.push('(entity_label LIKE ? OR entity_id LIKE ?)');
      values.push(`%${query}%`, `%${query}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM audit_events ${where}`).get(...values).count);
    const page = Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(params.get('pageSize') || '50', 10) || 50));
    const rows = database.prepare(`SELECT id, actor_username AS username, actor_role AS role,
        action, section, entity_type AS entityType, entity_id AS entityId,
        entity_label AS entityLabel, outcome, http_status AS status,
        old_values_json AS oldValuesJson, new_values_json AS newValuesJson, occurred_at AS occurredAt
      FROM audit_events ${where} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize).map(row => ({
        ...row,
        oldValues: row.oldValuesJson ? JSON.parse(row.oldValuesJson) : null,
        newValues: row.newValuesJson ? JSON.parse(row.newValuesJson) : null
      }));
    json(response, 200, { rows, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) });
    return;
  }

  const auditEventMatch = pathname.match(/^\/api\/audit\/([a-f0-9]{32})$/);
  if (auditEventMatch && method === 'GET') {
    if (user.role !== 'admin') { json(response, 403, { error: 'تفاصيل سجل العمليات متاحة للمدير فقط.' }); return; }
    const row = database.prepare(`SELECT id, actor_username AS username, actor_role AS role,
        action, section, entity_type AS entityType, entity_id AS entityId,
        entity_label AS entityLabel, outcome, http_status AS status,
        old_values_json AS oldValuesJson, new_values_json AS newValuesJson, occurred_at AS occurredAt
      FROM audit_events WHERE id = ?`).get(auditEventMatch[1]);
    if (!row) { json(response, 404, { error: 'عملية السجل غير موجودة.' }); return; }
    json(response, 200, { event: { ...row,
      oldValues: row.oldValuesJson ? JSON.parse(row.oldValuesJson) : null,
      newValues: row.newValuesJson ? JSON.parse(row.newValuesJson) : null } });
    return;
  }

  const companyWorkVideoMatch = pathname.match(/^\/api\/company-work-videos(?:\/([a-f0-9]{32}))?$/);
  if (companyWorkVideoMatch) {
    const videoId = companyWorkVideoMatch[1] || '';
    if (method === 'GET' && !videoId) {
      json(response, 200, { videos: companyWorkVideoList() });
      return;
    }
    if (!requireRole(user, ['admin', 'editor'])) {
      json(response, 403, { error: 'إدارة مكتبة أعمال فكرتك متاحة للمدير والمحرر.' });
      return;
    }
    if (!videoId && method === 'POST') {
      const body = await readJson(request);
      const parsed = parseYouTubeVideoUrl(body.url);
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!parsed || typeof body.title !== 'string' || title.length > 200) {
        json(response, 400, { error: 'أدخل رابط YouTube صالحًا وعنوانًا لا يتجاوز 200 حرفًا.' }); return;
      }
      if (database.prepare('SELECT 1 FROM company_work_videos WHERE youtube_video_id = ?').get(parsed.videoId)) {
        json(response, 409, { error: 'هذا الفيديو موجود بالفعل في مكتبة أعمال فكرتك.' }); return;
      }
      const id = randomBytes(16).toString('hex');
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO company_work_videos
        (id, youtube_video_id, video_url, title, active, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
        .run(id, parsed.videoId, parsed.url, title, user.id, now, now);
      json(response, 201, { video: companyWorkVideoList().find((video) => video.id === id) });
      return;
    }
    const video = videoId ? database.prepare(`SELECT id, youtube_video_id AS videoId,
        video_url AS url, title, active FROM company_work_videos WHERE id = ?`).get(videoId) : null;
    if (videoId && !video) { json(response, 404, { error: 'الفيديو غير موجود في مكتبة أعمال فكرتك.' }); return; }
    if (videoId && method === 'PATCH') {
      const body = await readJson(request);
      let videoUrl = video.url;
      let youtubeVideoId = video.videoId;
      if (body.url !== undefined) {
        const parsed = parseYouTubeVideoUrl(body.url);
        if (!parsed) { json(response, 400, { error: 'رابط YouTube غير صالح.' }); return; }
        videoUrl = parsed.url;
        youtubeVideoId = parsed.videoId;
        const duplicate = database.prepare('SELECT id FROM company_work_videos WHERE youtube_video_id = ? AND id <> ?')
          .get(youtubeVideoId, videoId);
        if (duplicate) { json(response, 409, { error: 'هذا الفيديو موجود بالفعل في مكتبة أعمال فكرتك.' }); return; }
      }
      const title = body.title === undefined ? video.title : body.title;
      if (typeof title !== 'string' || title.trim().length > 200
        || (body.active !== undefined && typeof body.active !== 'boolean')) {
        json(response, 400, { error: 'تحقق من عنوان الفيديو وحالته.' }); return;
      }
      database.prepare(`UPDATE company_work_videos SET youtube_video_id = ?, video_url = ?, title = ?,
        active = ?, updated_at = ? WHERE id = ?`)
        .run(youtubeVideoId, videoUrl, title.trim(), body.active === undefined ? video.active : Number(body.active),
          new Date().toISOString(), videoId);
      json(response, 200, { video: companyWorkVideoList().find((item) => item.id === videoId) });
      return;
    }
    if (videoId && method === 'DELETE') {
      if (user.role !== 'admin') {
        json(response, 403, { error: 'حذف فيديوهات مكتبة أعمال فكرتك متاح للمدير فقط.' }); return;
      }
      database.prepare('DELETE FROM company_work_videos WHERE id = ?').run(videoId);
      json(response, 200, { ok: true });
      return;
    }
    json(response, 405, { error: 'العملية غير مدعومة.' });
    return;
  }

  const coverageVideoMatch = pathname.match(/^\/api\/coverage(?:\/([a-f0-9]{32}))?$/);
  if (coverageVideoMatch) {
    const videoId = coverageVideoMatch[1] || '';
    if (method === 'GET' && !videoId) {
      const params = new URL(request.url, 'http://127.0.0.1').searchParams;
      const query = String(params.get('q') || '').trim().slice(0, 150);
      const campaignId = String(params.get('campaignId') || '');
      const influencerId = String(params.get('influencerId') || '');
      const page = Math.max(1, Math.min(100000, Number(params.get('page')) || 1));
      const pageSize = Math.max(1, Math.min(100, Number(params.get('pageSize')) || 50));
      if ((campaignId && !/^[a-f0-9]{32}$/i.test(campaignId))
        || (influencerId && !/^[a-f0-9]{32}$/i.test(influencerId))) {
        json(response, 400, { error: 'مرشح المؤثر أو الحملة غير صالح.' }); return;
      }
      json(response, 200, coverageVideoList({ query, campaignId, influencerId, page, pageSize }));
      return;
    }
    if (!requireRole(user, ['admin', 'editor'])) {
      json(response, 403, { error: 'إضافة وتعديل فيديوهات Coverage متاحان للمدير والمحرر.' });
      return;
    }
    if (!videoId && method === 'POST') {
      const body = await readJson(request);
      const parsed = parseYouTubeVideoUrl(body.url);
      const title = body.title === undefined ? '' : typeof body.title === 'string' ? body.title.trim() : null;
      const description = body.description === undefined ? '' : typeof body.description === 'string' ? body.description.trim() : null;
      if (!parsed || title === null || title.length > 200
        || description === null || description.length > 2000
        || (!title && !description)) {
        json(response, 400, { error: 'أدخل رابط YouTube صالحًا وعنوانًا أو وصفًا ضمن الحدود المسموحة.' }); return;
      }
      let references;
      try { references = coverageReferenceIds(body); }
      catch (error) { json(response, error.status || 400, { error: error.message }); return; }
      const id = randomBytes(16).toString('hex');
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO coverage_videos
        (id, youtube_video_id, video_url, title, description, influencer_id, campaign_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, parsed.videoId, parsed.url, title, description,
          references.influencerId, references.campaignId, user.id, now, now);
      json(response, 201, { video: coverageVideoById(id) });
      return;
    }
    const video = videoId ? database.prepare(`SELECT id, youtube_video_id AS videoId,
        video_url AS url, title, description, influencer_id AS influencerId,
        campaign_id AS campaignId FROM coverage_videos WHERE id = ?`).get(videoId) : null;
    if (videoId && !video) { json(response, 404, { error: 'فيديو Coverage غير موجود.' }); return; }
    if (videoId && method === 'PATCH') {
      const body = await readJson(request);
      const parsed = body.url === undefined ? { videoId: video.videoId, url: video.url } : parseYouTubeVideoUrl(body.url);
      const title = body.title === undefined ? video.title : body.title;
      const description = body.description === undefined ? video.description : body.description;
      if (!parsed || typeof title !== 'string' || title.trim().length > 200
        || typeof description !== 'string' || description.trim().length > 2000
        || (!title.trim() && !description.trim())) {
        json(response, 400, { error: 'تحقق من رابط الفيديو والعنوان والوصف.' }); return;
      }
      let references;
      try { references = coverageReferenceIds(body, video); }
      catch (error) { json(response, error.status || 400, { error: error.message }); return; }
      database.prepare(`UPDATE coverage_videos SET youtube_video_id = ?, video_url = ?, title = ?,
        description = ?, influencer_id = ?, campaign_id = ?, updated_at = ? WHERE id = ?`)
        .run(parsed.videoId, parsed.url, title.trim(), description.trim(),
          references.influencerId, references.campaignId, new Date().toISOString(), videoId);
      json(response, 200, { video: coverageVideoById(videoId) });
      return;
    }
    if (videoId && method === 'DELETE') {
      if (user.role !== 'admin') {
        json(response, 403, { error: 'حذف فيديوهات Coverage متاح للمدير فقط.' }); return;
      }
      database.prepare('DELETE FROM coverage_videos WHERE id = ?').run(videoId);
      json(response, 200, { ok: true });
      return;
    }
    json(response, 405, { error: 'العملية غير مدعومة.' });
    return;
  }

  if (pathname === '/api/settings/follower-tiers' && method === 'GET') {
    json(response, 200, {
      tiers: followerTiers,
      thresholds: [...followerTierRules.thresholds],
      minimumFollowers: followerTierRules.minimumFollowers
    });
    return;
  }

  if (pathname === '/api/settings/follower-tiers' && method === 'PUT') {
    if (user.role !== 'admin') { json(response, 403, { error: 'Forbidden.' }); return; }
    json(response, 409, { error: 'Follower tier boundaries are fixed product rules.' });
    return;
  }

  if (pathname === '/api/backups' && method === 'GET') {
    if (!requireRole(user, ['admin'])) { json(response, 403, { error: 'عرض النسخ الاحتياطية متاح للمدير فقط.' }); return; }
    json(response, 200, {
      ...await getBackupSummary(),
      influencerExcel: await getInfluencerExcelSummary()
    });
    return;
  }

  if (pathname === '/api/backups/create' && method === 'POST') {
    const body = await readJson(request);
    const confirmation = await verifySensitiveConfirmation(request, user, body);
    if (!confirmation.ok) { json(response, confirmation.status, { error: confirmation.error }); return; }
    const result = await createBackup(true);
    json(response, 201, { ok: true, file: result.file });
    return;
  }

  if (pathname === '/api/backups/influencers/create' && method === 'POST') {
    const body = await readJson(request);
    const confirmation = await verifySensitiveConfirmation(request, user, body);
    if (!confirmation.ok) { json(response, confirmation.status, { error: confirmation.error }); return; }
    const result = await createInfluencerExcelBackup(true, auditResponseContexts.get(response));
    json(response, 200, {
      ok: true,
      created: result.created,
      path: result.path,
      recordCount: result.recordCount,
      lastSuccessAt: influencerExcelStatus.lastSuccessAt
    });
    return;
  }

  if (pathname === '/api/legacy-export' && method === 'POST') {
    const body = await readJson(request);
    const confirmation = await verifySensitiveConfirmation(request, user, body);
    if (!confirmation.ok) { json(response, confirmation.status, { error: confirmation.error }); return; }
    if (!Number.isSafeInteger(body.recordCount) || body.recordCount < 1 || body.recordCount > 100000) {
      json(response, 400, { error: 'عدد السجلات المطلوب تصديرها غير صالح.' });
      return;
    }
    json(response, 200, { ok: true });
    return;
  }

  if (pathname === '/api/influencers/meta' && method === 'GET') {
    json(response, 200, { stats: getInfluencerStats() });
    return;
  }

  const influencerStatusHistoryMatch = pathname.match(/^\/api\/influencers\/([^/]+)\/status-history$/);
  if (influencerStatusHistoryMatch && method === 'GET') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'سجل الحالة متاح للمدير والمحرر فقط.' }); return; }
    const id = decodeURIComponent(influencerStatusHistoryMatch[1]);
    if (!database.prepare('SELECT 1 FROM influencers WHERE id = ?').get(id)) {
      json(response, 404, { error: 'السجل غير موجود.' }); return;
    }
    const history = database.prepare(`SELECT previous_status AS previousStatus, status, reason,
        actor_username AS actorUsername, changed_at AS changedAt
      FROM influencer_status_history WHERE influencer_id = ? ORDER BY changed_at DESC, id DESC`).all(id);
    json(response, 200, { history });
    return;
  }

  const influencerStatusMatch = pathname.match(/^\/api\/influencers\/([^/]+)\/status$/);
  if (influencerStatusMatch && method === 'PATCH') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'تغيير الحالة متاح للمدير والمحرر فقط.' }); return; }
    const id = decodeURIComponent(influencerStatusMatch[1]);
    const body = await readJson(request);
    const nextStatus = body.status;
    if (!['Active', 'Inactive'].includes(nextStatus)) {
      json(response, 400, { error: 'حالة المعلن غير صالحة.' }); return;
    }
    const reason = String(body.reason || '').trim();
    if (nextStatus === 'Inactive' && !reason) {
      json(response, 400, { error: 'سبب تحويل المعلن إلى Inactive مطلوب.' }); return;
    }
    if (reason.length > 2000) { json(response, 400, { error: 'سبب الحالة يتجاوز 2000 حرف.' }); return; }
    const existing = database.prepare('SELECT record_json, archived_at FROM influencers WHERE id = ?').get(id);
    if (!existing) { json(response, 404, { error: 'السجل غير موجود.' }); return; }
    if (existing.archived_at) { json(response, 409, { error: 'أعد السجل من الأرشيف قبل تغيير حالته.' }); return; }
    const record = JSON.parse(existing.record_json);
    const previousStatus = record['Influencer Status'] === 'Inactive' ? 'Inactive' : 'Active';
    if (previousStatus === nextStatus) { json(response, 409, { error: 'الحالة الحالية مطابقة للحالة المطلوبة.' }); return; }
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      record['Influencer Status'] = nextStatus;
      saveInfluencer(id, record);
      database.prepare(`INSERT INTO influencer_status_history
        (id, influencer_id, previous_status, status, reason, actor_user_id, actor_username, changed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomBytes(16).toString('hex'), id, previousStatus, nextStatus, nextStatus === 'Inactive' ? reason : '',
          user.id, user.username, now);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 200, { record: { ...record, id }, changedAt: now });
    return;
  }

  const influencerNotesMatch = pathname.match(/^\/api\/influencers\/([^/]+)\/advertiser-notes(?:\/([^/]+))?$/);
  if (influencerNotesMatch) {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'ملاحظات المعلن متاحة للمدير والمحرر فقط.' }); return; }
    const [, rawInfluencerId, noteId] = influencerNotesMatch;
    const influencerId = decodeURIComponent(rawInfluencerId);
    if (!database.prepare('SELECT 1 FROM influencers WHERE id = ?').get(influencerId)) {
      json(response, 404, { error: 'السجل غير موجود.' }); return;
    }
    if (method === 'GET' && !noteId) {
      const notes = database.prepare(`SELECT id, note_text AS noteText, created_by_username AS createdBy,
          created_at AS createdAt, updated_by_username AS updatedBy, updated_at AS updatedAt
        FROM influencer_advertiser_notes WHERE influencer_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC`).all(influencerId);
      const history = database.prepare(`SELECT note_id AS noteId, action, previous_text AS previousText,
          note_text AS noteText, actor_username AS actorUsername, changed_at AS changedAt
        FROM influencer_advertiser_note_history WHERE influencer_id = ? ORDER BY changed_at DESC, id DESC`).all(influencerId);
      json(response, 200, { notes, history });
      return;
    }
    if (method === 'POST' && !noteId) {
      const body = await readJson(request);
      const noteText = String(body.noteText || '').trim();
      if (!noteText || noteText.length > 5000) { json(response, 400, { error: 'اكتب ملاحظة من 1 إلى 5000 حرف.' }); return; }
      const id = randomBytes(16).toString('hex');
      const now = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`INSERT INTO influencer_advertiser_notes
          (id, influencer_id, note_text, created_by_user_id, created_by_username, created_at,
           updated_by_user_id, updated_by_username, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, influencerId, noteText, user.id, user.username, now, user.id, user.username, now);
        database.prepare(`INSERT INTO influencer_advertiser_note_history
          (id, note_id, influencer_id, action, previous_text, note_text, actor_user_id, actor_username, changed_at)
          VALUES (?, ?, ?, 'created', '', ?, ?, ?, ?)`)
          .run(randomBytes(16).toString('hex'), id, influencerId, noteText, user.id, user.username, now);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      json(response, 201, { note: {
        id, noteText, createdBy: user.username, createdAt: now, updatedBy: user.username, updatedAt: now
      } });
      return;
    }
    if (noteId && ['PUT', 'DELETE'].includes(method)) {
      if (method === 'DELETE' && user.role !== 'admin') {
        json(response, 403, { error: 'حذف الملاحظات متاح للمدير فقط.' }); return;
      }
      const existing = database.prepare(`SELECT id, note_text FROM influencer_advertiser_notes
        WHERE id = ? AND influencer_id = ? AND deleted_at IS NULL`).get(noteId, influencerId);
      if (!existing) { json(response, 404, { error: 'الملاحظة غير موجودة.' }); return; }
      const now = new Date().toISOString();
      const noteText = method === 'PUT' ? String((await readJson(request)).noteText || '').trim() : '';
      if (method === 'PUT' && (!noteText || noteText.length > 5000)) {
        json(response, 400, { error: 'اكتب ملاحظة من 1 إلى 5000 حرف.' }); return;
      }
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`INSERT INTO influencer_advertiser_note_history
          (id, note_id, influencer_id, action, previous_text, note_text, actor_user_id, actor_username, changed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(randomBytes(16).toString('hex'), noteId, influencerId, method === 'PUT' ? 'updated' : 'deleted',
            existing.note_text, noteText, user.id, user.username, now);
        if (method === 'PUT') {
          database.prepare(`UPDATE influencer_advertiser_notes SET note_text = ?, updated_by_user_id = ?,
            updated_by_username = ?, updated_at = ? WHERE id = ? AND influencer_id = ? AND deleted_at IS NULL`)
            .run(noteText, user.id, user.username, now, noteId, influencerId);
        } else {
          database.prepare(`UPDATE influencer_advertiser_notes SET deleted_at = ?, deleted_by_user_id = ?
            WHERE id = ? AND influencer_id = ? AND deleted_at IS NULL`)
            .run(now, user.id, noteId, influencerId);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      json(response, 200, { ok: true, ...(method === 'PUT' ? { note: {
        id: noteId, noteText, updatedBy: user.username, updatedAt: now
      } } : {}) });
      return;
    }
  }

  const influencerRelationshipsMatch = pathname.match(/^\/api\/influencers\/([^/]+)\/relationships$/);
  if (influencerRelationshipsMatch && method === 'GET') {
    if (user.role !== 'admin') { json(response, 403, { error: 'مراجعة ارتباطات السجل متاحة للمدير فقط.' }); return; }
    const id = decodeURIComponent(influencerRelationshipsMatch[1]);
    if (!database.prepare('SELECT 1 FROM influencers WHERE id = ?').get(id)) {
      json(response, 404, { error: 'السجل غير موجود.' }); return;
    }
    const counts = {
      campaigns: Number(database.prepare('SELECT COUNT(*) AS count FROM campaign_targets WHERE influencer_id = ?').get(id).count),
      offers: Number(database.prepare('SELECT COUNT(*) AS count FROM client_catalog_items WHERE influencer_id = ?').get(id).count),
      visits: Number(database.prepare('SELECT COUNT(*) AS count FROM client_visits WHERE influencer_id = ?').get(id).count),
      clientDecisions: Number(database.prepare('SELECT COUNT(*) AS count FROM client_decision_history WHERE influencer_id = ?').get(id).count),
      inquiries: Number(database.prepare('SELECT COUNT(*) AS count FROM client_inquiries WHERE influencer_id = ?').get(id).count),
      followerHistory: Number(database.prepare('SELECT COUNT(*) AS count FROM influencer_follower_history WHERE influencer_id = ?').get(id).count),
      advertiserNotes: Number(database.prepare('SELECT COUNT(*) AS count FROM influencer_advertiser_notes WHERE influencer_id = ? AND deleted_at IS NULL').get(id).count)
    };
    json(response, 200, { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0) });
    return;
  }

  if (pathname === '/api/influencers/filter-options' && method === 'GET') {
    json(response, 200, { filters: getInfluencerFilterOptions() });
    return;
  }

  if (pathname === '/api/interests' && method === 'GET') {
    json(response, 200, {
      interests: database.prepare('SELECT id, name FROM interest_catalog ORDER BY name COLLATE NOCASE').all()
    });
    return;
  }

  if (pathname === '/api/interests' && method === 'POST') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'إضافة الاهتمامات متاحة للمدير والمحرر فقط.' }); return; }
    const body = await readJson(request);
    const { name, normalizedName } = validateInterestName(body.name);
    if (database.prepare('SELECT 1 FROM interest_catalog WHERE normalized_name = ?').get(normalizedName)) {
      json(response, 409, { error: 'هذا الاهتمام موجود بالفعل.' });
      return;
    }
    const id = randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    database.prepare('INSERT INTO interest_catalog (id, name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, normalizedName, now, now);
    refreshInterestNames(database.prepare('SELECT name FROM interest_catalog ORDER BY name COLLATE NOCASE').all().map((row) => row.name));
    json(response, 201, { interest: { id, name } });
    return;
  }

  const interestMatch = pathname.match(/^\/api\/interests\/([a-f0-9]{32})$/);
  if (interestMatch && method === 'PUT') {
    if (!requireRole(user, ['admin'])) { json(response, 403, { error: 'تعديل اسم اهتمام مركزي متاح للمدير فقط.' }); return; }
    const body = await readJson(request);
    const { name, normalizedName } = validateInterestName(body.name);
    const interest = renameInterest(interestMatch[1], name, normalizedName);
    json(response, 200, { interest });
    return;
  }

  if (pathname === '/api/influencers/by-ids' && method === 'POST') {
    if (!requireRole(user, ['admin', 'editor'])) {
      json(response, 403, { error: 'الوصول الجماعي إلى سجلات المعلنين متاح للمدير والمحرر فقط.' });
      return;
    }
    const body = await readJson(request);
    const maxIds = user.role === 'admin' ? 5000 : 50;
    if (!Array.isArray(body.ids) || body.ids.length > maxIds) {
      json(response, 400, { error: `قائمة المعرّفات غير صالحة أو تتجاوز ${maxIds} سجلًا في الطلب الواحد.` });
      return;
    }
    json(response, 200, getInfluencersByIds(body.ids));
    return;
  }

  if (pathname === '/api/influencers' && method === 'GET') {
    const scope = ['catalog', 'campaign', 'lookup'].includes(url.searchParams.get('scope'))
      ? url.searchParams.get('scope')
      : 'database';
    const params = new URLSearchParams(url.searchParams);
    if (params.get('status') === 'Archived' && user.role !== 'admin') params.set('status', '');
    const result = getInfluencerPage(params, scope, {
      defaultPageSize: scope === 'lookup' ? 20 : 50,
      maxPageSize: scope === 'lookup' ? 50 : 100
    });
    Object.assign(result, getInfluencerPageMetadata(result.rows, ['admin', 'editor'].includes(user.role)));
    json(response, 200, result);
    return;
  }

  if (pathname === '/api/influencers/export' && method === 'POST') {
    const body = await readJson(request);
    const confirmation = await verifySensitiveConfirmation(request, user, body);
    if (!confirmation.ok) { json(response, confirmation.status, { error: confirmation.error }); return; }
    const where = buildInfluencerWhere(url.searchParams);
    const rows = database.prepare(`SELECT i.id, i.record_json FROM influencers i ${where.sql}
      ORDER BY ${influencerSortOrder(url.searchParams.get('sort') || 'recent')}
    `).all(...where.values).map((row) => ({
      ...deriveMainAccountFields(JSON.parse(row.record_json)),
      id: row.id
    }));
    json(response, 200, { rows });
    return;
  }

  if (pathname === '/api/campaigns' && method === 'GET') {
    const summaries = campaignSummaries();
    json(response, 200, {
      campaigns: user.role === 'viewer'
        ? summaries.map((campaign) => ({ ...campaign, targets: campaign.targets.map((target) => ({
          ...target, recipientPhone: '', courierContact: '',
          deliveryAddress: '', deliveryMapLink: '', price: '', note: '', campaignPrice: '',
          operationsNotes: '', afterConfirmation: '', campaignInfluencerNote: '',
          contactStatus: '', participationStatus: ''
        })) }))
        : summaries
    });
    return;
  }

  const campaignInfluencerNoteMatch = pathname.match(/^\/api\/campaigns\/([a-f0-9]{32})\/influencer-notes\/([a-f0-9]{32})$/);
  if (campaignInfluencerNoteMatch) {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'الملاحظات الداخلية متاحة للمدير والمحرر فقط.' }); return; }
    const [, campaignId, influencerId] = campaignInfluencerNoteMatch;
    const target = database.prepare('SELECT 1 FROM campaign_targets WHERE campaign_id = ? AND influencer_id = ?').get(campaignId, influencerId);
    if (!target) { json(response, 404, { error: 'المؤثر غير مرتبط بهذه الحملة.' }); return; }
    if (method === 'PUT') {
      const body = await readJson(request);
      if (typeof body.noteText !== 'string' || body.noteText.length > 2000) {
        json(response, 400, { error: 'الملاحظة مطلوبة ويجب ألا تتجاوز 2000 حرف.' }); return;
      }
      const updatedAt = new Date().toISOString();
      database.prepare(`INSERT INTO campaign_influencer_notes (campaign_id, influencer_id, note_text, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(campaign_id, influencer_id) DO UPDATE SET
        note_text = excluded.note_text, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(campaignId, influencerId, body.noteText, user.id, updatedAt);
      json(response, 200, { note: { campaignId, influencerId, noteText: body.noteText, updatedAt } }); return;
    }
    if (method === 'DELETE') {
      database.prepare('DELETE FROM campaign_influencer_notes WHERE campaign_id = ? AND influencer_id = ?').run(campaignId, influencerId);
      json(response, 200, { ok: true }); return;
    }
    json(response, 405, { error: 'Method not allowed.' }); return;
  }

  const advertiserNotesMatch = pathname.match(/^\/api\/campaigns\/([a-f0-9]{32})\/advertiser-notes(?:\/([a-f0-9]{32}))?$/);
  if (advertiserNotesMatch) {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'ملاحظات المعلنين متاحة للمدير والمحرر فقط.' }); return; }
    const [, campaignId, noteId] = advertiserNotesMatch;
    const campaign = database.prepare('SELECT id, company_name AS companyName FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) { json(response, 404, { error: 'Campaign not found.' }); return; }
    if (method === 'GET' && !noteId) {
      const advertisers = database.prepare(`SELECT a.id, a.client_name AS clientName, a.company_name AS companyName
        FROM client_account_campaigns ac JOIN client_accounts a ON a.id = ac.account_id
        WHERE ac.campaign_id = ? ORDER BY a.company_name, a.client_name`).all(campaignId);
      const notes = database.prepare(`SELECT n.id, n.client_account_id AS clientAccountId, n.advertiser_key AS advertiserKey,
        n.advertiser_name AS advertiserName, n.note_text AS noteText, n.updated_at AS updatedAt,
        EXISTS (SELECT 1 FROM client_account_campaigns ac WHERE ac.campaign_id = n.campaign_id AND ac.account_id = n.client_account_id) AS linked
        FROM campaign_advertiser_notes n WHERE n.campaign_id = ? ORDER BY n.advertiser_name`).all(campaignId)
        .map((note) => ({ ...note, linked: Boolean(note.linked) }));
      json(response, 200, { advertisers, notes, campaignName: campaign.companyName }); return;
    }
    if (method === 'POST' && !noteId) {
      const body = await readJson(request);
      const clientAccountId = body.clientAccountId ? String(body.clientAccountId) : null;
      const noteText = String(body.noteText || '');
      if (noteText.length > 20000) { json(response, 400, { error: 'ملاحظات المعلن تتجاوز 20000 حرف.' }); return; }
      let advertiserName = campaign.companyName;
      let advertiserKey = 'campaign';
      if (clientAccountId) {
        const account = database.prepare(`SELECT a.company_name AS companyName FROM client_account_campaigns ac
          JOIN client_accounts a ON a.id = ac.account_id WHERE ac.campaign_id = ? AND ac.account_id = ?`).get(campaignId, clientAccountId);
        if (!account) { json(response, 400, { error: 'المعلن غير مرتبط بهذه الحملة.' }); return; }
        advertiserName = account.companyName; advertiserKey = `account:${clientAccountId}`;
      }
      const existing = database.prepare(`SELECT id FROM campaign_advertiser_notes WHERE campaign_id = ? AND advertiser_key = ?`).get(campaignId, advertiserKey);
      const updatedAt = new Date().toISOString();
      if (existing) {
        database.prepare(`UPDATE campaign_advertiser_notes SET note_text = ?, updated_by = ?, updated_at = ? WHERE id = ? AND campaign_id = ?`)
          .run(noteText, user.id, updatedAt, existing.id, campaignId);
        json(response, 200, { note: { id: existing.id, clientAccountId, advertiserKey, advertiserName, noteText, updatedAt } }); return;
      }
      const id = randomBytes(16).toString('hex');
      database.prepare(`INSERT INTO campaign_advertiser_notes
        (id, campaign_id, client_account_id, advertiser_key, advertiser_name, note_text, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, campaignId, clientAccountId, advertiserKey, advertiserName, noteText, user.id, updatedAt);
      json(response, 201, { note: { id, clientAccountId, advertiserKey, advertiserName, noteText, updatedAt } }); return;
    }
    const savedNote = noteId ? database.prepare(`SELECT id, client_account_id AS clientAccountId, advertiser_key AS advertiserKey,
      advertiser_name AS advertiserName, note_text AS noteText, updated_at AS updatedAt FROM campaign_advertiser_notes
      WHERE id = ? AND campaign_id = ?`).get(noteId, campaignId) : null;
    if (noteId && !savedNote) { json(response, 404, { error: 'Advertiser note not found.' }); return; }
    if (method === 'PATCH' && savedNote) {
      const body = await readJson(request); const noteText = String(body.noteText || '');
      if (noteText.length > 20000) { json(response, 400, { error: 'ملاحظات المعلن تتجاوز 20000 حرف.' }); return; }
      const updatedAt = new Date().toISOString();
      database.prepare(`UPDATE campaign_advertiser_notes SET note_text = ?, updated_by = ?, updated_at = ? WHERE id = ? AND campaign_id = ?`)
        .run(noteText, user.id, updatedAt, noteId, campaignId);
      json(response, 200, { note: { ...savedNote, noteText, updatedAt } }); return;
    }
    json(response, 405, { error: 'Method not allowed.' }); return;
  }

  const briefMatch = pathname.match(/^\/api\/campaigns\/([a-f0-9]{32})\/briefs(?:\/([a-f0-9]{32}))?$/);
  if (briefMatch) {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'Briefs are available to administrators and editors only.' }); return; }
    const [, campaignId, briefId] = briefMatch;
    const campaign = database.prepare('SELECT id, company_name AS companyName FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) { json(response, 404, { error: 'Campaign not found.' }); return; }
    if (method === 'GET' && !briefId) {
      const now = new Date().toISOString();
      const linked = database.prepare(`SELECT a.id, a.company_name AS companyName FROM client_account_campaigns ac
        JOIN client_accounts a ON a.id = ac.account_id WHERE ac.campaign_id = ? ORDER BY a.company_name, a.client_name`).all(campaignId);
      const insert = database.prepare(`INSERT INTO campaign_briefs (id, campaign_id, client_account_id, advertiser_name, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const account of linked) {
        const existing = database.prepare('SELECT 1 FROM campaign_briefs WHERE campaign_id = ? AND client_account_id = ?').get(campaignId, account.id);
        if (!existing) database.prepare(`INSERT INTO campaign_briefs
          (id, campaign_id, client_account_id, advertiser_name, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', ?, ?)`)
          .run(randomBytes(16).toString('hex'), campaignId, account.id, account.companyName, now, now);
      }
      const legacy = database.prepare('SELECT content_json AS contentJson FROM campaign_workspaces WHERE campaign_id = ?').get(campaignId);
      const old = legacy ? JSON.parse(legacy.contentJson) : {};
      const oldText = [old.briefAr, old.briefEn, old.creatorBriefAr, old.creatorBriefEn, old.instructionsAr, old.instructionsEn].filter(Boolean).join('\n\n');
      if (oldText && !database.prepare('SELECT 1 FROM campaign_briefs WHERE campaign_id = ? AND advertiser_name = ?').get(campaignId, `${campaign.companyName} · Legacy brief`)) {
        insert.run(randomBytes(16).toString('hex'), campaignId, null, `${campaign.companyName} · Legacy brief`, JSON.stringify({
          _legacyContent: old, instructions: old.instructionsAr || old.instructionsEn || '', script: [old.briefAr, old.briefEn, old.creatorBriefAr, old.creatorBriefEn].filter(Boolean).join('\n\n')
        }), now, now);
      }
      const briefRows = database.prepare(`SELECT id, client_account_id AS clientAccountId, advertiser_name AS advertiserName,
        content_json AS contentJson, created_at AS createdAt, updated_at AS updatedAt FROM campaign_briefs WHERE campaign_id = ? AND archived = 0 ORDER BY created_at, advertiser_name`).all(campaignId);
      let briefs = briefRows.map((row) => {
        const content = JSON.parse(row.contentJson);
        if (!Object.prototype.hasOwnProperty.call(content, 'body')) {
          const legacyLines = Object.entries(content)
            .filter(([key, value]) => key !== '_legacyContent' && value !== null && value !== undefined && value !== '')
            .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
          if (!legacyLines.length && content._legacyContent) legacyLines.push(JSON.stringify(content._legacyContent, null, 2));
          content.body = legacyLines.join('\n\n');
          const updatedAt = new Date().toISOString();
          database.prepare('UPDATE campaign_briefs SET content_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(content), updatedAt, row.id);
          row.updatedAt = updatedAt;
        }
        return { ...row, content };
      });
      if (!briefs.length && !database.prepare('SELECT 1 FROM campaign_briefs WHERE campaign_id = ?').get(campaignId)) {
        const id = randomBytes(16).toString('hex');
        database.prepare(`INSERT INTO campaign_briefs (id, campaign_id, advertiser_name, content_json, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)`)
          .run(id, campaignId, campaign.companyName, now, now);
        briefs = [{ id, clientAccountId: null, advertiserName: campaign.companyName, content: {}, createdAt: now, updatedAt: now }];
      }
      json(response, 200, { briefs }); return;
    }
    if (method === 'POST' && !briefId) {
      const body = await readJson(request); const advertiserName = String(body.advertiserName || '').trim() || 'بريف جديد';
      const accountId = body.clientAccountId ? String(body.clientAccountId) : null;
      if (advertiserName.length > 150) { json(response, 400, { error: 'Brief title must be 150 characters or fewer.' }); return; }
      if (accountId && !database.prepare('SELECT 1 FROM client_account_campaigns WHERE campaign_id = ? AND account_id = ?').get(campaignId, accountId)) { json(response, 400, { error: 'Advertiser is not linked to this campaign.' }); return; }
      const now = new Date().toISOString(); const id = randomBytes(16).toString('hex');
      database.prepare(`INSERT INTO campaign_briefs (id, campaign_id, client_account_id, advertiser_name, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, '{"body":""}', ?, ?)`)
        .run(id, campaignId, accountId, advertiserName, now, now);
      json(response, 201, { brief: { id, clientAccountId: accountId, advertiserName, content: { body: '' }, updatedAt: now } }); return;
    }
    const brief = briefId ? database.prepare(`SELECT id, client_account_id AS clientAccountId, advertiser_name AS advertiserName,
      content_json AS contentJson FROM campaign_briefs WHERE id = ? AND campaign_id = ? AND archived = 0`).get(briefId, campaignId) : null;
    if (briefId && !brief) { json(response, 404, { error: 'Brief not found.' }); return; }
    if (method === 'PATCH' && brief) {
      const body = await readJson(request); const updates = body.content === undefined ? {} : body.content;
      if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.keys(updates).length > 40) { json(response, 400, { error: 'Invalid brief content.' }); return; }
      const advertiserName = body.advertiserName === undefined ? brief.advertiserName : String(body.advertiserName).trim();
      if (advertiserName.length > 150) { json(response, 400, { error: 'Brief title must be 150 characters or fewer.' }); return; }
      for (const [key, value] of Object.entries(updates)) {
        const maximum = key === 'body' ? 1_200_000 : 30000;
        if (!/^[a-zA-Z][\w-]{0,50}$/.test(key) || typeof value !== 'string' || value.length > maximum) { json(response, 400, { error: `Brief fields must be text up to ${maximum} characters.` }); return; }
        if (key === 'googleMapsLink' && value) { let url; try { url = new URL(value); } catch {} if (!url || !['http:', 'https:'].includes(url.protocol)) { json(response, 400, { error: 'Google Maps link must be a valid HTTP or HTTPS URL.' }); return; } }
      }
      const content = { ...JSON.parse(brief.contentJson), ...updates };
      const updatedAt = new Date().toISOString();
      database.prepare('UPDATE campaign_briefs SET advertiser_name = ?, content_json = ?, updated_at = ? WHERE id = ? AND campaign_id = ?')
        .run(advertiserName, JSON.stringify(content), updatedAt, briefId, campaignId);
      json(response, 200, { brief: { id: brief.id, clientAccountId: brief.clientAccountId, advertiserName, content, updatedAt } }); return;
    }
    if (method === 'DELETE' && brief) { database.prepare('UPDATE campaign_briefs SET archived = 1, updated_at = ? WHERE id = ? AND campaign_id = ?').run(new Date().toISOString(), briefId, campaignId); json(response, 200, { ok: true }); return; }
    json(response, 405, { error: 'Method not allowed.' }); return;
  }

  const workspaceMatch = pathname.match(/^\/api\/campaigns\/([a-f0-9]{32})\/workspace(?:\/(files|evidence)(?:\/([a-f0-9]{32}))?)?$/);
  if (workspaceMatch) {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'مساحة الحملة متاحة للمدير والمحرر فقط.' }); return; }
    const [, campaignId, collection, fileId] = workspaceMatch;
    const campaign = database.prepare('SELECT id FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) { json(response, 404, { error: 'الكامبين غير موجود.' }); return; }
    const fileKind = collection === 'evidence' ? 'evidence' : 'attachment';
    if (fileId && method === 'GET') {
      const file = database.prepare(`SELECT file_name, mime_type, file_data FROM campaign_internal_files
        WHERE id = ? AND campaign_id = ? AND kind = ?`).get(fileId, campaignId, fileKind);
      if (!file) { json(response, 404, { error: 'الملف غير موجود.' }); return; }
      const data = Buffer.from(file.file_data);
      response.writeHead(200, { 'Content-Type': file.mime_type, 'Content-Length': data.length,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.file_name)}`, 'X-Content-Type-Options': 'nosniff' });
      response.end(data);
      return;
    }
    if (fileId && method === 'DELETE') {
      const deleted = database.prepare('DELETE FROM campaign_internal_files WHERE id = ? AND campaign_id = ? AND kind = ?').run(fileId, campaignId, fileKind);
      if (!deleted.changes) { json(response, 404, { error: 'الملف غير موجود.' }); return; }
      json(response, 200, { ok: true });
      return;
    }
    if (!collection && method === 'GET') {
      const saved = database.prepare('SELECT content_json AS contentJson, updated_at AS updatedAt FROM campaign_workspaces WHERE campaign_id = ?').get(campaignId);
      const files = database.prepare(`SELECT id, campaign_id, kind, platform, phase, capture_date, note,
        file_name, mime_type, created_at FROM campaign_internal_files WHERE campaign_id = ? ORDER BY created_at DESC`).all(campaignId);
      const content = saved ? JSON.parse(saved.contentJson) : {};
      let migrated = false;
      if (!Array.isArray(content.invitationCards)) {
        const invitationParts = [
          ['عنوان الدعوة', content.invitationTitle], ['نص الدعوة', content.invitationBody],
          ['تفاصيل التعاون', content.invitationDetails], ['ملاحظات إضافية', content.invitationNotes],
          ['الدعوة بالعربية', content.invitationAr], ['Invitation in English', content.invitationEn]
        ].filter(([, value]) => typeof value === 'string' && value.length);
        content.invitationCards = invitationParts.length ? [{
          id: randomBytes(16).toString('hex'), title: content.invitationTitle || 'الدعوة السابقة',
          body: invitationParts.map(([label, value]) => `${label}:\n${value}`).join('\n\n')
        }] : [];
        migrated = true;
      }
      if (!Array.isArray(content.afterConfirmationCards)) {
        const instructionParts = [
          ['تعليمات ما بعد التأكيد بالعربية', content.afterConfirmationAr],
          ['After Confirmation instructions', content.afterConfirmationEn],
          ['التعليمات السابقة', content.instructionsAr], ['Previous instructions', content.instructionsEn]
        ].filter(([, value]) => typeof value === 'string' && value.length);
        const cards = instructionParts.length ? [{
          id: randomBytes(16).toString('hex'), title: 'التعليمات العامة السابقة',
          body: instructionParts.map(([label, value]) => `${label}:\n${value}`).join('\n\n')
        }] : [];
        const legacyTargets = database.prepare(`SELECT ct.influencer_id AS influencerId, ct.after_confirmation AS body,
          json_extract(i.record_json, '$.Name') AS name
          FROM campaign_targets ct JOIN influencers i ON i.id = ct.influencer_id
          WHERE ct.campaign_id = ? AND ct.after_confirmation <> '' ORDER BY ct.position`).all(campaignId);
        for (const target of legacyTargets) cards.push({
          id: randomBytes(16).toString('hex'), title: target.name || 'تعليمات مؤثر سابقة', body: target.body
        });
        content.afterConfirmationCards = cards;
        migrated = true;
      }
      let updatedAt = saved?.updatedAt || '';
      if (migrated) {
        updatedAt = new Date().toISOString();
        database.prepare(`INSERT INTO campaign_workspaces (campaign_id, content_json, updated_by, updated_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(campaign_id) DO UPDATE SET content_json = excluded.content_json,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(campaignId, JSON.stringify(content), user.id, updatedAt);
      }
      json(response, 200, { content, updatedAt, files: files.map(presentationFileInfo) });
      return;
    }
    if (!collection && method === 'PATCH') {
      const body = await readJson(request);
      const keys = ['briefAr', 'briefEn', 'invitationAr', 'invitationEn', 'creatorBriefAr', 'creatorBriefEn', 'afterConfirmationAr', 'afterConfirmationEn', 'instructionsAr', 'instructionsEn', 'invitationTitle', 'invitationBody', 'invitationDetails', 'invitationNotes'];
      const existing = database.prepare('SELECT content_json AS contentJson FROM campaign_workspaces WHERE campaign_id = ?').get(campaignId);
      const content = existing ? JSON.parse(existing.contentJson) : {};
      for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(body.content || {}, key)) continue;
        const value = String(body.content?.[key] || '');
        if (value.length > 20000) { json(response, 400, { error: 'النصوص يجب ألا تتجاوز 20000 حرف لكل حقل.' }); return; }
        content[key] = value;
      }
      for (const key of ['invitationCards', 'afterConfirmationCards']) {
        if (!Object.prototype.hasOwnProperty.call(body.content || {}, key)) continue;
        const incoming = body.content[key];
        if (!Array.isArray(incoming)) { json(response, 400, { error: 'قائمة البطاقات غير صالحة.' }); return; }
        const ids = new Set();
        const cards = [];
        for (const card of incoming) {
          if (!card || typeof card !== 'object' || Array.isArray(card)
            || typeof card.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(card.id) || ids.has(card.id)
            || typeof card.title !== 'string' || card.title.length > 150
            || typeof card.body !== 'string' || card.body.length > 100000) {
            json(response, 400, { error: 'عنوان البطاقة يجب ألا يتجاوز 150 حرفًا ونصها 100000 حرف.' }); return;
          }
          ids.add(card.id);
          cards.push({ id: card.id, title: card.title, body: card.body });
        }
        content[key] = cards;
      }
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO campaign_workspaces (campaign_id, content_json, updated_by, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(campaign_id) DO UPDATE SET content_json = excluded.content_json,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(campaignId, JSON.stringify(content), user.id, now);
      json(response, 200, { content, updatedAt: now });
      return;
    }
    if (collection && method === 'POST' && !fileId) {
      const body = await readJson(request);
      const fileName = String(body.fileName || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').slice(0, 180);
      const mimeType = String(body.mimeType || '').toLowerCase();
      const encoded = String(body.dataBase64 || '');
      if (!fileName || encoded.length > 4_200_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        json(response, 400, { error: 'الملف غير صالح أو يتجاوز 3 ميجابايت.' }); return;
      }
      const bytes = Buffer.from(encoded, 'base64');
      const signature = bytes.subarray(0, 12).toString('hex');
      const validImage = (mimeType === 'image/png' && signature.startsWith('89504e47'))
        || (mimeType === 'image/jpeg' && signature.startsWith('ffd8ff'))
        || (mimeType === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
      const validPdf = mimeType === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-';
      if (!bytes.length || bytes.length > 3 * 1024 * 1024 || !(validImage || (fileKind === 'attachment' && validPdf))) {
        json(response, 400, { error: 'يسمح بصور PNG أو JPG أو WebP، وبملفات PDF للمرفقات فقط، حتى 3 ميجابايت.' }); return;
      }
      const platform = String(body.platform || '');
      const phase = String(body.phase || '');
      const captureDate = String(body.captureDate || '');
      const note = String(body.note || '').slice(0, 2000);
      const captureTimestamp = Date.parse(`${captureDate}T00:00:00Z`);
      if (fileKind === 'evidence' && (!['Instagram', 'TikTok'].includes(platform) || !['before', 'after'].includes(phase)
          || (captureDate && (!/^\d{4}-\d{2}-\d{2}$/.test(captureDate) || !Number.isFinite(captureTimestamp)
            || new Date(captureTimestamp).toISOString().slice(0, 10) !== captureDate)))) {
        json(response, 400, { error: 'بيانات صورة Before/After غير صالحة.' }); return;
      }
      const id = randomBytes(16).toString('hex');
      const createdAt = new Date().toISOString();
      database.prepare(`INSERT INTO campaign_internal_files
        (id, campaign_id, kind, platform, phase, capture_date, note, file_name, mime_type, file_data, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, campaignId, fileKind, fileKind === 'evidence' ? platform : null,
          fileKind === 'evidence' ? phase : null, captureDate || null, note, fileName, mimeType, bytes, user.id, createdAt);
      json(response, 201, { file: presentationFileInfo({ id, campaign_id: campaignId, kind: fileKind,
        platform, phase, capture_date: captureDate, note, file_name: fileName, mime_type: mimeType, created_at: createdAt }) });
      return;
    }
    json(response, 405, { error: 'العملية غير مدعومة.' });
    return;
  }

  const presentationsMatch = pathname.match(/^\/api\/campaigns\/([a-f0-9]{32})\/presentations(?:\/([a-f0-9]{32})(?:\/(reissue))?)?$/);
  if (presentationsMatch) {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'إدارة عروض مواعيد العميل متاحة للمدير والمحرر فقط.' }); return; }
    const [, campaignId, presentationId, action] = presentationsMatch;
    const campaign = database.prepare('SELECT id, campaign_name AS campaignName, execution_mode AS executionMode FROM campaigns WHERE id = ?').get(campaignId);
    if (!campaign) { json(response, 404, { error: 'الكامبين غير موجود.' }); return; }
    if (!['visit', 'mix'].includes(campaign.executionMode)) { json(response, 409, { error: 'عرض مواعيد العميل متاح لحملات الزيارة أو الميكس فقط.' }); return; }
    if (!presentationId && method === 'GET') {
      const rows = database.prepare(`SELECT p.id, p.client_account_id AS clientAccountId, p.active,
          p.fields_json AS fieldsJson, p.created_at AS createdAt, p.updated_at AS updatedAt,
          p.brand_id AS brandId, p.brand_snapshot_json AS brandSnapshotJson,
          p.presentation_mode AS presentationMode, p.header_title AS headerTitle,
          p.header_tagline AS headerTagline, p.package_visits_count AS packageVisitsCount,
          EXISTS(SELECT 1 FROM campaign_presentation_client_logos logo
            WHERE logo.presentation_id = p.id) AS hasClientLogo,
          a.client_name AS clientName
        FROM campaign_presentations p JOIN client_accounts a ON a.id = p.client_account_id
        WHERE p.campaign_id = ? ORDER BY p.created_at DESC`).all(campaignId);
      json(response, 200, { presentations: rows.map((row) => ({ id: row.id,
        clientAccountId: row.clientAccountId, clientName: row.clientName, active: Boolean(row.active),
        brandId: row.brandId, brand: getBrandSnapshot(row),
        presentationMode: row.presentationMode, headerTitle: row.headerTitle,
        headerTagline: row.headerTagline, packageVisitsCount: row.packageVisitsCount,
        hasClientLogo: Boolean(row.hasClientLogo),
        fields: JSON.parse(row.fieldsJson || '[]'), createdAt: row.createdAt, updatedAt: row.updatedAt,
        displayOptions: presentationDisplayOptions(row.id),
        companyWorkVideoIds: database.prepare('SELECT video_id AS id FROM campaign_presentation_work_videos WHERE presentation_id = ? ORDER BY position')
          .all(row.id).map((item) => item.id),
        videoReferences: presentationVideos(row.id).map((video) => ({ id: video.id, videoId: video.videoId, title: video.title, url: video.url })),
        influencerIds: database.prepare('SELECT influencer_id AS id FROM campaign_presentation_targets WHERE presentation_id = ? ORDER BY position').all(row.id).map((item) => item.id),
        influencerCount: Number(database.prepare('SELECT COUNT(*) AS count FROM campaign_presentation_targets WHERE presentation_id = ?').get(row.id).count) })) });
      return;
    }
    if (!presentationId && method === 'POST') {
      const body = await readJson(request);
      const brandId = String(body.brandId || '');
      const brand = getBrandSettings(brandId);
      if (!brand) { json(response, 400, { error: 'اختر هوية تجارية صالحة قبل إنشاء العرض.' }); return; }
      let settings;
      let clientLogo;
      try {
        settings = validatePresentationSettings(body);
        clientLogo = body.clientLogo === undefined ? undefined : validateClientLogo(body.clientLogo);
      } catch (error) { json(response, error.status || 400, { error: error.message }); return; }
      if (settings.mode === 'selecting' && body.packageVisitsCount !== undefined && body.packageVisitsCount !== null && body.packageVisitsCount !== '') {
        json(response, 400, { error: 'مؤشر الباقة متاح في وضع الزيارات فقط.' }); return;
      }
      const clientAccountId = String(body.clientAccountId || '');
      const account = database.prepare(`SELECT a.id FROM client_accounts a
        JOIN client_account_campaigns ac ON ac.account_id = a.id AND ac.campaign_id = ?
        WHERE a.id = ? AND a.active = 1 AND a.client_type = 'current'`).get(campaignId, clientAccountId);
      if (!account) { json(response, 400, { error: 'اربط الكامبين بحساب عميل حالي قبل إنشاء العرض.' }); return; }
      const influencerIds = Array.isArray(body.influencerIds) ? [...new Set(body.influencerIds.filter((id) => typeof id === 'string'))] : [];
      if (!influencerIds.length || influencerIds.length > 500) { json(response, 400, { error: 'اختر من مؤثر واحد إلى 500 مؤثر للعرض.' }); return; }
      const fields = Array.isArray(body.fields) ? [...new Set(body.fields.filter((field) => presentationFieldKeys.has(field)))] : [];
      if (!fields.includes('name') || !fields.some((field) => ['visitDate', 'visitTime', 'visitCity', 'visitBranch', 'visitAddress'].includes(field))) {
        json(response, 400, { error: 'يجب عرض اسم المؤثر وموعد زيارة واحد على الأقل.' }); return;
      }
      let videos;
      let displayOptions;
      let companyWorkVideoIds;
      try {
        videos = validatePresentationVideos(body.videoReferences ?? []);
        displayOptions = validatePresentationDisplayOptions(body.displayOptions);
        companyWorkVideoIds = validateCompanyWorkVideoIds(body.companyWorkVideoIds ?? []);
      }
      catch (error) { json(response, error.status || 400, { error: error.message }); return; }
      if (brandId === 'ryfaq' && (videos.length || displayOptions.showCompanyWork || companyWorkVideoIds.length)) {
        json(response, 400, { error: 'مراجع وأعمال فكرتك غير متاحة في عروض رفاق.' }); return;
      }
      const visitIds = new Set(database.prepare(`SELECT influencer_id FROM campaign_targets
        WHERE campaign_id = ? AND execution_type = 'visit'`).all(campaignId).map((row) => row.influencer_id));
      if (influencerIds.some((id) => !visitIds.has(id))) { json(response, 400, { error: 'يحتوي الاختيار على مؤثر غير مجدول للزيارة في هذه الكامبين.' }); return; }
      const id = randomBytes(16).toString('hex');
      const token = randomBytes(32).toString('base64url');
      const now = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`INSERT INTO campaign_presentations
          (id, campaign_id, client_account_id, token_hash, fields_json, active, created_by, created_at, updated_at,
           brand_id, brand_snapshot_json, presentation_mode, header_title, header_tagline, package_visits_count)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, campaignId, clientAccountId, tokenHash(token), JSON.stringify(fields), user.id, now, now,
            brandId, JSON.stringify(brand), settings.mode, settings.title, settings.tagline, settings.packageVisitsCount);
        const insert = database.prepare(`INSERT INTO campaign_presentation_targets
          (presentation_id, campaign_id, influencer_id, position) VALUES (?, ?, ?, ?)`);
        influencerIds.forEach((influencerId, position) => insert.run(id, campaignId, influencerId, position));
        savePresentationVideos(id, videos);
        savePresentationDisplayOptions(id, displayOptions);
        savePresentationCompanyWorkVideos(id, companyWorkVideoIds);
        savePresentationClientLogo(id, clientLogo, now);
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      json(response, 201, { id, token, url: `/campaign-presentation/${token}` });
      return;
    }
    const presentation = presentationId ? database.prepare(`SELECT id, active, brand_id AS brandId
      FROM campaign_presentations WHERE id = ? AND campaign_id = ?`).get(presentationId, campaignId) : null;
    if (presentationId && !presentation) { json(response, 404, { error: 'العرض غير موجود لهذه الكامبين.' }); return; }
    if (action === 'reissue' && method === 'POST') {
      const token = randomBytes(32).toString('base64url');
      database.prepare('UPDATE campaign_presentations SET token_hash = ?, active = 1, updated_at = ? WHERE id = ?')
        .run(tokenHash(token), new Date().toISOString(), presentationId);
      json(response, 200, { id: presentationId, token, url: `/campaign-presentation/${token}` });
      return;
    }
    if (presentationId && method === 'PATCH') {
      const body = await readJson(request);
      let videos;
      let displayOptions;
      let companyWorkVideoIds;
      let settings;
      let clientLogo;
      const currentCompanyWorkVideoIds = database.prepare(`SELECT video_id AS id
        FROM campaign_presentation_work_videos WHERE presentation_id = ? ORDER BY position`)
        .all(presentationId).map((row) => row.id);
      const current = database.prepare(`SELECT fields_json AS fieldsJson, client_account_id AS clientAccountId,
          presentation_mode AS presentationMode, header_title AS headerTitle,
          header_tagline AS headerTagline, package_visits_count AS packageVisitsCount
        FROM campaign_presentations WHERE id = ?`).get(presentationId);
      try {
        if (body.videoReferences !== undefined) videos = validatePresentationVideos(body.videoReferences);
        if (body.companyWorkVideoIds !== undefined) {
          companyWorkVideoIds = validateCompanyWorkVideoIds(body.companyWorkVideoIds, currentCompanyWorkVideoIds);
        }
        settings = validatePresentationSettings(body, current);
        if (body.clientLogo !== undefined) clientLogo = validateClientLogo(body.clientLogo);
      } catch (error) { json(response, error.status || 400, { error: error.message }); return; }
      if (settings.mode === 'selecting' && body.packageVisitsCount !== undefined && body.packageVisitsCount !== null && body.packageVisitsCount !== '') {
        json(response, 400, { error: 'مؤشر الباقة متاح في وضع الزيارات فقط.' }); return;
      }
      if (presentation.brandId === 'ryfaq' && (
        (videos?.length ?? 0) > 0 || (companyWorkVideoIds?.length ?? currentCompanyWorkVideoIds.length) > 0
        || body.displayOptions?.showCompanyWork === true
      )) {
        json(response, 400, { error: 'مراجع وأعمال فكرتك غير متاحة في عروض رفاق.' }); return;
      }
      try {
        displayOptions = validatePresentationDisplayOptions(body.displayOptions, presentationDisplayOptions(presentationId));
      } catch (error) { json(response, error.status || 400, { error: error.message }); return; }
      const updateTargets = body.fields !== undefined || body.influencerIds !== undefined || body.clientAccountId !== undefined;
      let fields = JSON.parse(current.fieldsJson || '[]');
      let influencerIds = database.prepare('SELECT influencer_id AS id FROM campaign_presentation_targets WHERE presentation_id = ? ORDER BY position').all(presentationId).map((row) => row.id);
      let nextAccountId = current.clientAccountId;
      if (updateTargets) {
        fields = body.fields === undefined ? fields : [...new Set((Array.isArray(body.fields) ? body.fields : []).filter((field) => presentationFieldKeys.has(field)))];
        influencerIds = body.influencerIds === undefined
          ? database.prepare('SELECT influencer_id AS id FROM campaign_presentation_targets WHERE presentation_id = ? ORDER BY position').all(presentationId).map((row) => row.id)
          : [...new Set((Array.isArray(body.influencerIds) ? body.influencerIds : []).filter((id) => typeof id === 'string'))];
        const visitIds = new Set(database.prepare(`SELECT influencer_id FROM campaign_targets WHERE campaign_id = ? AND execution_type = 'visit'`).all(campaignId).map((row) => row.influencer_id));
        if (!fields.includes('name') || !fields.some((field) => ['visitDate', 'visitTime', 'visitCity', 'visitBranch', 'visitAddress'].includes(field)) || !influencerIds.length || influencerIds.length > 500 || influencerIds.some((id) => !visitIds.has(id))) {
          json(response, 400, { error: 'اختيارات العرض غير صالحة.' }); return;
        }
        if (body.clientAccountId !== undefined) {
          nextAccountId = String(body.clientAccountId || '');
          const nextAccount = database.prepare(`SELECT a.id FROM client_accounts a
            JOIN client_account_campaigns ac ON ac.account_id = a.id AND ac.campaign_id = ?
            WHERE a.id = ? AND a.active = 1 AND a.client_type = 'current'`).get(campaignId, nextAccountId);
          if (!nextAccount) { json(response, 400, { error: 'العميل المحدد غير مرتبط بهذه الكامبين.' }); return; }
        }
      }
      const now = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`UPDATE campaign_presentations SET active = COALESCE(?, active),
          client_account_id = ?, fields_json = ?, presentation_mode = ?, header_title = ?,
          header_tagline = ?, package_visits_count = ?, updated_at = ? WHERE id = ?`)
          .run(body.active === undefined ? null : body.active ? 1 : 0, nextAccountId,
            JSON.stringify(fields), settings.mode, settings.title, settings.tagline,
            settings.packageVisitsCount, now, presentationId);
        if (updateTargets) {
          database.prepare('DELETE FROM campaign_presentation_targets WHERE presentation_id = ?').run(presentationId);
          const insert = database.prepare('INSERT INTO campaign_presentation_targets (presentation_id, campaign_id, influencer_id, position) VALUES (?, ?, ?, ?)');
          influencerIds.forEach((influencerId, position) => insert.run(presentationId, campaignId, influencerId, position));
        }
        if (videos) savePresentationVideos(presentationId, videos);
        savePresentationDisplayOptions(presentationId, displayOptions);
        if (companyWorkVideoIds !== undefined) savePresentationCompanyWorkVideos(presentationId, companyWorkVideoIds);
        savePresentationClientLogo(presentationId, clientLogo, now);
        database.exec('COMMIT');
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      json(response, 200, { id: presentationId, active: Boolean(database.prepare('SELECT active FROM campaign_presentations WHERE id = ?').get(presentationId).active) });
      return;
    }
    if (presentationId && method === 'DELETE') {
      if (user.role !== 'admin') { json(response, 403, { error: 'حذف عروض العملاء متاح للمدير فقط.' }); return; }
      database.exec('BEGIN IMMEDIATE');
      try {
        const deleted = database.prepare('DELETE FROM campaign_presentations WHERE id = ? AND campaign_id = ?')
          .run(presentationId, campaignId);
        if (deleted.changes !== 1) throw Object.assign(new Error('العرض لم يعد موجودًا؛ حدّث القائمة وحاول مجددًا.'), { status: 404 });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      json(response, 200, { ok: true, id: presentationId });
      return;
    }
    json(response, 405, { error: 'العملية غير مدعومة.' });
    return;
  }

  const clientVisitRoute = pathname.match(/^\/api\/client-accounts\/([a-f0-9]{32})\/visits(?:\/(import-preview|import-confirm|publish|unpublish|influencer-search|([a-f0-9]{32})))?$/);
  if (clientVisitRoute) {
    if (!requireRole(user, ['admin', 'editor'])) {
      json(response, 403, { error: 'إدارة جداول الزيارات متاحة للمدير والمحرر فقط.' }); return;
    }
    const accountId = clientVisitRoute[1];
    const action = clientVisitRoute[2] || '';
    const visitId = clientVisitRoute[3] || '';
    const account = database.prepare(`SELECT id, display_mode AS displayMode, client_type AS clientType
      FROM client_accounts WHERE id = ?`).get(accountId);
    if (!account) { json(response, 404, { error: 'حساب العميل غير موجود.' }); return; }
    if (displayModeFor(account) !== 'existing') {
      json(response, 409, {
        error: 'تُدار الزيارات للعملاء الموجودين فقط. غيّر «طريقة عرض العميل» أولًا ثم أعد فتح جدول الزيارات.',
        displayMode: displayModeFor(account)
      }); return;
    }

    if (method === 'GET' && action === 'influencer-search') {
      const query = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase();
      if (query.length < 2 || query.length > 100) { json(response, 200, { influencers: [] }); return; }
      const pattern = `%${query.replace(/[%_\\]/g, '\\$&')}%`;
      const influencers = database.prepare(`SELECT id, record_json AS recordJson FROM influencers
        WHERE lower(json_extract(record_json, '$.Name')) LIKE ? ESCAPE '\\'
          OR lower(json_extract(record_json, '$."Username I"')) LIKE ? ESCAPE '\\'
          OR lower(json_extract(record_json, '$."Username T"')) LIKE ? ESCAPE '\\'
          OR lower(json_extract(record_json, '$.Username')) LIKE ? ESCAPE '\\'
        ORDER BY json_extract(record_json, '$.Name') COLLATE NOCASE LIMIT 30`)
        .all(pattern, pattern, pattern, pattern).map((row) => {
          const record = JSON.parse(row.recordJson || '{}');
          return { id: row.id, name: String(record.Name || ''), profiles: visitProfile(record) };
        });
      json(response, 200, { influencers });
      return;
    }
    if (method === 'GET' && !action) {
      const schedule = internalClientVisitSchedule(accountId);
      json(response, 200, schedule);
      return;
    }

    if (action === 'import-preview' && method === 'POST') {
      const body = await readJson(request);
      if (!String(body.fileName || '').toLocaleLowerCase().endsWith('.xlsx')) {
        json(response, 400, { error: 'ارفع ملف Excel بامتداد .xlsx.' }); return;
      }
      const rows = matchVisitImportRows(readXlsxRows(body.fileBase64));
      const current = internalClientVisitSchedule(accountId).visits;
      const oldByInfluencer = new Map(current.map((visit) => [visit.influencerId, visit]));
      const matched = rows.filter((row) => row.influencerId && row.status === 'matched');
      const incomingIds = new Set(matched.map((row) => row.influencerId));
      const changes = {
        added: matched.filter((row) => !oldByInfluencer.has(row.influencerId)).length,
        updated: matched.filter((row) => {
          const old = oldByInfluencer.get(row.influencerId);
          return old && (old.visitDate !== row.visitDate || old.visitTime !== row.visitTime
            || old.city !== row.city || old.branch !== row.branch);
        }).length,
        unchanged: matched.filter((row) => {
          const old = oldByInfluencer.get(row.influencerId);
          return old && old.visitDate === row.visitDate && old.visitTime === row.visitTime
            && old.city === row.city && old.branch === row.branch;
        }).length,
        removed: current.filter((visit) => !incomingIds.has(visit.influencerId)).length
      };
      const previewToken = randomBytes(24).toString('base64url');
      for (const [token, saved] of visitImportPreviews) {
        if (saved.expiresAt < Date.now()) visitImportPreviews.delete(token);
      }
      visitImportPreviews.set(previewToken, {
        accountId, rows, expiresAt: Date.now() + 15 * 60 * 1000
      });
      json(response, 200, {
        previewToken, rows, changes,
        validRows: rows.filter((row) => row.status === 'matched').length,
        unresolvedRows: rows.filter((row) => row.status !== 'matched').length,
        issues: {
          duplicateRows: rows.filter((row) => row.status === 'duplicate').length,
          invalidRows: rows.filter((row) => row.status === 'invalid').length,
          ambiguousRows: rows.filter((row) => row.status === 'ambiguous').length,
          unmatchedRows: rows.filter((row) => row.status === 'unmatched').length
        },
        existingSchedule: current.length > 0,
        existingVisits: current.map(({ influencerId, visitDate, visitTime, city, branch }) =>
          ({ influencerId, visitDate, visitTime, city, branch }))
      });
      return;
    }

    if (action === 'import-confirm' && method === 'POST') {
      const body = await readJson(request);
      const preview = visitImportPreviews.get(String(body.previewToken || ''));
      if (!preview || preview.expiresAt < Date.now() || preview.accountId !== accountId) {
        json(response, 409, { error: 'معاينة الاستيراد انتهت أو لا تخص هذا العميل؛ أعد رفع الملف.' }); return;
      }
      const existing = internalClientVisitSchedule(accountId).visits;
      if (existing.length && body.replaceExisting !== true) {
        json(response, 409, { error: 'يوجد جدول محفوظ. راجع ملخص الاستبدال وأكد استبدال الجدول صراحةً.' }); return;
      }
      if (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > 5000) {
        json(response, 400, { error: 'اختر صف زيارة صالحًا واحدًا على الأقل للاستيراد.' }); return;
      }
      const previewRows = new Map(preview.rows.map((row) => [row.rowNumber, row]));
      let entries;
      try {
        entries = body.rows.map((row) => {
          const source = previewRows.get(Number(row.rowNumber));
          if (!source) throw Object.assign(new Error('يتضمن التأكيد صفًا غير موجود في المعاينة.'), { status: 400 });
          const visit = validateClientVisitPayload(row);
          return visit;
        });
      } catch (error) {
        json(response, error.status || 400, { error: error.message }); return;
      }
      const uniqueIds = new Set(entries.map((visit) => visit.influencerId));
      if (uniqueIds.size !== entries.length) { json(response, 409, { error: 'لا يمكن إدراج المؤثر نفسه أكثر من مرة؛ راجع الصفوف المكررة.' }); return; }
      const existingById = new Map(existing.map((visit) => [visit.influencerId, visit]));
      const added = entries.filter((visit) => !existingById.has(visit.influencerId)).length;
      const updated = entries.filter((visit) => {
        const old = existingById.get(visit.influencerId);
        return old && (old.visitDate !== visit.visitDate || old.visitTime !== visit.visitTime
          || old.city !== visit.city || old.branch !== visit.branch);
      }).length;
      const unchanged = entries.length - added - updated;
      const removed = existing.filter((visit) => !uniqueIds.has(visit.influencerId)).length;
      const rejectedRows = preview.rows.length - entries.length;
      const now = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        const schedule = ensureClientVisitSchedule(accountId);
        const deleteVisit = database.prepare('DELETE FROM client_visits WHERE id = ? AND schedule_id = ?');
        existing.filter((visit) => !uniqueIds.has(visit.influencerId))
          .forEach((visit) => deleteVisit.run(visit.id, schedule.id));
        const insert = database.prepare(`INSERT INTO client_visits
          (id, schedule_id, influencer_id, visit_date, visit_time, city, branch, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const update = database.prepare(`UPDATE client_visits SET visit_date = ?, visit_time = ?,
          city = ?, branch = ?, updated_at = ? WHERE id = ? AND schedule_id = ?`);
        entries.forEach((visit) => {
          const old = existingById.get(visit.influencerId);
          if (!old) insert.run(randomBytes(16).toString('hex'), schedule.id,
            visit.influencerId, visit.visitDate, visit.visitTime, visit.city, visit.branch, now, now);
          else if (old.visitDate !== visit.visitDate || old.visitTime !== visit.visitTime
            || old.city !== visit.city || old.branch !== visit.branch) {
            update.run(visit.visitDate, visit.visitTime, visit.city, visit.branch, now, old.id, schedule.id);
          }
        });
        database.prepare(`UPDATE client_visit_schedules SET status = 'draft', updated_at = ?, published_at = NULL
          WHERE id = ?`).run(now, schedule.id);
        recordClientActivity(accountId, user, 'visit_schedule_imported', { added, updated, unchanged, removed, rejectedRows });
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      visitImportPreviews.delete(String(body.previewToken));
      const issues = {
        duplicateRows: preview.rows.filter((row) => row.status === 'duplicate').length,
        invalidRows: preview.rows.filter((row) => row.status === 'invalid').length,
        ambiguousRows: preview.rows.filter((row) => row.status === 'ambiguous').length,
        unmatchedRows: preview.rows.filter((row) => row.status === 'unmatched').length
      };
      json(response, 200, { ok: true, changes: { added, updated, unchanged, removed, rejectedRows }, issues, status: 'draft' });
      return;
    }

    if (action === 'publish' && method === 'POST') {
      const schedule = database.prepare('SELECT id FROM client_visit_schedules WHERE client_account_id = ?').get(accountId);
      if (!schedule) { json(response, 409, { error: 'لا يوجد جدول زيارات لحفظه.' }); return; }
      const count = database.prepare('SELECT COUNT(*) AS count FROM client_visits WHERE schedule_id = ?').get(schedule.id).count;
      if (!count) { json(response, 409, { error: 'أضف زيارة واحدة على الأقل قبل النشر.' }); return; }
      const now = new Date().toISOString();
      database.prepare(`UPDATE client_visit_schedules SET status = 'published', updated_at = ?, published_at = ? WHERE id = ?`)
        .run(now, now, schedule.id);
      recordClientActivity(accountId, user, 'visit_schedule_published', { visitCount: count });
      json(response, 200, { ok: true, status: 'published' });
      return;
    }
    if (action === 'unpublish' && method === 'POST') {
      const now = new Date().toISOString();
      database.prepare(`UPDATE client_visit_schedules SET status = 'draft', updated_at = ?, published_at = NULL
        WHERE client_account_id = ?`).run(now, accountId);
      recordClientActivity(accountId, user, 'visit_schedule_unpublished');
      json(response, 200, { ok: true, status: 'draft' });
      return;
    }
    if (!action && method === 'POST') {
      const body = await readJson(request);
      let visit;
      try { visit = validateClientVisitPayload(body); }
      catch (error) { json(response, error.status || 400, { error: error.message }); return; }
      const now = new Date().toISOString();
      const schedule = ensureClientVisitSchedule(accountId);
      try {
        const id = randomBytes(16).toString('hex');
        database.prepare(`INSERT INTO client_visits
          (id, schedule_id, influencer_id, visit_date, visit_time, city, branch, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, schedule.id, visit.influencerId,
          visit.visitDate, visit.visitTime, visit.city, visit.branch, now, now);
        database.prepare(`UPDATE client_visit_schedules SET status = 'draft', updated_at = ?, published_at = NULL WHERE id = ?`)
          .run(now, schedule.id);
        recordClientActivity(accountId, user, 'visit_created', { influencerId: visit.influencerId });
        json(response, 201, { ok: true, id });
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) { json(response, 409, { error: 'يوجد موعد لهذا المؤثر؛ عدّله بدل إضافة موعد مكرر.' }); return; }
        throw error;
      }
      return;
    }
    if (visitId && method === 'PATCH') {
      const body = await readJson(request);
      let visit;
      try { visit = validateClientVisitPayload(body); }
      catch (error) { json(response, error.status || 400, { error: error.message }); return; }
      const schedule = database.prepare('SELECT id FROM client_visit_schedules WHERE client_account_id = ?').get(accountId);
      const now = new Date().toISOString();
      let changed = 0;
      try {
        changed = schedule ? database.prepare(`UPDATE client_visits SET influencer_id = ?, visit_date = ?,
          visit_time = ?, city = ?, branch = ?, updated_at = ? WHERE id = ? AND schedule_id = ?`)
          .run(visit.influencerId, visit.visitDate, visit.visitTime, visit.city, visit.branch, now, visitId, schedule.id).changes : 0;
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) { json(response, 409, { error: 'يوجد موعد مسجل للمؤثر المحدد بالفعل.' }); return; }
        throw error;
      }
      if (!changed) { json(response, 404, { error: 'موعد الزيارة غير موجود لهذا العميل.' }); return; }
      database.prepare(`UPDATE client_visit_schedules SET status = 'draft', updated_at = ?, published_at = NULL WHERE id = ?`)
        .run(now, schedule.id);
      recordClientActivity(accountId, user, 'visit_updated', { visitId, influencerId: visit.influencerId });
      json(response, 200, { ok: true });
      return;
    }
    if (visitId && method === 'DELETE') {
      const schedule = database.prepare('SELECT id FROM client_visit_schedules WHERE client_account_id = ?').get(accountId);
      if (!schedule) { json(response, 404, { error: 'جدول الزيارات غير موجود.' }); return; }
      const changed = database.prepare('DELETE FROM client_visits WHERE id = ? AND schedule_id = ?')
        .run(visitId, schedule.id).changes;
      if (!changed) { json(response, 404, { error: 'موعد الزيارة غير موجود لهذا العميل.' }); return; }
      const now = new Date().toISOString();
      database.prepare(`UPDATE client_visit_schedules SET status = 'draft', updated_at = ?, published_at = NULL WHERE id = ?`)
        .run(now, schedule.id);
      recordClientActivity(accountId, user, 'visit_removed', { visitId });
      json(response, 200, { ok: true });
      return;
    }
  }

  if (pathname === '/api/client-accounts' && method === 'GET') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'عرض حسابات العملاء متاح للمدير والمحرر فقط.' }); return; }
    json(response, 200, { accounts: clientAccountSummaries() });
    return;
  }

  const clientWorkspaceMatch = pathname.match(/^\/api\/client-accounts\/([a-f0-9]{32})\/workspace$/);
  if (clientWorkspaceMatch && method === 'GET') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'مساحة عمل العميل متاحة للمدير والمحرر فقط.' }); return; }
    const account = clientAccountSummaries().find((item) => item.id === clientWorkspaceMatch[1]);
    if (!account) { json(response, 404, { error: 'حساب العميل غير موجود.' }); return; }
    const assignedCampaignIds = new Set(account.campaigns.map((campaign) => campaign.id));
    const campaigns = campaignSummaries().filter((campaign) => assignedCampaignIds.has(campaign.id));
    const visits = campaigns.flatMap((campaign) => campaign.targets
      .filter((target) => target.executionType === 'visit')
      .map((target) => ({
        campaignId: campaign.id,
        campaignName: campaign.campaignName,
        influencerId: target.id,
        influencerName: target.name || target.profile?.name || target.username || '',
        username: target.username || '',
        visitDate: target.visitDate || '',
        visitTime: target.visitTime || '',
        city: target.visitCity || '',
        branch: target.visitBranch || '',
        address: target.visitAddress || '',
        location: target.visitLocation || '',
        status: target.visitStatus || 'pending_confirmation',
        notes: target.visitNotes || ''
      })));
    const decisionHistory = database.prepare(`SELECT * FROM (
      SELECT h.created_at AS createdAt, h.actor_label AS actor, h.event_type AS eventType,
        h.previous_decision AS previousDecision, h.decision, c.offer_name AS subject,
        json_extract(i.record_json, '$.Name') AS influencerName
      FROM client_catalog_decision_history h
      JOIN client_account_catalogs ac ON ac.catalog_id = h.catalog_id AND ac.account_id = ?
      JOIN client_catalogs c ON c.id = h.catalog_id
      JOIN influencers i ON i.id = h.influencer_id
      UNION ALL
      SELECT h.created_at, 'العميل', h.event_type, h.previous_decision, h.decision,
        c.campaign_name, json_extract(i.record_json, '$.Name')
      FROM client_decision_history h
      JOIN client_account_campaigns ac ON ac.campaign_id = h.campaign_id AND ac.account_id = ?
      JOIN campaigns c ON c.id = h.campaign_id
      JOIN influencers i ON i.id = h.influencer_id
    ) ORDER BY createdAt DESC LIMIT 100`).all(account.id, account.id);
    const activity = database.prepare(`SELECT actor_username AS actorUsername, event_type AS eventType,
      detail_json AS detailJson, created_at AS createdAt
      FROM client_account_activity WHERE account_id = ? ORDER BY created_at DESC LIMIT 100`)
      .all(account.id).map((entry) => ({
        ...entry,
        details: JSON.parse(entry.detailJson || '{}')
      }));
    json(response, 200, { account, campaigns, visits, decisionHistory, activity });
    return;
  }

  const clientPreviewMatch = pathname.match(/^\/api\/client-accounts\/([a-f0-9]{32})\/preview$/);
  if (clientPreviewMatch && method === 'GET') {
    if (user.role !== 'admin') { json(response, 403, { error: 'معاينة بوابة العميل متاحة للمدير فقط.' }); return; }
    const account = database.prepare(`SELECT id, username, client_name AS clientName,
      company_name AS companyName, active, portal_config AS portalConfig,
      portal_status AS portalStatus, client_type AS clientType, display_mode AS displayMode
      FROM client_accounts WHERE id = ?`).get(clientPreviewMatch[1]);
    if (!account) { json(response, 404, { error: 'حساب العميل غير موجود.' }); return; }
    account.portalConfig = validatePortalConfig(account.portalConfig, defaultPortalConfig('request-approval', account.portalStatus));
    json(response, 200, clientCampaignPresentation(account, { preview: true }));
    return;
  }

  if (pathname === '/api/client-portal-templates' && method === 'GET') {
    if (user.role !== 'admin') { json(response, 403, { error: 'قوالب بوابة العملاء متاحة للمدير فقط.' }); return; }
    const templates = database.prepare(`SELECT id, name, config_json AS configJson,
      created_at AS createdAt, updated_at AS updatedAt
      FROM client_portal_templates ORDER BY name COLLATE NOCASE`).all().map((template) => ({
      ...template,
      config: validatePortalConfig(template.configJson, defaultPortalConfig())
    }));
    json(response, 200, { templates });
    return;
  }

  if (pathname === '/api/client-portal-templates' && method === 'POST') {
    if (user.role !== 'admin') { json(response, 403, { error: 'حفظ قوالب بوابة العملاء متاح للمدير فقط.' }); return; }
    const body = await readJson(request);
    const name = String(body.name || '').trim();
    if (!name || name.length > 100) { json(response, 400, { error: 'اسم القالب مطلوب وبحد أقصى 100 حرف.' }); return; }
    const config = validatePortalConfig({ ...body.config, status: 'draft' });
    const id = randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    try {
      database.prepare(`INSERT INTO client_portal_templates
        (id, name, config_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, name, JSON.stringify(config), user.id, now, now);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) { json(response, 409, { error: 'يوجد قالب بالاسم نفسه.' }); return; }
      throw error;
    }
    json(response, 201, { template: { id, name, config, createdAt: now, updatedAt: now } });
    return;
  }

  if (pathname === '/api/client-accounts' && method === 'POST') {
    if (user.role !== 'admin') { json(response, 403, { error: 'إنشاء حسابات العملاء متاح للمدير فقط.' }); return; }
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const username = normalizeUsername(body.username) || generatedClientUsername(email);
    const clientName = String(body.clientName || '').trim();
    const companyName = String(body.companyName || '').trim();
    const internalNotes = String(body.internalNotes || '').trim();
    const legacyClientType = String(body.clientType || 'current');
    const displayMode = body.displayMode === undefined
      ? (legacyClientType === 'prospective' ? 'prospective' : 'selecting')
      : String(body.displayMode);
    const clientType = displayMode === 'prospective' ? 'prospective' : 'current';
    const campaignIds = Array.isArray(body.campaignIds) ? [...new Set(body.campaignIds.filter((id) => typeof id === 'string'))] : [];
    const catalogIds = Array.isArray(body.catalogIds) ? [...new Set(body.catalogIds.filter((id) => typeof id === 'string'))] : [];
    if (!validateUsername(username)) { json(response, 400, { error: 'اسم مستخدم العميل غير صالح.' }); return; }
    if (!validateEmail(email)) { json(response, 400, { error: 'البريد الإلكتروني مطلوب ويجب أن يكون صالحًا.' }); return; }
    if (!clientDisplayModes.has(displayMode) || !['prospective', 'current'].includes(legacyClientType)) {
      json(response, 400, { error: 'طريقة عرض العميل غير صالحة.' }); return;
    }
    if (!clientName || clientName.length > 100 || !companyName || companyName.length > 150) {
      json(response, 400, { error: 'اسم العميل واسم الشركة مطلوبان.' }); return;
    }
    if (internalNotes.length > 5000) { json(response, 400, { error: 'الملاحظات الداخلية تتجاوز الحد المسموح.' }); return; }
    if (!validatePassword(body.password)) { json(response, 400, { error: `كلمة المرور يجب أن تكون بين ${passwordMinLength} و${passwordMaxLength} أحرف.` }); return; }
    let portalConfig;
    try { portalConfig = validatePortalConfig(body.portalConfig, defaultPortalConfig()); }
    catch (error) { json(response, error.status || 400, { error: error.message }); return; }
    const campaignCount = campaignIds.length
      ? Number(database.prepare(`SELECT COUNT(*) AS count FROM campaigns WHERE id IN (${campaignIds.map(() => '?').join(',')})`).get(...campaignIds).count)
      : 0;
    if (campaignCount !== campaignIds.length) { json(response, 400, { error: 'تتضمن قائمة التعيين حملة غير موجودة.' }); return; }
    const catalogCount = catalogIds.length
      ? Number(database.prepare(`SELECT COUNT(*) AS count FROM client_catalogs WHERE id IN (${catalogIds.map(() => '?').join(',')})`).get(...catalogIds).count)
      : 0;
    if (catalogCount !== catalogIds.length) { json(response, 400, { error: 'تتضمن قائمة العروض عرضًا غير موجود.' }); return; }
    const alreadyAssignedCount = catalogIds.length
      ? Number(database.prepare(`SELECT COUNT(*) AS count FROM client_account_catalogs WHERE catalog_id IN (${catalogIds.map(() => '?').join(',')})`).get(...catalogIds).count)
      : 0;
    if (alreadyAssignedCount) { json(response, 409, { error: 'أحد العروض مرتبط بحساب عميل آخر بالفعل.' }); return; }
    const credentials = await hashPassword(body.password);
    const id = randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`INSERT INTO client_accounts
        (id, username, email, client_name, company_name, internal_notes, client_type, display_mode, salt, password_hash, active,
         portal_config, portal_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
        .run(id, username, email, clientName, companyName, internalNotes, clientType, displayMode, credentials.salt, credentials.hash,
          JSON.stringify(portalConfig), portalConfig.status, now, now);
      const insertAssignment = database.prepare('INSERT INTO client_account_campaigns (account_id, campaign_id, created_at) VALUES (?, ?, ?)');
      campaignIds.forEach((campaignId) => insertAssignment.run(id, campaignId, now));
      const insertOfferAssignment = database.prepare('INSERT INTO client_account_catalogs (account_id, catalog_id, created_at) VALUES (?, ?, ?)');
      catalogIds.forEach((catalogId) => {
        insertOfferAssignment.run(id, catalogId, now);
        database.prepare('UPDATE client_catalogs SET portal_linked = 1 WHERE id = ?').run(catalogId);
      });
      recordClientActivity(id, user, 'account_created', { campaignCount: campaignIds.length, offerCount: catalogIds.length });
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE')) { json(response, 409, { error: 'اسم المستخدم أو البريد الإلكتروني مستخدم بالفعل.' }); return; }
      throw error;
    }
    json(response, 201, { account: clientAccountSummaries().find((account) => account.id === id) });
    return;
  }

  const clientAccountMatch = pathname.match(/^\/api\/client-accounts\/([a-f0-9]{32})$/);
  const clientDisplayModeMatch = pathname.match(/^\/api\/client-accounts\/([a-f0-9]{32})\/display-mode$/);
  if (clientDisplayModeMatch && method === 'PATCH') {
    if (!requireRole(user, ['admin', 'editor'])) {
      json(response, 403, { error: 'تغيير طريقة عرض العميل متاح للمدير والمحرر فقط.' }); return;
    }
    const body = await readJson(request);
    const displayMode = String(body.displayMode || '');
    if (!clientDisplayModes.has(displayMode)) { json(response, 400, { error: 'طريقة عرض العميل غير صالحة.' }); return; }
    const accountId = clientDisplayModeMatch[1];
    const now = new Date().toISOString();
    const changed = database.prepare(`UPDATE client_accounts SET display_mode = ?, client_type = ?, updated_at = ?
      WHERE id = ?`).run(displayMode, displayMode === 'prospective' ? 'prospective' : 'current', now, accountId);
    if (!changed.changes) { json(response, 404, { error: 'حساب العميل غير موجود.' }); return; }
    recordClientActivity(accountId, user, 'display_mode_changed', { displayMode });
    json(response, 200, { account: clientAccountSummaries().find((account) => account.id === accountId) });
    return;
  }
  if (clientAccountMatch && (method === 'PATCH' || method === 'PUT')) {
    if (user.role !== 'admin') { json(response, 403, { error: 'إدارة حسابات العملاء متاحة للمدير فقط.' }); return; }
    const accountId = clientAccountMatch[1];
    const existing = database.prepare(`SELECT id, active, client_type AS clientType,
      display_mode AS displayMode,
      portal_config AS portalConfig, portal_status AS portalStatus
      FROM client_accounts WHERE id = ?`).get(accountId);
    if (!existing) { json(response, 404, { error: 'حساب العميل غير موجود.' }); return; }
    const body = await readJson(request);
    const current = database.prepare(`SELECT username, client_name AS clientName,
      email, company_name AS companyName, internal_notes AS internalNotes
      FROM client_accounts WHERE id = ?`).get(accountId);
    const username = body.username === undefined ? current.username : normalizeUsername(body.username);
    const email = body.email === undefined ? current.email : normalizeEmail(body.email);
    const clientName = body.clientName === undefined ? current.clientName : String(body.clientName).trim();
    const companyName = body.companyName === undefined ? current.companyName : String(body.companyName).trim();
    const internalNotes = body.internalNotes === undefined ? current.internalNotes : String(body.internalNotes || '').trim();
    const displayMode = body.displayMode === undefined
      ? body.clientType === undefined
        ? displayModeFor(existing)
        : body.clientType === 'prospective' ? 'prospective' : body.clientType === 'current' ? 'selecting' : ''
      : String(body.displayMode);
    const clientType = displayMode === 'prospective' ? 'prospective' : 'current';
    const active = body.active === undefined ? Boolean(existing.active) : asBoolean(body.active, null);
    if (!validateUsername(username)) { json(response, 400, { error: 'اسم مستخدم العميل غير صالح.' }); return; }
    if (body.email !== undefined && !validateEmail(email)) { json(response, 400, { error: 'البريد الإلكتروني يجب أن يكون صالحًا.' }); return; }
    if (!clientDisplayModes.has(displayMode)) { json(response, 400, { error: 'طريقة عرض العميل غير صالحة.' }); return; }
    if (!clientName || clientName.length > 100 || !companyName || companyName.length > 150 ||
        internalNotes.length > 5000 || active === null) {
      json(response, 400, { error: 'بيانات حساب العميل غير صالحة.' }); return;
    }
    if (body.password !== undefined && !validatePassword(body.password)) {
      json(response, 400, { error: `كلمة المرور يجب أن تكون بين ${passwordMinLength} و${passwordMaxLength} أحرف.` }); return;
    }
    let portalConfig;
    try {
      portalConfig = body.portalConfig === undefined
        ? validatePortalConfig(existing.portalConfig, defaultPortalConfig('request-approval', existing.portalStatus))
        : validatePortalConfig(body.portalConfig);
    } catch (error) { json(response, error.status || 400, { error: error.message }); return; }
    let campaignIds;
    if (body.campaignIds !== undefined) {
      if (!Array.isArray(body.campaignIds)) { json(response, 400, { error: 'قائمة الحملات غير صالحة.' }); return; }
      campaignIds = [...new Set(body.campaignIds.filter((id) => typeof id === 'string'))];
      const campaignCount = campaignIds.length
        ? Number(database.prepare(`SELECT COUNT(*) AS count FROM campaigns WHERE id IN (${campaignIds.map(() => '?').join(',')})`).get(...campaignIds).count)
        : 0;
      if (campaignCount !== campaignIds.length) { json(response, 400, { error: 'تتضمن قائمة التعيين حملة غير موجودة.' }); return; }
    }
    let catalogIds;
    if (body.catalogIds !== undefined) {
      if (!Array.isArray(body.catalogIds)) { json(response, 400, { error: 'قائمة العروض غير صالحة.' }); return; }
      catalogIds = [...new Set(body.catalogIds.filter((id) => typeof id === 'string'))];
      const catalogCount = catalogIds.length
        ? Number(database.prepare(`SELECT COUNT(*) AS count FROM client_catalogs WHERE id IN (${catalogIds.map(() => '?').join(',')})`).get(...catalogIds).count)
        : 0;
      if (catalogCount !== catalogIds.length) { json(response, 400, { error: 'تتضمن قائمة العروض عرضًا غير موجود.' }); return; }
      const ownerConflict = catalogIds.length
        ? database.prepare(`SELECT catalog_id FROM client_account_catalogs
            WHERE catalog_id IN (${catalogIds.map(() => '?').join(',')})
              AND account_id != ? LIMIT 1`).get(...catalogIds, accountId)
        : null;
      if (ownerConflict) { json(response, 409, { error: 'أحد العروض مرتبط بحساب عميل آخر بالفعل.' }); return; }
    }
    let credentials = null;
    if (body.password) credentials = await hashPassword(body.password);
    database.exec('BEGIN IMMEDIATE');
    try {
      if (credentials) {
        database.prepare(`UPDATE client_accounts SET username = ?, email = ?, client_name = ?, company_name = ?, internal_notes = ?,
          client_type = ?, display_mode = ?, active = ?, salt = ?, password_hash = ?, portal_config = ?, portal_status = ?, updated_at = ? WHERE id = ?`)
          .run(username, email, clientName, companyName, internalNotes, clientType, displayMode, Number(active), credentials.salt, credentials.hash,
            JSON.stringify(portalConfig), portalConfig.status, new Date().toISOString(), accountId);
      } else {
        database.prepare(`UPDATE client_accounts SET username = ?, email = ?, client_name = ?, company_name = ?, internal_notes = ?,
          client_type = ?, display_mode = ?, active = ?, portal_config = ?, portal_status = ?, updated_at = ? WHERE id = ?`)
          .run(username, email, clientName, companyName, internalNotes, clientType, displayMode, Number(active), JSON.stringify(portalConfig),
            portalConfig.status, new Date().toISOString(), accountId);
      }
      if (campaignIds) {
        database.prepare('DELETE FROM client_account_campaigns WHERE account_id = ?').run(accountId);
        const insertAssignment = database.prepare('INSERT INTO client_account_campaigns (account_id, campaign_id, created_at) VALUES (?, ?, ?)');
        campaignIds.forEach((campaignId) => insertAssignment.run(accountId, campaignId, new Date().toISOString()));
      }
      if (catalogIds) {
        database.prepare('DELETE FROM client_account_catalogs WHERE account_id = ?').run(accountId);
        const insertOfferAssignment = database.prepare('INSERT INTO client_account_catalogs (account_id, catalog_id, created_at) VALUES (?, ?, ?)');
        catalogIds.forEach((catalogId) => {
          insertOfferAssignment.run(accountId, catalogId, new Date().toISOString());
          database.prepare('UPDATE client_catalogs SET portal_linked = 1 WHERE id = ?').run(catalogId);
        });
      }
      const changedFields = ['email', 'clientName', 'companyName', 'internalNotes', 'clientType', 'displayMode', 'active', 'password', 'campaignIds', 'catalogIds', 'portalConfig']
        .filter((key) => body[key] !== undefined);
      if (changedFields.length) recordClientActivity(accountId, user, 'account_updated', { changedFields });
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE')) { json(response, 409, { error: 'اسم المستخدم أو البريد الإلكتروني مستخدم بالفعل.' }); return; }
      throw error;
    }
    if (!active || credentials) {
      for (const [token, session] of clientSessions) if (session.accountId === accountId) clientSessions.delete(token);
    }
    json(response, 200, { account: clientAccountSummaries().find((account) => account.id === accountId) });
    return;
  }

  if (pathname === '/api/campaigns' && method === 'POST') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'صلاحيتك لا تسمح بإضافة الحملات.' }); return; }
    const body = await readJson(request);
    let details;
    let targets;
    try {
      details = validateCampaignDetails(body);
      targets = normalizeCampaignTargets(body, details.campaignType, details.startDate, details.endDate);
    } catch (error) { json(response, error.status || 400, { error: error.message }); return; }
    const found = getInfluencersByIds(targets.map((target) => target.id));
    if (found.missingIds.length) { json(response, 400, { error: 'بعض المؤثرين المحددين لم يعودوا موجودين.' }); return; }
    const id = randomBytes(16).toString('hex');
    const now = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`INSERT INTO campaigns
        (id, campaign_name, company_name, campaign_type, execution_mode, qr_enabled,
         service_type, start_date, end_date, field_visibility, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, details.campaignName, details.companyName, details.storedCampaignType,
          details.campaignType, Number(details.qrEnabled), details.serviceType,
          details.startDate, details.endDate, JSON.stringify(details.fieldVisibility), now, now);
      const insertSchedule = database.prepare('INSERT INTO campaign_schedule (id, campaign_id, scheduled_at, position) VALUES (?, ?, ?, ?)');
      details.schedules.forEach((scheduledAt, position) => insertSchedule.run(randomBytes(16).toString('hex'), id, scheduledAt, position));
      const insertTarget = database.prepare(`INSERT INTO campaign_targets
        (campaign_id, influencer_id, position, execution_type, visit_date, visit_time, visit_city, visit_branch,
         visit_address, visit_status, visit_notes, coverage_notes, delivery_recipient_name,
         delivery_recipient_phone, delivery_courier_contact, delivery_city, delivery_district,
         delivery_address, delivery_map_link, delivery_order_details, delivery_notes,
         visit_location, shipping_status, shipping_carrier, tracking_number, delivery_date,
         coverage_status, checkin_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      targets.forEach((target, position) => insertTarget.run(
        id, target.id, position, target.executionType, target.visitDate, target.visitTime, target.visitCity,
        target.visitBranch, target.visitAddress, target.visitStatus, target.visitNotes,
        target.coverageNotes, target.recipientName, target.recipientPhone, target.courierContact,
        target.deliveryCity, target.deliveryDistrict, target.deliveryAddress, target.deliveryMapLink,
        target.orderDetails, target.deliveryNotes, target.visitLocation, target.shippingStatus,
        target.shippingCarrier, target.trackingNumber, target.deliveryDate, target.coverageStatus,
        randomBytes(24).toString('base64url')
      ));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      if (error.status) { json(response, error.status, { error: error.message }); return; }
      throw error;
    }
    json(response, 201, { campaign: campaignSummaries().find((campaign) => campaign.id === id) });
    return;
  }

  const campaignMatch = pathname.match(/^\/api\/campaigns\/([a-f0-9]{32})$/);
  if (campaignMatch && method === 'PATCH') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'صلاحيتك لا تسمح بتعديل الحملات.' }); return; }
    const id = campaignMatch[1];
    const existingCampaign = database.prepare('SELECT id, field_visibility, qr_enabled FROM campaigns WHERE id = ?').get(id);
    if (!existingCampaign) { json(response, 404, { error: 'الكامبين غير موجود.' }); return; }
    const body = await readJson(request);
    let details;
    let targets;
    try {
      const savedVisibility = (() => { try { return JSON.parse(existingCampaign.field_visibility || '{}'); } catch { return {}; } })();
      details = validateCampaignDetails({
        ...body,
        qrEnabled: body.qrEnabled ?? Boolean(existingCampaign.qr_enabled),
        fieldVisibility: body.fieldVisibility ?? savedVisibility
      });
      targets = normalizeCampaignTargets(body, details.campaignType, details.startDate, details.endDate);
    } catch (error) { json(response, error.status || 400, { error: error.message }); return; }
    const found = getInfluencersByIds(targets.map((target) => target.id));
    if (found.missingIds.length) { json(response, 400, { error: 'بعض المؤثرين المحددين لم يعودوا موجودين.' }); return; }
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`UPDATE campaigns SET campaign_name = ?, company_name = ?, campaign_type = ?,
        execution_mode = ?, qr_enabled = ?, service_type = ?, start_date = ?, end_date = ?,
        field_visibility = ?, updated_at = ? WHERE id = ?`)
        .run(details.campaignName, details.companyName, details.storedCampaignType, details.campaignType,
          Number(details.qrEnabled), details.serviceType, details.startDate, details.endDate,
          JSON.stringify(details.fieldVisibility), new Date().toISOString(), id);
      if (details.schedules.length) {
        if (details.schedules.length > 100 || details.schedules.includes(null)) throw Object.assign(new Error('المواعيد القديمة تحتوي قيمة غير صالحة.'), { status: 400 });
        database.prepare('DELETE FROM campaign_schedule WHERE campaign_id = ?').run(id);
        const insertSchedule = database.prepare('INSERT INTO campaign_schedule (id, campaign_id, scheduled_at, position) VALUES (?, ?, ?, ?)');
        details.schedules.forEach((scheduledAt, position) => insertSchedule.run(randomBytes(16).toString('hex'), id, scheduledAt, position));
      }
      const targetIdSet = new Set(targets.map((target) => target.id));
      const deleteTarget = database.prepare('DELETE FROM campaign_targets WHERE campaign_id = ? AND influencer_id = ?');
      for (const row of database.prepare('SELECT influencer_id FROM campaign_targets WHERE campaign_id = ?').all(id)) {
        if (!targetIdSet.has(row.influencer_id)) deleteTarget.run(id, row.influencer_id);
      }
      const upsertTarget = database.prepare(`INSERT INTO campaign_targets
        (campaign_id, influencer_id, position, execution_type, visit_date, visit_time, visit_city, visit_branch,
         visit_address, visit_status, visit_notes, coverage_notes, delivery_recipient_name,
         delivery_recipient_phone, delivery_courier_contact, delivery_city, delivery_district,
         delivery_address, delivery_map_link, delivery_order_details, delivery_notes,
         visit_location, shipping_status, shipping_carrier, tracking_number, delivery_date,
         coverage_status, checkin_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, influencer_id) DO UPDATE SET
          position = excluded.position, execution_type = excluded.execution_type,
          visit_date = excluded.visit_date,
          visit_time = excluded.visit_time, visit_city = excluded.visit_city,
          visit_branch = excluded.visit_branch, visit_address = excluded.visit_address,
          visit_status = excluded.visit_status, visit_notes = excluded.visit_notes,
          coverage_notes = excluded.coverage_notes,
          delivery_recipient_name = excluded.delivery_recipient_name,
          delivery_recipient_phone = excluded.delivery_recipient_phone,
          delivery_courier_contact = excluded.delivery_courier_contact,
          delivery_city = excluded.delivery_city, delivery_district = excluded.delivery_district,
          delivery_address = excluded.delivery_address, delivery_map_link = excluded.delivery_map_link,
          delivery_order_details = excluded.delivery_order_details, delivery_notes = excluded.delivery_notes,
          visit_location = excluded.visit_location,
          shipping_status = excluded.shipping_status, shipping_carrier = excluded.shipping_carrier,
          tracking_number = excluded.tracking_number, delivery_date = excluded.delivery_date,
          coverage_status = excluded.coverage_status`);
      targets.forEach((target, position) => {
        const current = database.prepare('SELECT checkin_token FROM campaign_targets WHERE campaign_id = ? AND influencer_id = ?').get(id, target.id);
        upsertTarget.run(
          id, target.id, position, target.executionType, target.visitDate, target.visitTime, target.visitCity,
          target.visitBranch, target.visitAddress, target.visitStatus, target.visitNotes,
          target.coverageNotes, target.recipientName, target.recipientPhone, target.courierContact,
          target.deliveryCity, target.deliveryDistrict, target.deliveryAddress, target.deliveryMapLink,
          target.orderDetails, target.deliveryNotes, target.visitLocation,
          target.shippingStatus, target.shippingCarrier, target.trackingNumber, target.deliveryDate,
          target.coverageStatus, current?.checkin_token || randomBytes(24).toString('base64url')
        );
      });
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      if (error.status) { json(response, error.status, { error: error.message }); return; }
      throw error;
    }
    json(response, 200, { campaign: campaignSummaries().find((campaign) => campaign.id === id) });
    return;
  }

  const campaignTargetMatch = pathname.match(/^\/api\/campaigns\/([a-f0-9]{32})\/targets\/([a-f0-9]{32})$/);
  if (campaignTargetMatch && method === 'PATCH') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'تعديل حالة مؤثر في الحملة متاح للمدير والمحرر.' }); return; }
    const [, campaignId, influencerId] = campaignTargetMatch;
    const body = await readJson(request);
    const updates = [];
    const values = [];
    const campaign = database.prepare(`SELECT c.campaign_type, c.execution_mode, c.start_date, c.end_date,
        ct.execution_type AS executionType
      FROM campaigns c JOIN campaign_targets ct ON ct.campaign_id = c.id
      WHERE c.id = ? AND ct.influencer_id = ?`).get(campaignId, influencerId);
    if (!campaign) { json(response, 404, { error: 'الكامبين غير موجود.' }); return; }
    if (body.contactStatus !== undefined) {
      if (!['not_contacted', 'contacted', 'responded'].includes(body.contactStatus)) { json(response, 400, { error: 'حالة التواصل غير صالحة.' }); return; }
      updates.push('contact_status = ?'); values.push(body.contactStatus);
    }
    if (body.participationStatus !== undefined) {
      if (!['pending', 'confirmed', 'declined'].includes(body.participationStatus)) { json(response, 400, { error: 'حالة المشاركة غير صالحة.' }); return; }
      updates.push('participation_status = ?'); values.push(body.participationStatus);
    }
    for (const [key, column, maximum] of [['campaignPrice', 'campaign_price', 80], ['operationsNotes', 'operations_notes', 2000]]) {
      if (body[key] === undefined) continue;
      const value = String(body[key] || '').trim();
      if (value.length > maximum) { json(response, 400, { error: `قيمة ${key} أطول من الحد المسموح.` }); return; }
      updates.push(`${column} = ?`); values.push(value);
    }
    if (body.afterConfirmation !== undefined) {
      const value = String(body.afterConfirmation || '');
      if (value.length > 20000) { json(response, 400, { error: 'تعليمات ما بعد التأكيد تتجاوز 20000 حرف.' }); return; }
      updates.push('after_confirmation = ?'); values.push(value);
    }
    if (body.coverageStatus !== undefined) {
      if (!['pending', 'completed', 'not_completed'].includes(body.coverageStatus)) { json(response, 400, { error: 'حالة التغطية غير صالحة.' }); return; }
      updates.push('coverage_status = ?'); values.push(body.coverageStatus);
    }
    if (body.shippingStatus !== undefined) {
      if (campaign.executionType !== 'delivery' || !shippingStatuses.has(body.shippingStatus)) { json(response, 400, { error: 'حالة الشحن غير صالحة.' }); return; }
      updates.push('shipping_status = ?'); values.push(body.shippingStatus);
    }
    const typeScopedTargetFields = campaign.executionType === 'visit'
      ? [
        ['visitCity', 'visit_city', 100], ['visitBranch', 'visit_branch', 150],
        ['visitAddress', 'visit_address', 500], ['visitNotes', 'visit_notes', 2000],
        ['coverageNotes', 'coverage_notes', 2000]
      ]
      : [
        ['recipientName', 'delivery_recipient_name', 150], ['recipientPhone', 'delivery_recipient_phone', 40],
        ['courierContact', 'delivery_courier_contact', 150], ['deliveryCity', 'delivery_city', 100],
        ['deliveryDistrict', 'delivery_district', 120], ['deliveryAddress', 'delivery_address', 500],
        ['deliveryMapLink', 'delivery_map_link', 1000], ['orderDetails', 'delivery_order_details', 2000],
        ['deliveryNotes', 'delivery_notes', 2000]
      ];
    for (const [key, column, maxLength] of typeScopedTargetFields) {
      if (body[key] === undefined) continue;
      const value = String(body[key] || '').trim();
      if (value.length > maxLength) { json(response, 400, { error: `قيمة ${key} تتجاوز الحد المسموح.` }); return; }
      if (key === 'recipientName' && value && value.split(/\s+/).filter(Boolean).length < 2) {
        json(response, 400, { error: 'اسم المستلم يجب أن يتكون من اسمين على الأقل.' }); return;
      }
      if (key === 'recipientPhone' && value && normalizePhoneDigits(value).length < 7) {
        json(response, 400, { error: 'رقم جوال المستلم غير صالح.' }); return;
      }
      if (key === 'deliveryMapLink' && value) {
        let mapUrl;
        try { mapUrl = new URL(value); } catch {}
        if (!mapUrl || !['http:', 'https:'].includes(mapUrl.protocol)) {
          json(response, 400, { error: 'رابط الموقع يجب أن يبدأ بـ HTTPS أو HTTP.' }); return;
        }
      }
      updates.push(`${column} = ?`); values.push(value || null);
    }
    if (body.visitStatus !== undefined) {
      if (campaign.executionType !== 'visit' || !visitStatuses.has(body.visitStatus)) {
        json(response, 400, { error: 'حالة الزيارة غير صالحة.' }); return;
      }
      updates.push('visit_status = ?'); values.push(body.visitStatus);
    }
    if (body.visitDate !== undefined) {
      const visitDate = String(body.visitDate || '');
      const visitTimestamp = Date.parse(`${visitDate}T00:00:00Z`);
      const validVisitDate = /^\d{4}-\d{2}-\d{2}$/.test(visitDate) && Number.isFinite(visitTimestamp) && new Date(visitTimestamp).toISOString().slice(0, 10) === visitDate;
      if (campaign.executionType === 'visit' && (!validVisitDate || visitDate < campaign.start_date || visitDate > campaign.end_date)) {
        json(response, 400, { error: 'تاريخ الزيارة يجب أن يكون داخل فترة الحملة.' }); return;
      }
      if (campaign.executionType !== 'visit') { json(response, 400, { error: 'تاريخ الزيارة غير متاح لحملة التوصيل.' }); return; }
      updates.push('visit_date = ?'); values.push(visitDate || null);
    }
    if (body.visitTime !== undefined) {
      const visitTime = String(body.visitTime || '').trim();
      if (campaign.executionType !== 'visit' || (visitTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(visitTime))) {
        json(response, 400, { error: 'وقت الزيارة غير صالح.' }); return;
      }
      updates.push('visit_time = ?'); values.push(visitTime || null);
    }
    if (body.visitLocation !== undefined) {
      const visitLocation = String(body.visitLocation || '').trim();
      if (campaign.executionType !== 'visit' || visitLocation.length > 250) { json(response, 400, { error: 'موقع الزيارة غير صالح.' }); return; }
      updates.push('visit_location = ?'); values.push(visitLocation || null);
    }
    for (const [key, column, maxLength] of [
      ['shippingCarrier', 'shipping_carrier', 100],
      ['trackingNumber', 'tracking_number', 150]
    ]) {
      if (body[key] === undefined) continue;
      const value = String(body[key] || '').trim();
      if (campaign.executionType !== 'delivery' || value.length > maxLength) { json(response, 400, { error: 'تفاصيل الشحن غير صالحة.' }); return; }
      updates.push(`${column} = ?`); values.push(value || null);
    }
    if (body.deliveryDate !== undefined) {
      const deliveryDate = String(body.deliveryDate || '').trim();
      const deliveryTimestamp = Date.parse(`${deliveryDate}T00:00:00Z`);
      if (campaign.executionType !== 'delivery' || (deliveryDate && (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate) || !Number.isFinite(deliveryTimestamp) || new Date(deliveryTimestamp).toISOString().slice(0, 10) !== deliveryDate))) {
        json(response, 400, { error: 'تاريخ التوصيل غير صالح.' }); return;
      }
      updates.push('delivery_date = ?'); values.push(deliveryDate || null);
    }
    if (!updates.length) { json(response, 400, { error: 'لم يتم تحديد حالة أو موعد لتحديثه.' }); return; }
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = database.prepare(`UPDATE campaign_targets SET ${updates.join(', ')} WHERE campaign_id = ? AND influencer_id = ?`)
        .run(...values, campaignId, influencerId);
      if (!result.changes) {
        database.exec('ROLLBACK');
        json(response, 404, { error: 'المؤثر غير موجود في هذه الحملة.' }); return;
      }
      const linkedAccounts = database.prepare('SELECT account_id FROM client_account_campaigns WHERE campaign_id = ?').all(campaignId);
      const visitFields = ['visitDate', 'visitTime', 'visitCity', 'visitBranch', 'visitAddress', 'visitStatus', 'visitNotes'];
      const eventType = Object.keys(body).some((key) => visitFields.includes(key)) ? 'visit_updated' : 'campaign_target_updated';
      for (const linked of linkedAccounts) {
        recordClientActivity(linked.account_id, user, eventType, {
          campaignId, influencerId, changedFields: Object.keys(body)
        });
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 200, { target: campaignSummaries().find((campaign) => campaign.id === campaignId).targets.find((target) => target.id === influencerId) });
    return;
  }

  if (campaignMatch && method === 'DELETE') {
    if (user.role !== 'admin') { json(response, 403, { error: 'حذف الحملات متاح للمدير فقط.' }); return; }
    const result = database.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignMatch[1]);
    if (!result.changes) { json(response, 404, { error: 'الكامبين غير موجود.' }); return; }
    json(response, 200, { ok: true });
    return;
  }

  const campaignQrExportMatch = pathname.match(/^\/api\/campaigns\/([a-f0-9]{32})\/targets\/([a-f0-9]{32})\/qr-export$/);
  if (campaignQrExportMatch && method === 'POST') {
    const body = await readJson(request);
    const confirmation = await verifySensitiveConfirmation(request, user, body);
    if (!confirmation.ok) { json(response, confirmation.status, { error: confirmation.error }); return; }
    const [, campaignId, influencerId] = campaignQrExportMatch;
    const target = database.prepare(`SELECT ct.checkin_token AS checkinToken
      FROM campaign_targets ct JOIN campaigns c ON c.id = ct.campaign_id
      WHERE ct.campaign_id = ? AND ct.influencer_id = ? AND c.qr_enabled = 1
        AND ct.execution_type = 'visit'`).get(campaignId, influencerId);
    if (!target) { json(response, 404, { error: 'رمز QR غير متاح لهذا المؤثر.' }); return; }
    json(response, 200, { checkinPath: `/campaign-checkin/${target.checkinToken}` });
    return;
  }

  const campaignExportMatch = pathname.match(/^\/api\/campaigns\/([a-f0-9]{32})\/export$/);
  if (campaignExportMatch && method === 'POST') {
    const body = await readJson(request);
    const confirmation = await verifySensitiveConfirmation(request, user, body);
    if (!confirmation.ok) { json(response, confirmation.status, { error: confirmation.error }); return; }
    const campaign = database.prepare(`SELECT campaign_name AS campaignName, company_name AS companyName,
      service_type AS serviceType, campaign_type AS campaignType, start_date AS startDate, end_date AS endDate
      FROM campaigns WHERE id = ?`).get(campaignExportMatch[1]);
    if (!campaign) { json(response, 404, { error: 'الكامبين غير موجود.' }); return; }
    const rows = database.prepare(`SELECT
      json_extract(i.record_json, '$.Name') AS name,
      json_extract(i.record_json, '$.Main_Username') AS username,
      json_extract(i.record_json, '$.Influencer Status') AS influencerStatus,
      json_extract(i.record_json, '$.Price') AS price,
      json_extract(i.record_json, '$.Note') AS note,
      ct.visit_date AS visitDate, ct.shipping_status AS shippingStatus,
      ct.visit_time AS visitTime, ct.visit_location AS visitLocation,
      ct.shipping_carrier AS shippingCarrier, ct.tracking_number AS trackingNumber,
      ct.delivery_date AS deliveryDate,
      ct.coverage_status AS coverageStatus, ct.visited_at AS visitedAt
      FROM campaign_targets ct JOIN influencers i ON i.id = ct.influencer_id
      WHERE ct.campaign_id = ? ORDER BY ct.position`).all(campaignExportMatch[1]);
    json(response, 200, { ...campaign, rows });
    return;
  }

  if (pathname === '/api/influencers' && method === 'POST') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'صلاحيتك لا تسمح بإضافة السجلات.' }); return; }
    const input = await readJson(request);
    const record = normalizeRecord(input);
    for (const field of influencerImportAccountFields) {
      const rawHandle = input[field.username]
        || field.aliases.map((alias) => input[alias]).find((value) => String(value || '').trim());
      const handle = normalizedImportUsername(rawHandle);
      if (!handle) continue;
      for (const row of database.prepare('SELECT id, record_json FROM influencers').all()) {
        const existing = JSON.parse(row.record_json || '{}');
        const existingHandle = normalizedImportUsername(existing[field.username]
          || field.aliases.map((alias) => existing[alias]).find((value) => String(value || '').trim()));
        if (existingHandle === handle) {
          const ownerName = String(existing.Name || '').trim();
          json(response, 409, {
            error: `حساب ${field.platform} مرتبط بالفعل بالمؤثر: ${ownerName || row.id}؛ لم يتم تغيير الملكية.`,
            conflict: {
              platform: field.platform,
              influencerIds: [row.id],
              influencerNames: ownerName ? [ownerName] : []
            }
          });
          return;
        }
      }
    }
    let accountConflict = findChangedSocialAccountConflict(record);
    if (!accountConflict) {
      const directOwners = new Map();
      for (const field of influencerImportAccountFields) {
        const handle = normalizedImportUsername(record[field.username]
          || field.aliases.map((alias) => record[alias]).find((value) => String(value || '').trim()));
        if (!handle) continue;
        for (const row of database.prepare('SELECT id, record_json FROM influencers').all()) {
          const existing = JSON.parse(row.record_json || '{}');
          const existingHandles = [existing[field.username], ...field.aliases.map((alias) => existing[alias])]
            .map(normalizedImportUsername);
          if (existingHandles.includes(handle)) {
            const owners = directOwners.get(`${field.platform}\0${handle}`) || new Map();
            owners.set(row.id, String(existing.Name || '').trim());
            directOwners.set(`${field.platform}\0${handle}`, owners);
          }
        }
      }
      const directConflict = [...directOwners].find(([, owners]) => owners.size);
      if (directConflict) {
        accountConflict = {
          platform: directConflict[0].split('\0')[0],
          influencerIds: [...directConflict[1].keys()],
          influencerNames: [...new Set([...directConflict[1].values()].filter(Boolean))]
        };
      }
    }
    if (accountConflict) {
      json(response, 409, {
        error: `حساب ${accountConflict.platform} مرتبط بالفعل بالمؤثر: ${accountConflict.influencerNames.join('، ') || accountConflict.influencerIds.join('، ')}؛ لم يتم تغيير الملكية.`,
        conflict: accountConflict
      });
      return;
    }
    const id = randomBytes(16).toString('hex');
    const saved = saveInfluencer(id, record);
    json(response, 201, { record: saved });
    return;
  }

  const photoPreviewImageMatch = pathname.match(/^\/api\/influencer-photos\/preview\/([a-f0-9]{64})\/(\d+)(?:\/(\d+))?$/);
  if (photoPreviewImageMatch && (method === 'GET' || method === 'HEAD')) {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'إدارة صور المؤثرين متاحة للمدير والمحرر فقط.' }); return; }
    const preview = influencerPhotoPreviews.get(photoPreviewImageMatch[1]);
    const item = preview?.userId === user.id && preview.expiresAt > Date.now()
      ? preview.items[Number(photoPreviewImageMatch[2])] : null;
    const imageIndex = Number(photoPreviewImageMatch[3] || 0);
    const image = item?.previewImages?.[imageIndex] || (!imageIndex && item?.buffer
      ? { buffer: item.buffer, mimeType: item.mimeType } : null);
    if (!image?.buffer || !image.mimeType) { json(response, 404, { error: 'صورة المعاينة غير متاحة؛ أعد إنشاء المعاينة.' }); return; }
    response.writeHead(200, {
      'Content-Type': image.mimeType, 'Content-Length': image.buffer.length,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'
    });
    response.end(method === 'HEAD' ? undefined : image.buffer);
    return;
  }

  if (pathname === '/api/influencer-photos/template' && method === 'GET') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'إدارة صور المؤثرين متاحة للمدير والمحرر فقط.' }); return; }
    const workbook = createInfluencerPhotoTemplate();
    response.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Length': workbook.length,
      'Content-Disposition': 'attachment; filename="FKRETK_Influencer_Photos_Template.xlsx"',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(workbook);
    return;
  }

  if (pathname === '/api/influencer-photos/preview' && method === 'POST') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'إدارة صور المؤثرين متاحة للمدير والمحرر فقط.' }); return; }
    const body = await readJson(request, 40 * 1024 * 1024);
    if (!String(body.fileName || '').toLocaleLowerCase().endsWith('.xlsx')) {
      json(response, 400, { error: 'ارفع ملف Excel المعبأ بالصور بامتداد .xlsx.' }); return;
    }
    const parsedWorkbook = readXlsxPhotoRows(body.fileBase64);
    const zipFiles = new Map();
    if (typeof body.imageArchiveBase64 === 'string' && body.imageArchiveBase64.trim()) {
      for (const file of parseProfileImageArchive(body.imageArchiveBase64)) {
        const key = String(file.fileName || '').trim().toLocaleLowerCase('en-US');
        if (key) zipFiles.set(key, file);
      }
    }
    const recordsById = new Map();
    for (const row of database.prepare('SELECT id, record_json FROM influencers WHERE archived_at IS NULL').all()) {
      recordsById.set(row.id, { id: row.id, record: JSON.parse(row.record_json || '{}') });
    }
    const influencerIdCounts = new Map();
    for (const row of parsedWorkbook.items) {
      if (/^[a-f0-9]{32}$/i.test(row.influencerId)) {
        const key = row.influencerId.toLocaleLowerCase('en-US');
        influencerIdCounts.set(key, (influencerIdCounts.get(key) || 0) + 1);
      }
    }
    const matchedIds = new Set();
    const items = parsedWorkbook.items.map((row, index) => {
      const rowImageFile = String(row.imageFileName || '').trim();
      const zipEntry = rowImageFile ? zipFiles.get(rowImageFile.toLocaleLowerCase('en-US')) : undefined;
      const rowImages = (zipEntry ? [zipEntry.buffer] : row.images).filter(Boolean);
      const item = {
        index, sourceRow: row.sourceRow, username: row.username, mainUsername: '', influencerId: row.influencerId,
        name: '', status: '', buffer: null, mimeType: '',
        previewImages: rowImages.map((image) => ({
          buffer: image, mimeType: profileImageMime(image)
        })).filter((image) => image.mimeType)
      };
      if (rowImageFile && !zipEntry) {
        item.status = 'Missing Image File';
        return item;
      }
      if (rowImages.length === 1) {
        item.mimeType = profileImageMime(rowImages[0]);
        if (item.mimeType) item.buffer = rowImages[0];
      }
      if (!item.influencerId) { item.status = 'Missing Influencer ID'; return item; }
      if (!/^[a-f0-9]{32}$/i.test(item.influencerId)) { item.status = 'Invalid Influencer ID'; return item; }
      item.influencerId = item.influencerId.toLocaleLowerCase('en-US');
      if (influencerIdCounts.get(item.influencerId.toLocaleLowerCase('en-US')) > 1) {
        item.status = 'Duplicate Influencer ID';
        return item;
      }
      const match = recordsById.get(item.influencerId);
      if (!match) { item.status = 'No Matching Influencer'; return item; }
      item.matched = true;
      item.name = String(match.record.Name || '');
      item.mainUsername = String(match.record.Main_Username || '');
      item.recordName = item.name;
      item.recordMainUsername = item.mainUsername;
      if ((row.username && normalizedImportUsername(row.username) !== normalizedImportUsername(item.mainUsername))
        || (row.name && normalizedPhotoIdentityText(row.name) !== normalizedPhotoIdentityText(item.name))) {
        item.status = 'Conflict – Needs Review';
        return item;
      }
      if (matchedIds.has(item.influencerId)) { item.status = 'Conflict – Needs Review'; return item; }
      matchedIds.add(item.influencerId);
      if (rowImages.length > 1) { item.status = 'Uncertain Image'; return item; }
      if (!rowImages.length) {
        item.status = parsedWorkbook.unresolvedImageCount ? 'Uncertain Image' : 'Missing Image';
        return item;
      }
      if (!item.buffer) { item.status = 'Invalid Image'; return item; }
      const storedImage = database.prepare('SELECT 1 FROM influencer_profile_images WHERE influencer_id = ?')
        .get(item.influencerId);
      item.status = storedImage || profileImageSourceUrl(match.record) ? 'Already Has Photo' : 'Ready to Upload';
      return item;
    });
    for (const [token, entry] of influencerPhotoPreviews) if (entry.expiresAt <= Date.now()) influencerPhotoPreviews.delete(token);
    const previewId = randomBytes(32).toString('hex');
    influencerPhotoPreviews.set(previewId, { userId: user.id, expiresAt: Date.now() + 10 * 60 * 1000, items });
    json(response, 200, {
      previewId,
      items: items.map(({ index, sourceRow, influencerId, username, mainUsername, name, status, previewImages }) => ({
        index, sourceRow, influencerId, username, mainUsername, name, status, hasImage: Boolean(previewImages.length),
        imageCount: previewImages.length
      })),
      summary: {
        rows: items.length,
        unresolvedImages: parsedWorkbook.unresolvedImageCount,
        matched: items.filter((item) => item.matched).length,
        ready: items.filter((item) => item.status === 'Ready to Upload').length,
        existing: items.filter((item) => item.status === 'Already Has Photo').length,
        missingId: items.filter((item) => item.status === 'Missing Influencer ID').length,
        missingUsername: items.filter((item) => item.status === 'Missing Influencer ID').length,
        invalidId: items.filter((item) => item.status === 'Invalid Influencer ID').length,
        unmatched: items.filter((item) => item.status === 'No Matching Influencer').length,
        duplicate: items.filter((item) => item.status === 'Duplicate Influencer ID').length,
        uncertain: items.filter((item) => item.status === 'Uncertain Image' || item.status === 'Conflict – Needs Review').length,
        missingImage: items.filter((item) => item.status === 'Missing Image').length,
        invalidImage: items.filter((item) => item.status === 'Invalid Image').length
      },
      expiresInSeconds: 600
    });
    return;
  }

  if (pathname === '/api/influencer-photos/upload' && method === 'POST') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'إدارة صور المؤثرين متاحة للمدير والمحرر فقط.' }); return; }
    const body = await readJson(request);
    const preview = influencerPhotoPreviews.get(String(body.previewId || ''));
    if (!preview || preview.expiresAt <= Date.now() || preview.userId !== user.id) {
      json(response, 410, { error: 'انتهت صلاحية المعاينة أو لا تخص حسابك؛ أعد إنشاءها.' }); return;
    }
    if (!Array.isArray(body.selectedRows) || !Array.isArray(body.replaceExisting)) {
      json(response, 400, { error: 'اختيارات رفع الصور غير صالحة.' }); return;
    }
    const selected = [...new Set(body.selectedRows.filter(Number.isInteger))];
    const replacements = new Set(body.replaceExisting.filter(Number.isInteger));
    if (selected.some((index) => !preview.items[index])) {
      json(response, 400, { error: 'تتضمن اختيارات الرفع صورة غير موجودة في المعاينة.' }); return;
    }
    const report = { uploaded: 0, failed: 0, skipped: 0, results: [] };
    for (const index of selected) {
      const item = preview.items[index];
      if (!item.buffer || !['Ready to Upload', 'Already Has Photo'].includes(item.status)) {
        report.skipped += 1;
        report.results.push({ index, status: item.status, error: 'الصورة غير جاهزة للرفع.' });
        continue;
      }
      try {
        database.exec('BEGIN IMMEDIATE');
        const stored = database.prepare(`SELECT i.record_json, i.archived_at,
          image.influencer_id AS storedImageId FROM influencers i
          LEFT JOIN influencer_profile_images image ON image.influencer_id = i.id WHERE i.id = ?`)
          .get(item.influencerId);
        const storedRecord = JSON.parse(stored?.record_json || '{}');
        const stillMatches = stored && !stored.archived_at
          && normalizedPhotoIdentityText(storedRecord.Name) === normalizedPhotoIdentityText(item.recordName)
          && normalizedImportUsername(storedRecord.Main_Username) === normalizedImportUsername(item.recordMainUsername);
        if (!stored || stored.archived_at || !stillMatches) throw new Error('تغيرت بيانات المؤثر منذ إنشاء المعاينة؛ أعد مراجعة الملف.');
        if ((stored.storedImageId || profileImageSourceUrl(JSON.parse(stored.record_json || '{}')))
          && !replacements.has(index)) throw new Error('لدى المؤثر صورة حالية؛ أكد الاستبدال من المعاينة أولًا.');
        const record = storedRecord;
        const hash = createHash('sha256').update(item.buffer).digest('hex');
        const now = new Date().toISOString();
        record['Profile Image URL'] = `/profile-images/${item.influencerId}?v=${hash.slice(0, 12)}`;
        database.prepare('UPDATE influencers SET record_json = ? WHERE id = ?')
          .run(JSON.stringify(normalizeRecord(record)), item.influencerId);
        database.prepare(`INSERT INTO influencer_profile_images
          (influencer_id, mime_type, image_data, content_hash, source_url, updated_at)
          VALUES (?, ?, ?, ?, NULL, ?)
          ON CONFLICT(influencer_id) DO UPDATE SET mime_type = excluded.mime_type,
            image_data = excluded.image_data, content_hash = excluded.content_hash,
            source_url = NULL, updated_at = excluded.updated_at`)
          .run(item.influencerId, item.mimeType, item.buffer, hash, now);
        database.exec('COMMIT');
        item.status = 'Uploaded';
        report.uploaded += 1;
        report.results.push({ index, status: 'Uploaded' });
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        report.failed += 1;
        report.results.push({ index, status: 'Failed', error: error.message || 'تعذر حفظ الصورة.' });
      }
    }
    report.skipped += preview.items.length - selected.length;
    json(response, 200, report);
    return;
  }

  if (pathname === '/api/import/status' && method === 'GET') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'صلاحيتك لا تسمح بالاستيراد.' }); return; }
    json(response, 200, { paused: isProduction && !productionImportEnabled });
    return;
  }

  if (pathname === '/api/import/legacy-account-aliases/preview' && method === 'GET') {
    if (!requireRole(user, ['admin'])) { json(response, 403, { error: 'معاينة توحيد الحسابات القديمة متاحة للمدير فقط.' }); return; }
    const records = database.prepare('SELECT id, record_json FROM influencers').all()
      .map((row) => ({ id: row.id, record: JSON.parse(row.record_json || '{}') }));
    const plan = planLegacyAccountAliasNormalization(records);
    json(response, 200, {
      totalRecords: records.length,
      recordsToNormalize: plan.updates.size,
      fieldsCopied: plan.fieldsCopied,
      conflicts: plan.conflicts,
      conflictingAccountGroups: plan.conflictingAccountGroups,
      byPlatform: plan.byPlatform
    });
    return;
  }

  if (pathname === '/api/import/legacy-account-aliases/normalize' && method === 'POST') {
    if (!requireRole(user, ['admin'])) { json(response, 403, { error: 'توحيد الحسابات القديمة متاح للمدير فقط.' }); return; }
    if (isProduction || process.env.FIKRATAK_ENABLE_ALIAS_NORMALIZATION !== '1') {
      json(response, 403, { error: 'توحيد الحسابات القديمة غير مفعّل في هذا الخادم.' });
      return;
    }
    const body = await readJson(request);
    if (body.confirm !== 'normalize-account-aliases') {
      json(response, 409, { error: 'أرسل تأكيد توحيد مفاتيح الحسابات القديمة.' });
      return;
    }
    const records = database.prepare('SELECT id, record_json FROM influencers').all()
      .map((row) => ({ id: row.id, record: JSON.parse(row.record_json || '{}') }));
    const plan = planLegacyAccountAliasNormalization(records);
    let updatedRows = 0;
    const recordsById = new Map(records.map((row) => [row.id, row]));
    database.exec('BEGIN IMMEDIATE');
    try {
      const update = database.prepare('UPDATE influencers SET record_json = ? WHERE id = ?');
      for (const [id, fields] of plan.updates) {
        const row = recordsById.get(id);
        if (!row) throw new Error('Legacy account normalization target disappeared.');
        const normalizedRecord = { ...row.record, ...fields };
        for (const key of plan.removeAliases.get(id) || []) delete normalizedRecord[key];
        update.run(JSON.stringify(normalizedRecord), id);
        updatedRows += 1;
      }
      recordSystemAudit('legacy_account_aliases_normalized', 'database', 'success', {
        label: 'Legacy account aliases normalized',
        values: {
          updatedRows,
          fieldsCopied: plan.fieldsCopied,
          conflicts: plan.conflicts,
          conflictingAccountGroups: plan.conflictingAccountGroups,
          byPlatform: plan.byPlatform
        }
      });
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 200, {
      totalRecords: records.length,
      recordsToNormalize: plan.updates.size,
      updatedRows,
      fieldsCopied: plan.fieldsCopied,
      conflicts: plan.conflicts,
      conflictingAccountGroups: plan.conflictingAccountGroups,
      byPlatform: plan.byPlatform
    });
    return;
  }

  if (pathname === '/api/import/preview' && method === 'POST') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'صلاحيتك لا تسمح بمعاينة الاستيراد.' }); return; }
    if (isProduction && !productionImportEnabled) { json(response, 503, { error: 'الاستيراد متوقف مؤقتاً للصيانة.' }); return; }
    const body = await readJson(request, 40 * 1024 * 1024);
    let rows = body.rows;
    if (!Array.isArray(rows) && String(body.fileName || '').toLocaleLowerCase().endsWith('.xlsx')) {
      rows = readXlsxImportRows(body.fileBase64);
    }
    if (!Array.isArray(rows)) { json(response, 400, { error: 'ملف المعاينة غير صالح.' }); return; }
    if (body.followersOnly === true
      && (body.imageArchiveBase64 || rows.some((row) => importImageUrl(row)))) {
      json(response, 400, { error: 'يجب فصل تحديث المتابعين عن استيراد الصور.' });
      return;
    }
    const normalized = normalizeInfluencerImportRows(rows);
    const alignmentWarnings = findImportAccountAlignmentWarnings(normalized.rows);
    if (normalized.unknownColumns.length) {
      json(response, 200, { preview: {
        total: rows.length,
        items: rows.slice(0, 200).map((row, index) => ({
          row: importIssueRow(row, index),
          name: String(row?.Name || row?.name || '').trim(),
          accounts: importImageAccountKeys(normalized.rows[index] || row),
          imageSource: '',
          fileName: ''
        })),
        issues: [],
        truncated: rows.length > 200,
        followersOnly: body.followersOnly === true,
        unknownColumns: normalized.unknownColumns,
        alignmentWarnings,
        importBlocked: true,
        identityRejected: true,
        identityError: `أُوقف الاستيراد لوجود أعمدة غير معروفة: ${normalized.unknownColumns.join(', ')}.`
      } });
      return;
    }
    if (body.followersOnly === true) {
      const preview = {
        total: rows.length,
        items: normalized.rows.slice(0, 200).map((row, index) => ({
          row: importIssueRow(row, index),
          name: String(row?.Name || row?.name || '').trim(),
          accounts: importImageAccountKeys(row),
          imageSource: '',
          fileName: ''
        })),
        issues: [],
        truncated: rows.length > 200,
        followersOnly: true,
        alignmentWarnings
      };
      preview.previewId = saveInfluencerImportPreview(user, rows, body);
      json(response, 200, { preview });
      return;
    }
    const hasIdentity = normalized.rows.some(hasImportIdentity);
    const preview = previewProfileImageImport(rows, body.imageArchiveBase64 || '');
    preview.integrity = hasIdentity ? previewInfluencerImport(normalized.rows, {
      allowSensitiveChanges: body.allowSensitiveChanges === true && user.role === 'admin',
      restoreArchivedMatches: body.restoreArchivedMatches === true
    }) : {
      total: rows.length, valid: 0, conflicts: rows.length, duplicates: 0, creates: 0,
      updates: 0, unchanged: 0, skipped: rows.length, matchedByPhone: 0, matchedByAccount: 0,
      needsReview: 0, issues: rows.map((row, index) => ({
        row: importIssueRow(row, index), reason: 'missing-stable-identity'
      }))
    };
    preview.unknownColumns = normalized.unknownColumns;
    preview.alignmentWarnings = alignmentWarnings;
    preview.importBlocked = false;
    const sharedPhoneRows = new Set(preview.integrity.sharedPhoneRows || []);
    preview.items.forEach((item) => { item.sharedPhone = sharedPhoneRows.has(item.row); });
    preview.identityRejected = !hasIdentity;
    preview.identityError = !hasIdentity
      ? 'لا يحتوي الملف على هاتف أو حساب اجتماعي صالح. No rows contain a valid phone or social account.'
      : '';
    preview.allNewConfirmationRequired = database.prepare('SELECT COUNT(*) AS count FROM influencers').get().count > 0
      && preview.integrity.creates === rows.length && rows.length > 0;
    preview.restoreArchivedMatches = preview.integrity.issues.filter((issue) =>
      issue.reason === 'archived-match-needs-restore').length;
    preview.previewId = saveInfluencerImportPreview(user, rows, body);
    json(response, 200, { preview });
    return;
  }

  if (pathname === '/api/import' && method === 'POST') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'صلاحيتك لا تسمح بالاستيراد.' }); return; }
    if (isProduction && !productionImportEnabled) { json(response, 503, { error: 'الاستيراد متوقف مؤقتاً للصيانة.' }); return; }
    const body = await readJson(request, 40 * 1024 * 1024);
    let rows = body.rows;
    if (!Array.isArray(rows) && String(body.fileName || '').toLocaleLowerCase().endsWith('.xlsx')) {
      rows = readXlsxImportRows(body.fileBase64);
    }
    if (!Array.isArray(rows)) { json(response, 400, { error: 'ملف الاستيراد غير صالح.' }); return; }
    if (body.followersOnly === true
      && (body.imageArchiveBase64 || rows.some((row) => importImageUrl(row)))) {
      json(response, 400, { error: 'يجب فصل تحديث المتابعين عن استيراد الصور.' });
      return;
    }
    const sourceRows = rows;
    const normalized = normalizeInfluencerImportRows(rows);
    if (normalized.unknownColumns.length) {
      json(response, 400, {
        error: `أُوقف الاستيراد لوجود أعمدة غير معروفة: ${normalized.unknownColumns.join(', ')}.`,
        unknownColumns: normalized.unknownColumns
      });
      return;
    }
    const previewId = requireInfluencerImportPreview(user, sourceRows, body);
    rows = normalized.rows;
    const rowTargetIds = Array(rows.length).fill('');
    if (body.followersOnly === true) {
      let updatedAccounts = 0;
      let unmatched = 0;
      let ambiguous = 0;
      let invalid = 0;
      const issues = [];
      const records = database.prepare('SELECT id, record_json, phone_key FROM influencers').all().map((row) => ({
        id: row.id,
        phoneKey: row.phone_key,
        record: JSON.parse(row.record_json || '{}')
      }));
      const accountFields = influencerImportAccountFields;
      const recordsById = new Map(records.map((row) => [row.id.toLowerCase(), row]));
      const accountIndex = new Map();
      for (const row of records) for (const field of accountFields) {
        for (const value of influencerImportAccountValues(row.record, field)) {
          const handle = normalizedImportUsername(value);
          if (!handle) continue;
          const key = `${field.platform}\0${handle}`;
          const matches = accountIndex.get(key) || [];
          matches.push(row);
          accountIndex.set(key, matches);
        }
      }
      const recordsByPhone = new Map(records.filter((row) => row.phoneKey).map((row) => [row.phoneKey, row]));
      const touchedAccounts = new Set();
      database.exec('BEGIN IMMEDIATE');
      try {
        const updateRecord = database.prepare('UPDATE influencers SET record_json = ? WHERE id = ?');
        const addHistory = database.prepare(`INSERT INTO influencer_follower_history
          (id, influencer_id, platform, followers_count, previous_count, source, actor_username, recorded_at)
          VALUES (?, ?, ?, ?, ?, 'import', ?, ?)`);
        for (const [index, input] of rows.entries()) {
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
            invalid += 1; issues.push({ row: importIssueRow(input, index), reason: 'invalid-row' }); continue;
          }
          const updateDate = followerImportUpdateDate(input);
          if (!updateDate) {
            invalid += 1;
            issues.push({
              row: importIssueRow(input, index),
              reason: Object.keys(input).some((key) => ['updatedate', 'followerupdatedate'].includes(normalizeImportHeader(key)))
                ? 'invalid-update-date' : 'missing-update-date'
            });
            continue;
          }
          const suppliedPhone = normalizePhone(input);
          const identityCandidates = [];
          let identityInvalid = false;
          let identityAmbiguous = false;
          let identityReason = '';
          const idEntries = Object.entries(input)
            .filter(([key]) => influencerImportIdHeaders.has(normalizeImportHeader(key)));
          const suppliedIds = [...new Set(idEntries.map(([, value]) => String(value ?? '').trim()).filter(Boolean))];
          if (suppliedIds.length > 1) {
            identityInvalid = true;
            identityReason = 'conflicting-record-ids';
          } else if (!suppliedIds.length) {
            identityInvalid = true;
            identityReason = 'missing-record-id';
          } else if (suppliedIds.length) {
            const suppliedId = suppliedIds[0];
            if (!/^[a-f0-9]{32}$/i.test(suppliedId)) {
              identityInvalid = true;
              identityReason = 'invalid-record-id';
            } else {
              const match = recordsById.get(suppliedId.toLowerCase());
              if (!match) {
                identityInvalid = true;
                identityReason = 'unknown-record-id';
              } else {
                identityCandidates.push(match);
              }
            }
          }
          if (suppliedPhone) {
            const match = recordsByPhone.get(suppliedPhone);
            if (!match) identityInvalid = true;
            else identityCandidates.push(match);
          }
          for (const field of accountFields) {
            const rawHandle = input[field.username] ?? field.aliases.map((alias) => input[alias]).find((value) => String(value || '').trim());
            if (!String(rawHandle || '').trim()) continue;
            const matches = accountIndex.get(`${field.platform}\0${normalizedImportUsername(rawHandle)}`) || [];
            if (matches.length > 1) identityAmbiguous = true;
            else if (matches.length === 0) identityInvalid = true;
            else identityCandidates.push(matches[0]);
          }
          const uniqueCandidates = [...new Map(identityCandidates.map((candidate) => [candidate.id, candidate])).values()];
          if (identityAmbiguous || uniqueCandidates.length > 1) {
            ambiguous += 1; issues.push({ row: importIssueRow(input, index), reason: 'identifiers-disagree' }); continue;
          }
          if (identityInvalid || !uniqueCandidates.length) {
            (identityInvalid && identityCandidates.length ? ambiguous++ : unmatched++);
            issues.push({
              row: importIssueRow(input, index),
              reason: identityReason || (identityInvalid && identityCandidates.length ? 'ambiguous-or-mismatched-identity' : 'no-match')
            });
            continue;
          }
          const target = uniqueCandidates[0];
          rowTargetIds[index] = target.id;
          const changes = [];
          let rowInvalid = false;
          for (const field of accountFields) {
            const rawValue = input[field.followers];
            if (rawValue === undefined || String(rawValue ?? '').trim() === '') continue;
            const count = parseImportedFollowerCount(rawValue);
            if (count === null) { rowInvalid = true; break; }
            const existingHandle = normalizedImportUsername(target.record[field.username]
              || field.aliases.map((alias) => target.record[alias]).find((value) => String(value || '').trim()));
            const suppliedHandle = normalizedImportUsername(input[field.username]
              ?? field.aliases.map((alias) => input[alias]).find((value) => String(value || '').trim()));
            if (!existingHandle || !suppliedHandle || existingHandle !== suppliedHandle) { rowInvalid = true; break; }
            const touchKey = `${target.id}\0${field.platform}`;
            if (touchedAccounts.has(touchKey)) { rowInvalid = true; break; }
            changes.push({ field, count, touchKey });
          }
          if (rowInvalid || !changes.length) {
            invalid += 1; issues.push({ row: importIssueRow(input, index), reason: rowInvalid ? 'invalid-or-unmatched-account-value' : 'no-follower-count' });
            continue;
          }
          const nextRecord = { ...target.record };
          const recordedAt = `${updateDate}T00:00:00.000Z`;
          for (const change of changes) {
            const previousCount = parseFollowerValue(nextRecord[change.field.followers]);
            nextRecord[change.field.followers] = String(change.count);
            addHistory.run(randomBytes(16).toString('hex'), target.id, change.field.platform,
              change.count, previousCount, user.username, recordedAt);
            touchedAccounts.add(change.touchKey);
            updatedAccounts += 1;
          }
          deriveInfluencerFields(nextRecord);
          updateRecord.run(JSON.stringify(nextRecord), target.id);
          target.record = nextRecord;
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      influencerImportPreviews.delete(previewId);
      json(response, 200, { followersOnly: true, updatedAccounts, unmatched, ambiguous, invalid, issues });
      return;
    }
    if (!normalized.rows.some(hasImportIdentity)) {
      json(response, 400, {
        error: 'لا يحتوي الملف على أي صف به هاتف أو حساب اجتماعي. No rows contain a phone or social account.'
      });
      return;
    }
    const integrityPreview = previewInfluencerImport(normalized.rows, {
      allowSensitiveChanges: body.allowSensitiveChanges === true && user.role === 'admin',
      restoreArchivedMatches: body.restoreArchivedMatches === true
    });
    const existingRows = Number(database.prepare('SELECT COUNT(*) AS count FROM influencers').get().count);
    if (existingRows > 0 && integrityPreview.creates === rows.length && rows.length > 0
      && body.confirmAllNew !== true) {
      json(response, 409, {
        error: 'كل الصفوف ستُضاف كسجلات جديدة رغم وجود سجلات محفوظة؛ أكد ذلك صراحةً أو راجع المطابقة. Every row would be created as new while records already exist; confirm explicitly or review matching.',
        allNewConfirmationRequired: true
      });
      return;
    }
    const duplicateRows = findDuplicateImportRows(rows);
    const duplicatePhones = findDuplicateImportPhoneRows(rows);
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let failed = 0;
    let matchedByPhone = 0;
    let matchedByAccount = 0;
    const issues = [];
    const rowResults = Array(rows.length).fill(null);
    const undoData = [];
    const importStartedAt = new Date().toISOString();
    const { fileName, fileSha256 } = importFileMetadata(body, sourceRows);
    const batchId = randomBytes(16).toString('hex');
    const insert = database.prepare('INSERT INTO influencers (id, record_json, phone_key) VALUES (?, ?, ?)');
    const update = database.prepare('UPDATE influencers SET record_json = ?, phone_key = ? WHERE id = ?');
    const allowSensitiveChanges = body.allowSensitiveChanges === true && user.role === 'admin';
    const warnings = [];
    const addHistory = database.prepare(`INSERT INTO influencer_follower_history
      (id, influencer_id, platform, followers_count, previous_count, source, actor_username, recorded_at)
      VALUES (?, ?, ?, ?, ?, 'import', ?, ?)`);
    database.exec('BEGIN IMMEDIATE');
    try {
      const records = database.prepare(`SELECT id, record_json, phone_key, archived_at, archived_by,
        archive_previous_status, archive_previous_workflow FROM influencers`).all().map((row) => ({
        id: row.id, record: JSON.parse(row.record_json || '{}'), phoneKey: row.phone_key,
        archivedAt: row.archived_at, archivedBy: row.archived_by, archivePreviousStatus: row.archive_previous_status,
        archivePreviousWorkflow: row.archive_previous_workflow
      }));
      const recordsById = new Map(records.map((row) => [row.id.toLowerCase(), row]));
      const existingByPhone = new Map();
      for (const row of records) {
        const key = row.phoneKey || normalizePhone(row.record);
        if (!key) continue;
        const matches = existingByPhone.get(key) || new Set();
        matches.add(row);
        existingByPhone.set(key, matches);
      }
      const addPhoneOwner = (phoneKey, owner) => {
        if (!phoneKey) return;
        const owners = existingByPhone.get(phoneKey) || new Set();
        owners.add(owner);
        existingByPhone.set(phoneKey, owners);
      };
      const removePhoneOwner = (phoneKey, ownerId) => {
        if (!phoneKey) return;
        const owners = existingByPhone.get(phoneKey);
        owners?.delete(ownerId);
        if (!owners?.size) existingByPhone.delete(phoneKey);
      };
      const accountIndex = new Map();
      const accountKeys = (record) => influencerImportAccountFields.flatMap((field) => {
        return influencerImportAccountValues(record, field).flatMap((value) => {
          const handle = normalizedImportUsername(value);
          return handle ? [[`${field.platform}\0${handle}`, field]] : [];
        });
      });
      const beforeInfluencerCount = records.length;
      const beforeAccountCount = records.reduce((count, row) => count + accountKeys(row.record).length, 0);
      let expectedAccountDelta = 0;
      const registerAccountKeys = (record, influencerId, remove = false) => {
        for (const [key] of accountKeys(record)) {
          const matches = accountIndex.get(key) || new Set();
          if (remove) matches.delete(influencerId);
          else matches.add(influencerId);
          if (matches.size) accountIndex.set(key, matches);
          else accountIndex.delete(key);
        }
      };
      for (const item of records) registerAccountKeys(item.record, item.id);
      const assertAccountOwnership = (record, id) => {
        for (const [key] of accountKeys(record)) {
          const owners = accountIndex.get(key);
          if (owners && [...owners].some((owner) => owner !== id)) throw new Error('identity-conflict');
        }
      };
      const validatePersistedRecord = (id, record, phoneKey) => {
        const saved = database.prepare('SELECT record_json, phone_key FROM influencers WHERE id = ?').get(id);
        if (!saved || saved.record_json !== JSON.stringify(record) || saved.phone_key !== phoneKey) {
          throw new Error('post-save-validation-failed');
        }
      };
      for (const [index, input] of rows.entries()) {
        database.exec('SAVEPOINT import_row');
        try {
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid-row');
          const duplicate = duplicateRows.get(index);
          if (duplicate) throw new Error('duplicate-account-in-file');
          const canonicalInput = { ...input };
          const idEntries = Object.entries(canonicalInput).filter(([key]) => influencerImportIdHeaders.has(normalizeImportHeader(key)));
          for (const [key] of idEntries) delete canonicalInput[key];
          for (const key of Object.keys(canonicalInput)) {
            if (['profileimageurl', 'profilepictureurl', 'avatarurl', 'imageurl', 'photourl'].includes(normalizeImportHeader(key))) {
              delete canonicalInput[key];
            }
          }
          for (const field of influencerImportAccountFields) {
            if (String(canonicalInput[field.username] || '').trim()) continue;
            const alias = field.aliases.find((name) => String(canonicalInput[name] || '').trim());
            if (alias) canonicalInput[field.username] = canonicalInput[alias];
          }
          const incoming = normalizedImportRecord(canonicalInput);
          const identities = accountKeys(incoming);
          const phoneKey = normalizePhone(incoming);
          if (!identities.length && !phoneKey) throw new Error('missing-stable-identity');
          const accountOwners = new Set();
          for (const [key] of identities) {
            const matches = accountIndex.get(key) || new Set();
            for (const id of matches) accountOwners.add(id);
          }
          if (accountOwners.size > 1) throw new Error('identity-conflict');
          const existing = accountOwners.size
            ? recordsById.get([...accountOwners][0].toLowerCase()) || null
            : null;
          if (accountOwners.size && !existing) throw new Error('identity-conflict');
          if (existing?.archivedAt && body.restoreArchivedMatches !== true) {
            throw new Error('archived-match-needs-restore');
          }
          const existingPhoneKey = existing?.phoneKey || (existing ? normalizePhone(existing.record) : null);
          if (existing && phoneKey
            && [...(existingByPhone.get(phoneKey) || [])].some((owner) => owner.id !== existing.id)) {
            throw new Error('identity-conflict');
          }
          if (existing && phoneKey && existingPhoneKey && phoneKey !== existingPhoneKey) {
            throw new Error('phone-number-changed-needs-review');
          }
          const sharedPhone = Boolean(phoneKey
            && (duplicatePhones.has(index)
              || [...(existingByPhone.get(phoneKey) || [])].some((owner) => owner.id !== existing?.id)));
          if (sharedPhone) incoming['Phone Shared'] = 'رقم مشترك';
          if (existing) matchedByAccount += 1;
          if (!existing) {
            const id = randomBytes(16).toString('hex');
            const recordJson = JSON.stringify(incoming);
            assertAccountOwnership(incoming, id);
            insert.run(id, recordJson, phoneKey);
            validatePersistedRecord(id, incoming, phoneKey);
            const createdRecord = { id, record: incoming, phoneKey };
            recordsById.set(id.toLowerCase(), createdRecord);
            addPhoneOwner(phoneKey, createdRecord);
            expectedAccountDelta += accountKeys(incoming).length;
            rowTargetIds[index] = id;
            created += 1;
            rowResults[index] = { row: importIssueRow(input, index), result: 'created', sharedPhone };
            undoData.push({ id, row: importIssueRow(input, index), action: 'created', afterRecord: recordJson, afterPhoneKey: phoneKey });
            database.exec('RELEASE import_row');
            continue;
          }

          const previous = existing.record;
          const merged = { ...previous };
          const heldSensitiveFields = [];
          for (const [key, value] of Object.entries(canonicalInput)) {
            const normalizedValue = incoming[key] === undefined ? value : incoming[key];
            if (['Name', 'Gender'].includes(key) && String(normalizedValue ?? '').trim()
              && String(normalizedValue) !== String(previous[key] ?? '') && !allowSensitiveChanges) {
              heldSensitiveFields.push(key);
              continue;
            }
            if (Array.isArray(normalizedValue)) {
              if (normalizedValue.length) merged[key] = normalizedValue;
            } else if (String(normalizedValue ?? '').trim() !== '') merged[key] = normalizedValue;
          }
          if (sharedPhone) merged['Phone Shared'] = 'رقم مشترك';
          if (heldSensitiveFields.length) warnings.push({
            row: importIssueRow(input, index), reason: 'sensitive-change-review', fields: heldSensitiveFields
          });
          const updatedRecord = normalizedImportRecord(merged);
          if (existing.archivedAt) {
            updatedRecord['Influencer Status'] = existing.archivePreviousStatus === 'Inactive' ? 'Inactive' : 'Active';
            updatedRecord['Workflow Status'] = existing.archivePreviousWorkflow || 'new';
          }
          const nextPhoneKey = phoneKey || existingPhoneKey;
          assertAccountOwnership(updatedRecord, existing.id);
          expectedAccountDelta += accountKeys(updatedRecord).length - accountKeys(previous).length;
          const recordJson = JSON.stringify(updatedRecord);
          if (!existing.archivedAt && stableRecordJson(updatedRecord) === stableRecordJson(previous) && nextPhoneKey === existing.phoneKey) {
            rowTargetIds[index] = existing.id;
            unchanged += 1;
            rowResults[index] = { row: importIssueRow(input, index), result: 'unchanged' };
            database.exec('RELEASE import_row');
            continue;
          }
          const now = new Date().toISOString();
          for (const field of influencerImportAccountFields) {
            const nextCount = parseFollowerValue(updatedRecord[field.followers]);
            const previousCount = parseFollowerValue(previous[field.followers]);
            if (nextCount !== null && nextCount !== previousCount) {
              addHistory.run(randomBytes(16).toString('hex'), existing.id, field.platform,
                nextCount, previousCount, user.username, now);
            }
          }
          registerAccountKeys(previous, existing.id, true);
          update.run(recordJson, nextPhoneKey, existing.id);
          validatePersistedRecord(existing.id, updatedRecord, nextPhoneKey);
          registerAccountKeys(updatedRecord, existing.id);
          const previousPhoneKey = existingPhoneKey;
          const beforePhoneKey = existing.phoneKey;
          const beforeArchivedAt = existing.archivedAt;
          const beforeArchivedBy = existing.archivedBy;
          const beforeArchivePreviousStatus = existing.archivePreviousStatus;
          const beforeArchivePreviousWorkflow = existing.archivePreviousWorkflow;
          removePhoneOwner(previousPhoneKey, existing.id);
          existing.record = updatedRecord;
          existing.phoneKey = nextPhoneKey;
          addPhoneOwner(nextPhoneKey, existing);
          rowTargetIds[index] = existing.id;
          updated += 1;
          rowResults[index] = { row: importIssueRow(input, index), result: 'updated', sharedPhone };
          undoData.push({
            id: existing.id, row: importIssueRow(input, index), action: 'updated', beforeRecord: JSON.stringify(previous),
            beforePhoneKey, afterRecord: JSON.stringify(updatedRecord), afterPhoneKey: nextPhoneKey,
            beforeArchivedAt, beforeArchivedBy, beforeArchivePreviousStatus, beforeArchivePreviousWorkflow
          });
          if (beforeArchivedAt) {
            database.prepare(`UPDATE influencers SET archived_at = NULL, archived_by = NULL WHERE id = ?`).run(existing.id);
            existing.archivedAt = null;
          }
          database.exec('RELEASE import_row');
        } catch (error) {
          database.exec('ROLLBACK TO import_row');
          database.exec('RELEASE import_row');
          if (error.code?.startsWith('ERR_SQLITE') || error.message === 'post-save-validation-failed') throw error;
          failed += 1;
          const reason = error.message.startsWith('invalid-follower-count:') ? 'invalid-follower-count' : error.message;
          issues.push({ row: importIssueRow(input, index), reason });
          rowResults[index] = {
            row: importIssueRow(input, index),
            result: influencerImportReviewReasons.has(reason) ? 'needs-review' : 'skipped',
            reason
          };
        }
      }
      const afterInfluencerCount = database.prepare('SELECT COUNT(*) AS count FROM influencers').get().count;
      const afterAccountCount = database.prepare('SELECT record_json FROM influencers').all()
        .reduce((count, row) => count + accountKeys(JSON.parse(row.record_json || '{}')).length, 0);
      if (afterInfluencerCount !== beforeInfluencerCount + created
        || afterAccountCount !== beforeAccountCount + expectedAccountDelta) {
        throw new Error('import-integrity-validation-failed');
      }
      const completedAt = new Date().toISOString();
      database.prepare(`INSERT INTO import_batches
        (id, file_name, file_sha256, actor_user_id, actor_username, started_at, completed_at,
         created_count, updated_count, unchanged_count, skipped_count, needs_review_count,
         row_results_json, undo_data_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(batchId, fileName, fileSha256, user.id, user.username, importStartedAt, completedAt,
          created, updated, unchanged, failed, issues.filter((item) =>
            influencerImportReviewReasons.has(item.reason)).length,
          JSON.stringify(rowResults.filter(Boolean)), JSON.stringify(undoData));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    const images = await importProfileImages(rows, rowTargetIds, body.imageArchiveBase64 || '');
    influencerImportPreviews.delete(previewId);
    json(response, 200, {
      created, updated, unchanged, failed, issues, warnings, images,
      batchId, matchedByPhone,
      matchedByAccount: matchedByAccount + issues.filter((item) =>
        ['account-match-needs-review', 'phone-account-mismatch'].includes(item.reason)).length,
      needsReview: issues.filter((item) => influencerImportReviewReasons.has(item.reason)).length,
      sharedPhones: rowResults.filter((item) => item?.sharedPhone).length,
      imported: created, skipped: unchanged + failed, skippedPhone: 0, skippedExact: unchanged
    });
    return;
  }

  const importUndoMatch = pathname.match(/^\/api\/import\/batches\/([a-f0-9]{32})\/undo$/);
  if (importUndoMatch && method === 'POST') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'صلاحيتك لا تسمح بالتراجع عن الاستيراد.' }); return; }
    const batch = database.prepare(`SELECT id, actor_user_id, undo_data_json, undone_at
      FROM import_batches WHERE id = ?`).get(importUndoMatch[1]);
    if (!batch) { json(response, 404, { error: 'دفعة الاستيراد غير موجودة.' }); return; }
    if (user.role !== 'admin' && batch.actor_user_id !== user.id) {
      json(response, 403, { error: 'يمكن للمحرر التراجع عن دفعاته فقط.' }); return;
    }
    if (batch.undone_at) { json(response, 409, { error: 'تم التراجع عن هذه الدفعة مسبقًا.' }); return; }
    const undoEntries = JSON.parse(batch.undo_data_json || '[]');
    const tables = database.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((row) => row.name);
    const linkedToInfluencer = (id) => {
      for (const table of tables) {
        if (table === 'influencers' || table === 'influencer_accounts' || table === 'import_batches') continue;
        const foreignKeys = database.prepare(`PRAGMA foreign_key_list("${table.replace(/"/g, '""')}")`).all();
        for (const foreignKey of foreignKeys) {
          if (foreignKey.table !== 'influencers') continue;
          const column = String(foreignKey.from).replace(/"/g, '""');
          if (database.prepare(`SELECT 1 FROM "${table.replace(/"/g, '""')}" WHERE "${column}" = ? LIMIT 1`).get(id)) return true;
        }
      }
      return false;
    };
    let undone = 0;
    const skipped = [];
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of [...undoEntries].reverse()) {
        database.exec('SAVEPOINT undo_import_row');
        const current = database.prepare(`SELECT record_json, phone_key, archived_at, archived_by,
          archive_previous_status, archive_previous_workflow FROM influencers WHERE id = ?`).get(entry.id);
        const expectedPhone = entry.afterPhoneKey ?? null;
        if (!current || current.record_json !== entry.afterRecord || current.phone_key !== expectedPhone
          || linkedToInfluencer(entry.id)) {
          skipped.push({ row: entry.row, reason: !current ? 'record-missing'
            : current.record_json !== entry.afterRecord || current.phone_key !== expectedPhone ? 'changed-after-import'
              : 'has-linked-data' });
          database.exec('RELEASE undo_import_row');
          continue;
        }
        try {
          if (entry.action === 'created') {
            database.prepare('DELETE FROM influencers WHERE id = ?').run(entry.id);
          } else {
            database.prepare(`UPDATE influencers SET record_json = ?, phone_key = ?, archived_at = ?, archived_by = ?,
              archive_previous_status = ?, archive_previous_workflow = ? WHERE id = ?`)
              .run(entry.beforeRecord, entry.beforePhoneKey, entry.beforeArchivedAt, entry.beforeArchivedBy,
                entry.beforeArchivePreviousStatus || 'Active', entry.beforeArchivePreviousWorkflow || 'new', entry.id);
          }
          undone += 1;
          database.exec('RELEASE undo_import_row');
        } catch (error) {
          database.exec('ROLLBACK TO undo_import_row');
          database.exec('RELEASE undo_import_row');
          if (error.code?.startsWith('ERR_SQLITE')) {
            skipped.push({ row: entry.row, reason: 'restore-conflict' });
            continue;
          }
          throw error;
        }
      }
      if (!skipped.length) {
        database.prepare('UPDATE import_batches SET undone_at = ? WHERE id = ?').run(new Date().toISOString(), batch.id);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 200, { undone, skipped: skipped.length, issues: skipped });
    return;
  }

  if (pathname === '/api/account-conflicts' && method === 'GET') {
    if (!requireRole(user, ['admin'])) { json(response, 403, { error: 'تقرير تعارضات الحسابات متاح للمدير فقط.' }); return; }
    json(response, 200, getAccountConflictReport());
    return;
  }

  if (pathname === '/api/account-conflicts/export' && method === 'POST') {
    const body = await readJson(request);
    const confirmation = await verifySensitiveConfirmation(request, user, body);
    if (!confirmation.ok) { json(response, confirmation.status, { error: confirmation.error }); return; }
    const report = getAccountConflictReport();
    const rows = report.groups.flatMap((group) => group.influencers.map((influencer) => ({
      Platform: group.platform,
      Username: group.username,
      'Influencer ID': influencer.id,
      'Influencer Name': influencer.name,
      'Historical Names': influencer.historicalNames.join(' | '),
      'Current Record': influencer.current ? 'Yes' : 'No',
      Archived: influencer.archived ? 'Yes' : 'No'
    })));
    json(response, 200, { rows, generatedAt: report.generatedAt });
    return;
  }

  if (pathname === '/api/export' && method === 'POST') {
    const body = await readJson(request);
    const confirmation = await verifySensitiveConfirmation(request, user, body);
    if (!confirmation.ok) { json(response, confirmation.status, { error: confirmation.error }); return; }
    json(response, 200, { rows: getInfluencers() });
    return;
  }

  if (pathname === '/api/client-catalogs' && method === 'GET') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'عرض عروض العملاء متاح للمدير والمحرر فقط.' }); return; }
    json(response, 200, { catalogs: clientCatalogSummaries() });
    return;
  }

  if (pathname === '/api/client-catalogs/import-preview' && method === 'POST') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'استيراد مؤثرين إلى العروض متاح للمدير والمحرر فقط.' }); return; }
    const body = await readJson(request);
    if (!String(body.fileName || '').toLocaleLowerCase().endsWith('.xlsx')) {
      json(response, 400, { error: 'ارفع ملف Excel بامتداد .xlsx.' }); return;
    }
    const catalogId = typeof body.catalogId === 'string' ? body.catalogId : '';
    if (catalogId && !database.prepare('SELECT id FROM client_catalogs WHERE id = ?').get(catalogId)) {
      json(response, 404, { error: 'عرض العملاء غير موجود.' }); return;
    }
    const rows = matchCatalogImportRows(readXlsxRows(body.fileBase64), catalogId);
    const previewId = saveCatalogImportPreview({ userId: user.id, mode: 'influencers', catalogId, rows });
    const counts = Object.fromEntries(['matched', 'unmatched', 'duplicate', 'invalid', 'already-in-offer']
      .map((status) => [status, rows.filter((row) => row.status === status).length]));
    json(response, 200, { previewId, rows, counts, expiresInSeconds: 600 });
    return;
  }

  if (pathname === '/api/client-catalogs/import-confirm' && method === 'POST') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'إضافة مؤثرين إلى العروض متاحة للمدير والمحرر فقط.' }); return; }
    const body = await readJson(request);
    const preview = catalogImportPreviews.get(String(body.previewId || ''));
    if (!preview || preview.expiresAt <= Date.now() || preview.userId !== user.id || preview.mode !== 'influencers') {
      json(response, 410, { error: 'انتهت صلاحية المعاينة؛ أعد رفع الملف.' }); return;
    }
    const influencerIds = [...new Set(preview.rows.filter((row) => row.status === 'matched').map((row) => row.influencerId))];
    if (preview.catalogId) {
      const existing = database.prepare('SELECT id FROM client_catalogs WHERE id = ?').get(preview.catalogId);
      if (!existing) { catalogImportPreviews.delete(String(body.previewId)); json(response, 404, { error: 'عرض العملاء غير موجود.' }); return; }
      const existingIds = new Set(database.prepare('SELECT influencer_id FROM client_catalog_items WHERE catalog_id = ?')
        .all(preview.catalogId).map((row) => row.influencer_id));
      let position = Number(database.prepare('SELECT COALESCE(MAX(position), -1) AS position FROM client_catalog_items WHERE catalog_id = ?').get(preview.catalogId).position) + 1;
      let added = 0;
      database.exec('BEGIN IMMEDIATE');
      try {
        const insert = database.prepare('INSERT OR IGNORE INTO client_catalog_items (catalog_id, influencer_id, position) VALUES (?, ?, ?)');
        for (const influencerId of influencerIds) {
          if (existingIds.has(influencerId)) continue;
          if (insert.run(preview.catalogId, influencerId, position).changes) { added += 1; position += 1; }
        }
        database.prepare('UPDATE client_catalogs SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), preview.catalogId);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      catalogImportPreviews.delete(String(body.previewId));
      json(response, 200, { added, alreadyInOffer: influencerIds.length - added, catalog: clientCatalogSummaries().find((item) => item.id === preview.catalogId) });
      return;
    }
    catalogImportPreviews.delete(String(body.previewId));
    json(response, 200, { influencerIds, added: influencerIds.length });
    return;
  }

  const catalogInfluencerMatch = pathname.match(/^\/api\/client-catalogs\/([a-f0-9]{32})\/influencers$/);
  if (catalogInfluencerMatch && method === 'GET') {
    if (user.role !== 'admin') { json(response, 403, { error: 'عرض أعضاء القائمة متاح للمدير فقط.' }); return; }
    const catalogId = catalogInfluencerMatch[1];
    if (!database.prepare('SELECT id FROM client_catalogs WHERE id = ?').get(catalogId)) {
      json(response, 404, { error: 'عرض العملاء غير موجود.' }); return;
    }
    const influencerIds = database.prepare('SELECT influencer_id FROM client_catalog_items WHERE catalog_id = ? ORDER BY position')
      .all(catalogId).map((row) => row.influencer_id);
    const records = getInfluencersByIds(influencerIds).rows;
    const accountVisibility = Object.fromEntries(records.map((record) => [
      record.id, catalogAccountVisibilityMap(catalogId, record.id, record)
    ]));
    json(response, 200, { influencerIds, accountVisibility });
    return;
  }

  if (catalogInfluencerMatch && method === 'POST') {
    if (user.role !== 'admin') { json(response, 403, { error: 'إضافة مؤثرين إلى العرض متاحة للمدير فقط.' }); return; }
    const catalogId = catalogInfluencerMatch[1];
    if (!database.prepare('SELECT id FROM client_catalogs WHERE id = ?').get(catalogId)) {
      json(response, 404, { error: 'عرض العملاء غير موجود.' }); return;
    }
    const body = await readJson(request);
    if (!Array.isArray(body.influencerIds) || body.influencerIds.length > 5000) {
      json(response, 400, { error: 'قائمة المؤثرين غير صالحة أو تتجاوز 5000 سجل.' }); return;
    }
    const influencerIds = [...new Set(body.influencerIds.filter((id) => typeof id === 'string'))];
    if (!influencerIds.length) { json(response, 400, { error: 'اختر مؤثرًا واحدًا على الأقل.' }); return; }
    const found = getInfluencersByIds(influencerIds);
    if (found.missingIds.length) { json(response, 400, { error: 'تعذر العثور على بعض المؤثرين المختارين؛ لم تتم إضافة أي مؤثر.' }); return; }
    let accountVisibility;
    try { accountVisibility = validateCatalogAccountVisibility(body.accountVisibility, influencerIds, found.rows); }
    catch (error) { json(response, error.status || 400, { error: error.message }); return; }
    const existingIds = new Set(database.prepare('SELECT influencer_id FROM client_catalog_items WHERE catalog_id = ?')
      .all(catalogId).map((row) => row.influencer_id));
    let position = Number(database.prepare('SELECT COALESCE(MAX(position), -1) AS position FROM client_catalog_items WHERE catalog_id = ?').get(catalogId).position) + 1;
    let added = 0;
    database.exec('BEGIN IMMEDIATE');
    try {
      const insert = database.prepare('INSERT OR IGNORE INTO client_catalog_items (catalog_id, influencer_id, position) VALUES (?, ?, ?)');
      for (const influencerId of influencerIds) {
        if (existingIds.has(influencerId)) continue;
        if (insert.run(catalogId, influencerId, position).changes) { added += 1; position += 1; }
      }
      saveCatalogAccountVisibility(catalogId, accountVisibility, found.rows);
      database.prepare('UPDATE client_catalogs SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), catalogId);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 200, { added, alreadyInOffer: influencerIds.length - added, catalog: clientCatalogSummaries().find((item) => item.id === catalogId) });
    return;
  }

  const catalogExportMatch = pathname.match(/^\/api\/client-catalogs\/([a-f0-9]{32})\/export$/);
  if (catalogExportMatch && method === 'POST') {
    const body = await readJson(request);
    const confirmation = await verifySensitiveConfirmation(request, user, body);
    if (!confirmation.ok) { json(response, confirmation.status, { error: confirmation.error }); return; }
    const catalogId = catalogExportMatch[1];
    const catalog = database.prepare(`SELECT id, offer_name AS offerName, client_name AS clientName,
      company_name AS companyName FROM client_catalogs WHERE id = ?`).get(catalogId);
    if (!catalog) { json(response, 404, { error: 'عرض العملاء غير موجود.' }); return; }
    const scope = body.scope || 'approved';
    if (!['approved', 'all'].includes(scope)) { json(response, 400, { error: 'نطاق التصدير غير صالح.' }); return; }
    const rows = database.prepare(`SELECT i.id AS influencerId, i.record_json AS recordJson,
        COALESCE(d.decision, 'pending') AS decision, COALESCE(d.created_at, '') AS decisionDate
      FROM client_catalog_items ci
      JOIN influencers i ON i.id = ci.influencer_id
      LEFT JOIN client_catalog_decisions d ON d.catalog_id = ci.catalog_id AND d.influencer_id = ci.influencer_id
      WHERE ci.catalog_id = ? ${scope === 'approved' ? "AND d.decision = 'accepted'" : ''}
      ORDER BY ci.position`).all(catalogId).map((row) => {
      const record = JSON.parse(row.recordJson);
      const platform = String(record['Best Platform'] || '');
      const followerField = platform === 'TikTok' ? 'Followers Count T' : platform === 'Snapchat' ? 'Followers Count S' : 'Followers Count I';
      const usernameField = platform === 'TikTok' ? 'Username T' : platform === 'Snapchat' ? 'Username' : 'Username I';
      return {
        'Influencer ID': row.influencerId,
        'اسم المؤثر': String(record.Name || ''),
        'اسم المستخدم': String(record.Main_Username || record[usernameField] || ''),
        'المنصة': platform,
        'المدينة': String(record.City || ''),
        'عدد المتابعين': String(record[followerField] || ''),
        'حالة القرار': row.decision,
        'تاريخ القرار': row.decisionDate
      };
    });
    json(response, 200, { catalog: { ...catalog, id: catalogId }, scope, rows });
    return;
  }

  if (pathname === '/api/client-catalogs' && method === 'POST') {
    if (user.role !== 'admin') { json(response, 403, { error: 'تجهيز عروض العملاء متاح للمدير فقط.' }); return; }
    const body = await readJson(request);
    const clientName = String(body.clientName || '').trim();
    const companyName = String(body.companyName || '').trim();
    const offerName = String(body.offerName || companyName).trim();
    const offerStatus = String(body.offerStatus || 'published');
    const brandId = String(body.brandId || '');
    const brand = getBrandSettings(brandId);
    let expiresAt;
    try { expiresAt = normalizeCatalogExpiry(body.expiresAt); }
    catch (error) { json(response, error.status || 400, { error: error.message }); return; }
    if (!brand) { json(response, 400, { error: 'اختر هوية تجارية صالحة قبل إنشاء العرض.' }); return; }
    const influencerIds = Array.isArray(body.influencerIds) ? [...new Set(body.influencerIds.filter((id) => typeof id === 'string'))] : [];
    const showCity = asBoolean(body.showCity, true);
    const showCategory = asBoolean(body.showCategory, true);
    const showDetails = asBoolean(body.showDetails, false);
    const showCompanyWork = asBoolean(body.showCompanyWork, false);
    const workVideoIds = validateCompanyWorkVideoIds(body.workVideoIds || []);
    if (brandId === 'ryfaq' && (showCompanyWork || workVideoIds.length)) {
      json(response, 400, { error: 'مكتبة أعمال فكرتك غير متاحة في عروض رفاق.' }); return;
    }
    if (clientName.length > 100 || !companyName || companyName.length > 150 || !offerName || offerName.length > 150) {
      json(response, 400, { error: 'أدخل اسم العرض والشركة، واجعل اسم العميل ضمن 100 حرف عند استخدامه.' });
      return;
    }
    if (!influencerIds.length) {
      json(response, 400, { error: 'اختر مؤثرًا واحدًا على الأقل.' });
      return;
    }
    const found = getInfluencersByIds(influencerIds);
    if (found.missingIds.length) { json(response, 400, { error: 'بعض المؤثرين المحددين لم يعودوا موجودين.' }); return; }
    const catalogId = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('base64url');
    let accountVisibility;
    try { accountVisibility = validateCatalogAccountVisibility(body.accountVisibility, influencerIds, found.rows); }
    catch (error) { json(response, error.status || 400, { error: error.message }); return; }
    database.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO client_catalogs
        (id, token_hash, client_name, company_name, offer_name, offer_status,
         show_city, show_category, show_details, show_company_work, expires_at, active, created_at, updated_at,
         brand_id, brand_snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
        .run(catalogId, tokenHash(token), clientName, companyName, offerName, offerStatus,
          Number(showCity), Number(showCategory), Number(showDetails), Number(showCompanyWork), expiresAt, now, now,
          brandId, JSON.stringify(brand));
      const insertItem = database.prepare('INSERT INTO client_catalog_items (catalog_id, influencer_id, position) VALUES (?, ?, ?)');
      influencerIds.forEach((id, position) => insertItem.run(catalogId, id, position));
      saveCatalogAccountVisibility(catalogId, accountVisibility, found.rows);
      const insertVideo = database.prepare('INSERT INTO client_catalog_work_videos (catalog_id, video_id, position) VALUES (?, ?, ?)');
      workVideoIds.forEach((id, position) => insertVideo.run(catalogId, id, position));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    const catalog = clientCatalogSummaries().find((item) => item.id === catalogId);
    json(response, 201, { catalog, url: `/client/${token}` });
    return;
  }

  const showcasePreviewMatch = pathname.match(/^\/api\/client-catalogs\/([a-f0-9]{32})\/showcase-preview$/);
  if (showcasePreviewMatch && method === 'GET') {
    if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'معاينة عرض العميل متاحة للفريق فقط.' }); return; }
    const catalog = database.prepare(`SELECT id, offer_name AS title, client_name AS clientName,
        company_name AS companyName, active, offer_status AS offerStatus
      FROM client_catalogs WHERE id = ?`).get(showcasePreviewMatch[1]);
    if (!catalog) { json(response, 404, { error: 'عرض العميل غير موجود.' }); return; }
    const total = Number(database.prepare('SELECT COUNT(*) AS count FROM client_catalog_items WHERE catalog_id = ?').get(catalog.id).count);
    if (total > 1000) { json(response, 413, { error: 'قسّم العرض إلى قوائم أصغر لمعاينته.' }); return; }
    const items = database.prepare(`SELECT i.id, i.record_json FROM client_catalog_items ci
      JOIN influencers i ON i.id = ci.influencer_id
      WHERE ci.catalog_id = ? ORDER BY ci.position`).all(catalog.id).map((row) => {
      const record = JSON.parse(row.record_json || '{}');
      return {
        id: row.id,
        ...clientShowcaseRecord(record, {}, catalogAccountVisibilityMap(catalog.id, row.id, record))
      };
    });
    json(response, 200, {
      client: { clientName: catalog.clientName, companyName: catalog.companyName },
      list: { id: catalog.id, title: catalog.title, companyName: catalog.companyName, total },
      categories: [...new Set(items.flatMap((item) => item.categories))].sort(),
      cities: [...new Set(items.map((item) => item.city).filter(Boolean))].sort(),
      items
    });
    return;
  }

  const clientCatalogMatch = pathname.match(/^\/api\/client-catalogs\/([a-f0-9]{32})(?:\/(link))?$/);
  if (clientCatalogMatch && (method === 'PATCH' || method === 'POST' || method === 'DELETE')) {
    if (user.role !== 'admin') { json(response, 403, { error: 'إدارة عروض العملاء متاحة للمدير فقط.' }); return; }
    const [, catalogId, action] = clientCatalogMatch;
    const existing = database.prepare('SELECT id FROM client_catalogs WHERE id = ?').get(catalogId);
    if (!existing) { json(response, 404, { error: 'عرض العميل غير موجود.' }); return; }
    if (method === 'PATCH' && !action) {
      const body = await readJson(request);
      const updates = [];
      const values = [];
      if (body.offerName !== undefined) {
        const offerName = String(body.offerName || '').trim();
        if (!offerName || offerName.length > 150) { json(response, 400, { error: 'اسم العرض مطلوب وبحد أقصى 150 حرفًا.' }); return; }
        updates.push('offer_name = ?'); values.push(offerName);
      }
      if (body.clientName !== undefined) {
        const clientName = String(body.clientName || '').trim();
        if (clientName.length > 100) { json(response, 400, { error: 'اسم العميل يتجاوز 100 حرف.' }); return; }
        updates.push('client_name = ?'); values.push(clientName);
      }
      if (body.companyName !== undefined) {
        const companyName = String(body.companyName || '').trim();
        if (!companyName || companyName.length > 150) { json(response, 400, { error: 'اسم الشركة مطلوب وبحد أقصى 150 حرفًا.' }); return; }
        updates.push('company_name = ?'); values.push(companyName);
      }
      if (body.offerStatus !== undefined) {
        if (!['draft', 'published', 'archived'].includes(body.offerStatus)) { json(response, 400, { error: 'حالة العرض غير صالحة.' }); return; }
        updates.push('offer_status = ?'); values.push(body.offerStatus);
      }
      if (body.expiresAt !== undefined) {
        let expiresAt;
        try { expiresAt = normalizeCatalogExpiry(body.expiresAt); }
        catch (error) { json(response, error.status || 400, { error: error.message }); return; }
        updates.push('expires_at = ?'); values.push(expiresAt);
      }
      if (body.influencerIds !== undefined) {
        if (!Array.isArray(body.influencerIds)) { json(response, 400, { error: 'قائمة المؤثرين غير صالحة.' }); return; }
        const influencerIds = [...new Set(body.influencerIds.filter((id) => typeof id === 'string'))];
        const found = getInfluencersByIds(influencerIds);
        if (found.missingIds.length) {
          json(response, 400, { error: 'تعذر العثور على بعض المؤثرين؛ لم يتم تغيير العرض.' }); return;
        }
        const existingIds = database.prepare('SELECT influencer_id FROM client_catalog_items WHERE catalog_id = ? ORDER BY position')
          .all(catalogId).map((row) => row.influencer_id);
        const knownIds = new Set(existingIds);
        const orderedIds = [...influencerIds, ...existingIds.filter((id) => !influencerIds.includes(id))];
        const allFound = getInfluencersByIds(orderedIds);
        let accountVisibility;
        try { accountVisibility = validateCatalogAccountVisibility(body.accountVisibility, orderedIds, allFound.rows); }
        catch (error) { json(response, error.status || 400, { error: error.message }); return; }
        database.exec('BEGIN IMMEDIATE');
        try {
          database.prepare(`UPDATE client_catalogs SET ${updates.length ? `${updates.join(', ')}, ` : ''}updated_at = ? WHERE id = ?`)
            .run(...values, new Date().toISOString(), catalogId);
          const insertItem = database.prepare('INSERT INTO client_catalog_items (catalog_id, influencer_id, position) VALUES (?, ?, ?)');
          const updatePosition = database.prepare('UPDATE client_catalog_items SET position = ? WHERE catalog_id = ? AND influencer_id = ?');
          orderedIds.forEach((id, position) => {
            if (knownIds.has(id)) updatePosition.run(position, catalogId, id);
            else insertItem.run(catalogId, id, position);
          });
          saveCatalogAccountVisibility(catalogId, accountVisibility, allFound.rows);
          database.exec('COMMIT');
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
        json(response, 200, { catalog: clientCatalogSummaries().find((item) => item.id === catalogId) });
        return;
      }
      if (body.active !== undefined) {
        const activeValue = asBoolean(body.active, null);
        if (activeValue !== null) {
          updates.push('active = ?');
          values.push(Number(activeValue));
        }
      }
      if (body.showCity !== undefined) {
        const cityValue = asBoolean(body.showCity, null);
        if (cityValue !== null) {
          updates.push('show_city = ?');
          values.push(Number(cityValue));
        }
      }
      if (body.showCategory !== undefined) {
        const categoryValue = asBoolean(body.showCategory, null);
        if (categoryValue !== null) {
          updates.push('show_category = ?');
          values.push(Number(categoryValue));
        }
      }
      if (body.showDetails !== undefined) {
        const detailsValue = asBoolean(body.showDetails, null);
        if (detailsValue !== null) {
          updates.push('show_details = ?');
          values.push(Number(detailsValue));
        }
      }
      if (body.showCompanyWork !== undefined) {
        const showWorkValue = asBoolean(body.showCompanyWork, null);
        if (showWorkValue === null) { json(response, 400, { error: 'خيار عرض أعمال فكرتك غير صالح.' }); return; }
        updates.push('show_company_work = ?');
        values.push(Number(showWorkValue));
      }
      let workVideoIds;
      if (body.workVideoIds !== undefined) {
        const retainedIds = database.prepare('SELECT video_id FROM client_catalog_work_videos WHERE catalog_id = ?')
          .all(catalogId).map((row) => row.video_id);
        workVideoIds = validateCompanyWorkVideoIds(body.workVideoIds, retainedIds);
      }
      if (!updates.length && workVideoIds === undefined) { json(response, 400, { error: 'حالة العرض أو إعداداته غير صالحة.' }); return; }
      updates.push('updated_at = ?'); values.push(new Date().toISOString());
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`UPDATE client_catalogs SET ${updates.join(', ')} WHERE id = ?`).run(...values, catalogId);
        if (workVideoIds !== undefined) {
          database.prepare('DELETE FROM client_catalog_work_videos WHERE catalog_id = ?').run(catalogId);
          const insertVideo = database.prepare('INSERT INTO client_catalog_work_videos (catalog_id, video_id, position) VALUES (?, ?, ?)');
          workVideoIds.forEach((id, position) => insertVideo.run(catalogId, id, position));
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      json(response, 200, { catalog: clientCatalogSummaries().find((item) => item.id === catalogId) });
      return;
    }
    if (method === 'POST' && action === 'link') {
      const token = randomBytes(32).toString('base64url');
      database.prepare('UPDATE client_catalogs SET token_hash = ?, active = 1 WHERE id = ?').run(tokenHash(token), catalogId);
      json(response, 200, { url: `/client/${token}` });
      return;
    }
    if (method === 'DELETE' && !action) {
      database.prepare('DELETE FROM client_catalogs WHERE id = ?').run(catalogId);
      json(response, 200, { ok: true });
      return;
    }
  }

  if (pathname === '/api/client-inquiries' && method === 'GET') {
    if (user.role !== 'admin') { json(response, 403, { error: 'طلبات العملاء متاحة للمدير فقط.' }); return; }
    const inquiries = database.prepare(`
      SELECT q.id, q.customer_name AS customerName, q.customer_contact AS customerContact,
        q.created_at AS createdAt, c.client_name AS clientName, c.company_name AS companyName,
        json_extract(i.record_json, '$.Name') AS influencerName
      FROM client_inquiries q
      JOIN client_catalogs c ON c.id = q.catalog_id
      JOIN influencers i ON i.id = q.influencer_id
      ORDER BY q.created_at DESC
    `).all();
    json(response, 200, { inquiries });
    return;
  }

  const influencerMatch = pathname.match(/^\/api\/influencers\/([^/]+)$/);
  if (influencerMatch) {
    let id;
    try { id = decodeURIComponent(influencerMatch[1]); }
    catch { json(response, 400, { error: 'معرّف السجل غير صالح.' }); return; }
    if (method === 'PUT') {
      if (!requireRole(user, ['admin', 'editor'])) { json(response, 403, { error: 'صلاحيتك لا تسمح بتعديل السجلات.' }); return; }
      const exists = database.prepare('SELECT id, record_json, archived_at FROM influencers WHERE id = ?').get(id);
      if (!exists) { json(response, 404, { error: 'السجل غير موجود.' }); return; }
      if (exists.archived_at) { json(response, 409, { error: 'أعد السجل من الأرشيف قبل تعديله.' }); return; }
      const input = await readJson(request);
      const record = normalizeRecord(input);
      const previous = JSON.parse(exists.record_json);
      if (!Object.hasOwn(input, 'Influencer Status')) {
        record['Influencer Status'] = previous['Influencer Status'] === 'Inactive' ? 'Inactive' : 'Active';
      } else if (record['Influencer Status'] !== (previous['Influencer Status'] === 'Inactive' ? 'Inactive' : 'Active')) {
        json(response, 400, { error: 'غيّر الحالة من إجراء الحالة المؤكد لتسجيل السبب والتاريخ.' }); return;
      }
      const accountConflict = findChangedSocialAccountConflict(record, id, previous);
      if (accountConflict) {
        json(response, 409, {
          error: `حساب ${accountConflict.platform} مرتبط بالفعل بالمؤثر: ${accountConflict.influencerNames.join('، ') || accountConflict.influencerIds.join('، ')}؛ لم يتم تغيير الملكية.`,
          conflict: accountConflict
        });
        return;
      }
      json(response, 200, { record: saveInfluencer(id, record) });
      return;
    }
    if (method === 'DELETE') {
      if (user.role !== 'admin') { json(response, 403, { error: 'حذف السجلات متاح للمدير فقط.' }); return; }
      database.exec('BEGIN IMMEDIATE');
      try {
        const existing = database.prepare('SELECT record_json, archived_at FROM influencers WHERE id = ?').get(id);
        if (!existing) { database.exec('ROLLBACK'); json(response, 404, { error: 'السجل غير موجود.' }); return; }
        if (existing.archived_at) { database.exec('ROLLBACK'); json(response, 409, { error: 'السجل مؤرشف بالفعل.' }); return; }
        const record = JSON.parse(existing.record_json);
        const previousStatus = record['Influencer Status'] === 'Inactive' ? 'Inactive' : 'Active';
        const previousWorkflow = normalizeWorkflow(record['Workflow Status']);
        const now = new Date().toISOString();
        record['Influencer Status'] = 'Inactive';
        record['Workflow Status'] = 'Archived';
        saveInfluencer(id, record);
        database.prepare(`UPDATE influencers SET archived_at = ?, archived_by = ?,
          archive_previous_status = ?, archive_previous_workflow = ? WHERE id = ?`)
          .run(now, user.username, previousStatus, previousWorkflow, id);
        database.prepare(`INSERT INTO influencer_status_history
          (id, influencer_id, previous_status, status, reason, actor_user_id, actor_username, changed_at)
          VALUES (?, ?, ?, 'Inactive', ?, ?, ?, ?)`)
          .run(randomBytes(16).toString('hex'), id, previousStatus, 'تمت أرشفة السجل بطلب المدير مع الحفاظ على بياناته المرتبطة.',
            user.id, user.username, now);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      json(response, 200, { ok: true, archived: true });
      return;
    }
  }

  const influencerRestoreMatch = pathname.match(/^\/api\/influencers\/([^/]+)\/restore$/);
  if (influencerRestoreMatch && method === 'POST') {
    if (user.role !== 'admin') { json(response, 403, { error: 'استعادة السجلات المؤرشفة متاحة للمدير فقط.' }); return; }
    const id = decodeURIComponent(influencerRestoreMatch[1]);
    database.exec('BEGIN IMMEDIATE');
    let restoredRecord;
    try {
      const existing = database.prepare(`SELECT record_json, archived_at, archive_previous_status,
          archive_previous_workflow FROM influencers WHERE id = ?`).get(id);
      if (!existing) { database.exec('ROLLBACK'); json(response, 404, { error: 'السجل غير موجود.' }); return; }
      if (!existing.archived_at) { database.exec('ROLLBACK'); json(response, 409, { error: 'السجل غير مؤرشف.' }); return; }
      const record = JSON.parse(existing.record_json);
      const previousStatus = record['Influencer Status'] === 'Inactive' ? 'Inactive' : 'Active';
      const restoredStatus = existing.archive_previous_status === 'Inactive' ? 'Inactive' : 'Active';
      record['Influencer Status'] = restoredStatus;
      record['Workflow Status'] = existing.archive_previous_workflow || 'new';
      saveInfluencer(id, record);
      database.prepare(`UPDATE influencers SET archived_at = NULL, archived_by = NULL WHERE id = ?`).run(id);
      const now = new Date().toISOString();
      if (previousStatus !== restoredStatus) {
        database.prepare(`INSERT INTO influencer_status_history
          (id, influencer_id, previous_status, status, reason, actor_user_id, actor_username, changed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(randomBytes(16).toString('hex'), id, previousStatus, restoredStatus, 'استعادة المعلن من الأرشيف.',
            user.id, user.username, now);
      }
      database.exec('COMMIT');
      restoredRecord = { ...record, id };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    json(response, 200, { ok: true, record: restoredRecord });
      return;
  }

  if (pathname === '/api/users' && method === 'GET') {
    if (user.role !== 'admin') { json(response, 403, { error: 'إدارة المستخدمين متاحة للمدير فقط.' }); return; }
    const rows = database.prepare('SELECT id, username, role, active, created_at FROM users ORDER BY username COLLATE NOCASE').all();
    json(response, 200, { users: rows.map((row) => ({ ...userView(row), createdAt: row.created_at })) });
    return;
  }

  if (pathname === '/api/users' && method === 'POST') {
    if (user.role !== 'admin') { json(response, 403, { error: 'إدارة المستخدمين متاحة للمدير فقط.' }); return; }
    const body = await readJson(request);
    const username = normalizeUsername(body.username);
    const role = String(body.role || 'viewer');
    if (!validateUsername(username)) { json(response, 400, { error: 'اكتب اسم مستخدم من 3 إلى 32 حرفًا، باستخدام الحروف أو الأرقام أو المسافات أو إحدى العلامات: . _ -' }); return; }
    if (!roles.has(role)) { json(response, 400, { error: 'الدور المحدد غير صالح.' }); return; }
    if (!validatePassword(body.password)) { json(response, 400, { error: `كلمة المرور يجب أن تكون بين ${passwordMinLength} و${passwordMaxLength} أحرف.` }); return; }
    const credentials = await hashPassword(body.password);
    const newUser = { id: randomBytes(16).toString('hex'), username, role, active: 1 };
    try {
      database.prepare('INSERT INTO users (id, username, salt, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .run(newUser.id, username, credentials.salt, credentials.hash, role, new Date().toISOString());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) { json(response, 409, { error: 'اسم المستخدم مستخدم بالفعل.' }); return; }
      throw error;
    }
    json(response, 201, { user: userView(newUser) });
    return;
  }

  const userMatch = pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && method === 'PUT') {
    if (user.role !== 'admin') { json(response, 403, { error: 'إدارة المستخدمين متاحة للمدير فقط.' }); return; }
    const id = decodeURIComponent(userMatch[1]);
    const target = database.prepare('SELECT id, username, role, active FROM users WHERE id = ?').get(id);
    if (!target) { json(response, 404, { error: 'المستخدم غير موجود.' }); return; }
    const body = await readJson(request);
    const nextRole = body.role === undefined ? target.role : String(body.role);
    const nextActive = body.active === undefined ? Boolean(target.active) : Boolean(body.active);
    if (!roles.has(nextRole)) { json(response, 400, { error: 'الدور المحدد غير صالح.' }); return; }
    if (id === user.id && !nextActive) { json(response, 400, { error: 'لا يمكنك تعطيل حسابك أثناء استخدامه.' }); return; }
    const activeAdmins = database.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get().count;
    if (target.role === 'admin' && target.active && (nextRole !== 'admin' || !nextActive) && activeAdmins <= 1) {
      json(response, 409, { error: 'يجب إبقاء مدير نشط واحد على الأقل.' });
      return;
    }
    if (body.password !== undefined && !validatePassword(body.password)) {
      json(response, 400, { error: `كلمة المرور الجديدة يجب أن تكون بين ${passwordMinLength} و${passwordMaxLength} أحرف.` });
      return;
    }
    if (body.password) {
      const credentials = await hashPassword(body.password);
      database.prepare('UPDATE users SET role = ?, active = ?, salt = ?, password_hash = ? WHERE id = ?')
        .run(nextRole, Number(nextActive), credentials.salt, credentials.hash, id);
      for (const [token, session] of sessions) if (session.userId === id) sessions.delete(token);
    } else {
      database.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').run(nextRole, Number(nextActive), id);
      if (!nextActive) for (const [token, session] of sessions) if (session.userId === id) sessions.delete(token);
    }
    const updated = database.prepare('SELECT id, username, role, active FROM users WHERE id = ?').get(id);
    json(response, 200, { user: userView(updated) });
    return;
  }

  json(response, 404, { error: 'المسار غير موجود.' });
}

async function handleRequest(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
  response.setHeader('Cache-Control', 'no-store');
  let url;
  try { url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`); }
  catch { json(response, 400, { error: 'عنوان الطلب غير صالح.' }); return; }

  if (request.method === 'GET' && url.pathname === '/health') {
    json(response, 200, { status: 'ok' });
    return;
  }

  const profileImageMatch = url.pathname.match(/^\/profile-images\/([a-f0-9]{32})$/);
  if ((request.method === 'GET' || request.method === 'HEAD') && profileImageMatch) {
    try {
      const [, influencerId] = profileImageMatch;
      const image = database.prepare(`SELECT mime_type AS mimeType, image_data AS imageData,
        content_hash AS contentHash FROM influencer_profile_images WHERE influencer_id = ?`).get(influencerId);
      if (!image) {
        const row = database.prepare('SELECT record_json AS recordJson FROM influencers WHERE id = ?').get(influencerId);
        const avatarName = {
          '/assets/avatars/female.svg': 'female.svg',
          '/assets/avatars/female-hijab.svg': 'female-hijab.svg',
          '/assets/avatars/male.svg': 'male.svg',
          '/assets/avatars/neutral.svg': 'neutral.svg'
        }[profilePlaceholderUrl(row ? JSON.parse(row.recordJson || '{}') : {})];
        if (!row || url.searchParams.has('v') || !avatarName) {
          throw Object.assign(new Error('Profile image was not found.'), { code: 'ENOENT' });
        }
        const content = await readFile(resolve(projectDir, 'assets', 'avatars', avatarName));
        response.writeHead(200, {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Content-Length': content.length
        });
        response.end(request.method === 'HEAD' ? undefined : content);
        return;
      }
      if (url.searchParams.get('v') && url.searchParams.get('v') !== image.contentHash.slice(0, 12)) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('الصورة غير موجودة.');
        return;
      }
      const content = image.imageData;
      response.writeHead(200, {
        'Content-Type': image.mimeType, 'Content-Length': content.length,
        'Cache-Control': 'public, max-age=31536000, immutable'
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (error.code !== 'ENOENT') logFailure('Profile image could not be loaded', error);
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error.code === 'ENOENT' ? 'الصورة غير موجودة.' : 'تعذر تحميل الصورة.');
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const releaseApiLock = await acquireApiRequestLock();
    const auditContext = {
      request, user: getSessionUser(request), client: getClientSessionAccount(request),
      before: auditEntitySnapshot(url.pathname), status: 500, value: null, extraHeaders: {}
    };
    const transactionRequired = request.method !== 'GET' && request.method !== 'HEAD'
      && url.pathname !== '/api/backups/create';
    let transactionStarted = false;
    let auditAttempted = false;
    auditResponseContexts.set(response, auditContext);
    try {
      if (transactionRequired) {
        executeDatabaseSql('BEGIN IMMEDIATE');
        apiTransaction = { savepoints: [] };
        transactionStarted = true;
      }
      try { await handleApi(request, response, url); }
      catch (error) {
        const socialAccountConflict = String(error.message).includes('social_account_conflict');
        const status = error.status || (socialAccountConflict || String(error.message).includes('UNIQUE') ? 409 : 500);
        if (status >= 500) logFailure('Request failed', error);
        auditContext.status = status;
        auditContext.value = {
          error: status === 500 ? 'حدث خطأ داخلي.'
            : socialAccountConflict ? 'هذا الحساب مرتبط بالفعل بمؤثر آخر؛ لم يتم تغيير الملكية.'
              : error.message
        };
      }
      if (response.headersSent || response.writableEnded) {
        if (transactionStarted) executeDatabaseSql('ROLLBACK');
        return;
      }
      auditResponseContexts.delete(response);
      if (transactionStarted && auditContext.status >= 200 && auditContext.status < 400) {
        if (apiTransaction.savepoints.length) throw new Error('Unclosed nested database transaction.');
        auditAttempted = true;
        recordAuditContext(auditContext);
        executeDatabaseSql('COMMIT');
        transactionStarted = false;
      } else {
        if (transactionStarted) {
          executeDatabaseSql('ROLLBACK');
          transactionStarted = false;
        }
        await restoreInfluencerExcelSnapshot(auditContext);
        auditAttempted = true;
        recordAuditContext(auditContext);
      }
    } catch (error) {
      if (transactionStarted) {
        try { executeDatabaseSql('ROLLBACK'); }
        catch (rollbackError) { logFailure('API transaction rollback failed', rollbackError); }
        transactionStarted = false;
      }
      try { await restoreInfluencerExcelSnapshot(auditContext); }
      catch (restoreError) { logFailure('Unconfirmed Excel backup rollback failed', restoreError); }
      logFailure('API transaction or audit persistence failed', error);
      if (url.pathname === '/api/backups/create'
        && typeof auditContext.value?.file === 'string'
        && /^fikratak-\d{4}-\d{2}-\d{2}-\d{6}-[a-f0-9]{6}\.sqlite$/.test(auditContext.value.file)) {
        try { await rm(resolve(backupDir, auditContext.value.file), { force: true }); }
        catch (cleanupError) { logFailure('Unconfirmed backup cleanup failed', cleanupError); }
      }
      auditContext.status = 503;
      auditContext.value = { error: 'تعذر إكمال العملية وتأكيد سجل التدقيق؛ لم يتم اعتماد تغييرات قاعدة البيانات.' };
      auditContext.extraHeaders = {};
      if (transactionRequired && !auditAttempted) {
        auditAttempted = true;
        try { recordAuditContext(auditContext); }
        catch (auditError) { logFailure('Failed API audit event could not be persisted', auditError); }
      }
    } finally {
      apiTransaction = null;
      auditResponseContexts.delete(response);
      releaseApiLock();
    }
    if (response.headersSent || response.writableEnded) return;
    response.writeHead(auditContext.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      ...auditContext.extraHeaders
    });
    response.end(JSON.stringify(auditContext.value ?? {}));
    return;
  }

  const campaignCheckinPage = url.pathname.match(/^\/campaign-checkin\/([A-Za-z0-9_-]{24,48})$/);
  if ((request.method === 'GET' || request.method === 'HEAD') && campaignCheckinPage) {
    const token = campaignCheckinPage[1];
    const content = Buffer.from(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>تأكيد إجراء الحملة</title><style>body{font:16px system-ui,sans-serif;background:#eff7fb;color:#193c50;min-height:100vh;display:grid;place-items:center;margin:0}.card{width:min(92vw,460px);box-sizing:border-box;background:white;border:1px solid #d7e8f1;border-radius:18px;padding:28px;box-shadow:0 16px 48px #153d291a}h1{font-size:22px}.muted{color:#627887;line-height:1.8}button,select{min-height:42px;padding:0 12px;border:1px solid #cbdfe9;border-radius:8px;background:white;font:inherit}button{color:white;background:#2D82C4;border:0;cursor:pointer}#state{padding:14px;border-radius:10px;background:#edf6fa;line-height:1.8}.row{display:grid;gap:12px;margin-top:14px}</style><main class="card"><h1>تأكيد إجراء الحملة</h1><p class="muted">فتح رمز QR لا يسجل أي إجراء. سجّل الدخول بحساب إدارة ثم اختر الإجراء واضغط تأكيد.</p><div class="row"><label>الإجراء <select id="action"><option value="visit">تأكيد إتمام الزيارة</option><option value="coverage">تأكيد اكتمال التغطية</option></select></label><button id="confirm" type="button">تأكيد الإجراء</button><div id="state" role="status" aria-live="polite">لا توجد تغييرات مسجلة.</div><a href="/" target="_blank" rel="noopener noreferrer">تسجيل الدخول إلى النظام</a></div></main><script>'use strict';document.querySelector('#confirm').addEventListener('click',async()=>{if(!confirm('هل تريد تسجيل هذا الإجراء؟ لا يمكن تكراره بعد التأكيد.'))return;const button=document.querySelector('#confirm');button.disabled=true;const state=document.querySelector('#state');try{const response=await fetch('/api/campaign-checkin/${token}',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:document.querySelector('#action').value})});const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.error||'تعذر تسجيل الإجراء.');state.textContent='تم التأكيد: '+result.influencerName+' — '+result.campaignName}catch(error){state.textContent=error.message;button.disabled=false}});</script></html>`);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': content.length });
    response.end(request.method === 'HEAD' ? undefined : content);
    return;
  }

  if ((request.method === 'GET' || request.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const content = await readFile(resolve(projectDir, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('تعذر تحميل واجهة التطبيق.');
    }
    return;
  }

  const campaignPresentationPage = url.pathname.match(/^\/campaign-presentation\/([A-Za-z0-9_-]{40,60})$/);
  if ((request.method === 'GET' || request.method === 'HEAD') && campaignPresentationPage) {
    try {
      const content = await readFile(resolve(projectDir, 'campaign-presentation.html'));
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Length': content.length,
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; frame-src https://www.youtube-nocookie.com https://www.youtube.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      logFailure('Campaign presentation page could not be loaded', error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('تعذر تحميل عرض الحملة.');
    }
    return;
  }

  if ((request.method === 'GET' || request.method === 'HEAD') && ['/portal', '/portal.html'].includes(url.pathname)) {
    try {
      const content = await readFile(resolve(projectDir, 'portal.html'));
      response.setHeader('X-Frame-Options', 'SAMEORIGIN');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'self'; base-uri 'self'");
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      logFailure('Client portal page could not be loaded', error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('تعذر تحميل بوابة العميل.');
    }
    return;
  }

  if ((request.method === 'GET' || request.method === 'HEAD') && ['/showcase', '/showcase.html'].includes(url.pathname)) {
    try {
      const content = await readFile(resolve(projectDir, 'showcase.html'));
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      logFailure('Client showcase page could not be loaded', error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('تعذر تحميل معرض العميل.');
    }
    return;
  }

  if ((request.method === 'GET' || request.method === 'HEAD') && ['/client-accounts', '/client-accounts.html'].includes(url.pathname)) {
    try {
      const content = await readFile(resolve(projectDir, 'client-accounts.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      logFailure('Client account management page could not be loaded', error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('تعذر تحميل إدارة حسابات العملاء.');
    }
    return;
  }

  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/client-preview') {
    try {
      const content = await readFile(resolve(projectDir, 'client.html'));
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': content.length,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; object-src 'none'; frame-ancestors 'self'; base-uri 'self'"
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      logFailure('Failed to serve client preview page', error);
      json(response, 500, { error: 'تعذر تحميل معاينة العميل.' });
    }
    return;
  }
  if ((request.method === 'GET' || request.method === 'HEAD') && /^\/client\/[A-Za-z0-9_-]{40,60}$/.test(url.pathname)) {
    try {
      const content = await readFile(resolve(projectDir, 'client.html'));
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': content.length,
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.ytimg.com; frame-src https://www.youtube-nocookie.com https://www.youtube.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      logFailure('Client presentation page could not be loaded', error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('تعذر تحميل صفحة العرض.');
    }
    return;
  }

  const staticAsset = {
    '/assets/fikratak-design.css': ['fikratak-design.css', 'text/css; charset=utf-8'],
    '/assets/admin.css': ['admin.css', 'text/css; charset=utf-8'],
    '/assets/client-accounts.css': ['client-accounts.css', 'text/css; charset=utf-8'],
    '/assets/client.css': ['client.css', 'text/css; charset=utf-8'],
    '/assets/portal.css': ['portal.css', 'text/css; charset=utf-8'],
    '/assets/presentation.css': ['presentation.css', 'text/css; charset=utf-8'],
    '/assets/showcase.css': ['showcase.css', 'text/css; charset=utf-8'],
    '/assets/showcase.js': ['showcase.js', 'text/javascript; charset=utf-8'],
    '/assets/icons.js': ['icons.js', 'text/javascript; charset=utf-8'],
    '/assets/icons/sprite.svg': ['icons/sprite.svg', 'image/svg+xml; charset=utf-8'],
    '/assets/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
    '/assets/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
    '/assets/follower-tiers.js': ['follower-tiers.js', 'text/javascript; charset=utf-8'],
    '/assets/influencer-field-options.js': ['influencer-field-options.js', 'text/javascript; charset=utf-8'],
    '/assets/password-visibility.js': ['password-visibility.js', 'text/javascript; charset=utf-8'],
    '/assets/logo.png': ['logo.png', 'image/png'],
    '/assets/fikratak-digital-logo.png': ['fikratak-digital-logo.png', 'image/png'],
    '/assets/country-locations.js': ['country-locations.js', 'text/javascript; charset=utf-8'],
    '/assets/cairo-arabic.woff2': ['cairo-arabic.woff2', 'font/woff2'],
    '/assets/cairo-latin.woff2': ['cairo-latin.woff2', 'font/woff2'],
    '/assets/platform-instagram.jpg': ['platform-instagram.jpg', 'image/jpeg'],
    '/assets/platform-tiktok.jpg': ['platform-tiktok.jpg', 'image/jpeg'],
    '/assets/platform-snapchat.png': ['platform-snapchat.png', 'image/png'],
    '/assets/flag-saudi-arabia.png': ['flag-saudi-arabia.png', 'image/png'],
    '/assets/influencer-placeholder-male.svg': ['influencer-placeholder-male.svg', 'image/svg+xml; charset=utf-8'],
    '/assets/influencer-placeholder-female.svg': ['influencer-placeholder-female.svg', 'image/svg+xml; charset=utf-8'],
    '/assets/influencer-placeholder-neutral.svg': ['influencer-placeholder-neutral.svg', 'image/svg+xml; charset=utf-8'],
    '/assets/avatars/female.svg': ['avatars/female.svg', 'image/svg+xml; charset=utf-8'],
    '/assets/avatars/female-hijab.svg': ['avatars/female-hijab.svg', 'image/svg+xml; charset=utf-8'],
    '/assets/avatars/male.svg': ['avatars/male.svg', 'image/svg+xml; charset=utf-8'],
    '/assets/avatars/neutral.svg': ['avatars/neutral.svg', 'image/svg+xml; charset=utf-8']
  }[url.pathname];
  if ((request.method === 'GET' || request.method === 'HEAD') && staticAsset) {
    try {
      const content = await readFile(resolve(projectDir, 'assets', staticAsset[0]));
      response.writeHead(200, { 'Content-Type': staticAsset[1], 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (error) {
      logFailure(`Static asset could not be loaded (${url.pathname})`, error);
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('تعذر تحميل الملف المطلوب.');
    }
    return;
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('غير موجود.');
}

const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    logFailure('Unhandled HTTP request failure', error);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    json(response, 500, { error: 'حدث خطأ داخلي.' });
  });
});
server.headersTimeout = 30_000;
server.requestTimeout = 120_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
server.listen(port, host, () => {
  console.log(`Fikratak CRM listening on ${host}:${port}`);
  if (database.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0) console.log('أنشئ حساب المدير من هذا الجهاز عند فتح النظام لأول مرة.');
});

void runDailyBackup();
setInterval(() => { void runDailyBackup(); }, 15 * 60 * 1000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  for (const [token, session] of clientSessions) if (session.expiresAt <= now) clientSessions.delete(token);
  for (const [ip, entry] of loginAttempts) if (entry.lockedUntil && entry.lockedUntil + 60 * 60 * 1000 < now) loginAttempts.delete(ip);
  for (const [key, entry] of resetAttempts) if (entry.expiresAt <= now) resetAttempts.delete(key);
}, 60 * 1000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    const forceClose = setTimeout(() => server.closeAllConnections(), 15_000);
    forceClose.unref();
    server.close(() => {
      clearTimeout(forceClose);
      database.close();
    });
    server.closeIdleConnections();
  });
}
