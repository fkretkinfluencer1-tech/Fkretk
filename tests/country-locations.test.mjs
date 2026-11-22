import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/country-locations.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const locations = context.FikratakLocationData;

test('قائمة الدول تقتصر على مصر ودول الخليج وتعرض رموز الاتصال', () => {
  const arabicChoices = locations.getCountryChoices('ar');
  assert.deepEqual(
    Array.from(arabicChoices, (choice) => choice.iso).sort(),
    ['AE', 'BH', 'EG', 'KW', 'OM', 'QA', 'SA']
  );
  const saudi = arabicChoices.find((choice) => choice.iso === 'SA');
  assert.equal(saudi.dialCode, '966');
  assert.match(saudi.label, /\+966/);
  assert.equal(locations.countryByName('Saudi Arabia').dialCode, '966');
  assert.equal(locations.countryByName('السعودية').iso, 'SA');
  assert.equal(locations.countryByName('المملكة العربية السعودية').dialCode, '966');
  assert.equal(locations.countryByName('الْمَمْلَكَة العَرَبِيَّة السُّعُودِيَّة').iso, 'SA');
  assert.equal(locations.countryByName('UAE').iso, 'AE');
  assert.equal(locations.countryByName('U.A.E.').dialCode, '971');
  assert.equal(locations.countryByName('AE').dialCode, '971');
  assert.equal(locations.countryByName('KSA').iso, 'SA');
  const expectedDialCodes = {
    AE: '971',
    BH: '973',
    EG: '20',
    KW: '965',
    OM: '968',
    QA: '974',
    SA: '966'
  };
  for (const [iso, dialCode] of Object.entries(expectedDialCodes)) {
    const choice = arabicChoices.find((item) => item.iso === iso);
    assert.ok(choice, `${iso} should have a localized country name`);
    assert.equal(choice.dialCode, dialCode);
    assert.match(choice.label, new RegExp(`\\(\\+${dialCode}\\)`));
  }
});

test('القائمة لا تعرض القيم التاريخية وتعرض القيمة القديمة فقط عند تعديلها', () => {
  const choices = locations.getCountryChoices('en', ['Old Imported Territory', 'Saudi Arabia', 'السعودية', 'France']);
  assert.equal(choices.length, 7);
  assert.ok(!choices.some((choice) => choice.historical));
  assert.equal(choices.filter((choice) => choice.value === 'Saudi Arabia').length, 1);
  assert.ok(!choices.some((choice) => choice.value === 'France'));
  const oldValue = locations.getCountryChoices('en', ['Old Imported Territory'], 'Old Imported Territory')
    .find((choice) => choice.value === 'Old Imported Territory');
  assert.equal(oldValue.historical, true);
  assert.equal(oldValue.label, 'Old Imported Territory');
  const uae = locations.getCountryChoices('ar', ['UAE'], 'UAE').find((choice) => choice.iso === 'AE');
  assert.equal(uae.value, 'UAE');
  assert.equal(uae.historical, false);
  assert.match(uae.label, /الإمارات العربية المتحدة \(\+971\)/);
  assert.doesNotMatch(uae.label, /قيمة مسجلة|existing value/);
  assert.equal(locations.getCountryChoices('ar', ['UAE']).filter((choice) => choice.iso === 'AE').length, 1);
});

test('اقتراحات المنطقة والمدينة تتسلسل حسب الدولة والمنطقة وتحافظ على القيمة الحالية', () => {
  const records = [
    { Country: 'السعودية', Area: 'Riyadh Province', City: 'Riyadh' },
    { Country: 'Saudi Arabia', Area: 'Eastern Province', City: 'Dammam' },
    { Country: 'Kuwait', Area: 'Capital Governorate', City: 'Kuwait City' }
  ];
  assert.deepEqual(
    Array.from(locations.getLocationValues(records, 'Area')),
    ['Capital Governorate', 'Eastern Province', 'Riyadh Province']
  );
  assert.deepEqual(
    Array.from(locations.getLocationValues(records, 'City')),
    ['Dammam', 'Kuwait City', 'Riyadh']
  );
  assert.deepEqual(
    Array.from(locations.getLocationValues(records, 'Area', 'Saudi Arabia')),
    ['Eastern Province', 'Riyadh Province']
  );
  assert.deepEqual(
    Array.from(locations.getLocationValues(records, 'City', 'Saudi Arabia', 'Riyadh Province')),
    ['Riyadh']
  );
  assert.deepEqual(
    Array.from(locations.getLocationValues(records, 'City', 'Kuwait', 'Capital Governorate', 'Old City')),
    ['Kuwait City', 'Old City']
  );
});

test('عوامل تصفية الموقع تطابق الدولة والمنطقة والمدينة معًا', () => {
  const riyadh = { Country: 'Saudi Arabia', Area: 'Riyadh Province', City: 'Riyadh' };
  const dammam = { Country: 'Saudi Arabia', Area: 'Eastern Province', City: 'Dammam' };
  assert.equal(locations.matchesLocationFilters(riyadh, { country: 'Saudi Arabia' }), true);
  assert.equal(locations.matchesLocationFilters({ ...riyadh, Country: 'السعودية' }, { country: 'Saudi Arabia' }), true);
  assert.equal(locations.matchesLocationFilters({ ...riyadh, Country: 'UAE' }, { country: 'AE' }), true);
  assert.equal(locations.matchesLocationFilters({ ...riyadh, Country: 'UAE' }, { country: 'United Arab Emirates' }), true);
  assert.equal(locations.matchesLocationFilters(riyadh, { country: 'AE' }), false);
  assert.equal(locations.matchesLocationFilters({ ...riyadh, Country: 'United Arab Emirates' }, { country: 'AE' }), true);
  assert.equal(locations.matchesLocationFilters(riyadh, { country: 'Saudi Arabia', area: 'Riyadh Province' }), true);
  assert.equal(locations.matchesLocationFilters(riyadh, {
    country: 'Saudi Arabia', area: 'Eastern Province', city: 'Riyadh'
  }), false);
  assert.equal(locations.matchesLocationFilters(dammam, {
    country: 'Saudi Arabia', area: 'Eastern Province', city: 'Dammam'
  }), true);
});
