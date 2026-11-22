/* ISO 3166-1 alpha-2 regions with international calling prefixes (E.164). */
(function exposeFikratakLocationData(root) {
  'use strict';

  const countryCodes = `
    AF:93 AL:355 DZ:213 AS:1 AD:376 AO:244 AI:1 AG:1 AQ BV AR:54 AM:374 AW:297
    AU:61 AT:43 AZ:994 BS:1 BH:973 BD:880 BB:1 BY:375 BE:32 BZ:501 BJ:229
    BM:1 BT:975 BO:591 BA:387 BW:267 BR:55 IO:246 VG:1 BN:673 BG:359 BF:226
    BI:257 KH:855 CM:237 CA:1 CV:238 KY:1 CF:236 TD:235 CL:56 CN:86 CX:61
    CC:61 CO:57 KM:269 CG:242 CD:243 CK:682 CR:506 CI:225 HR:385 CU:53 CY:357
    CZ:420 DK:45 DJ:253 DM:1 DO:1 EC:593 EG:20 SV:503 GQ:240 ER:291 EE:372
    SZ:268 ET:251 FK:500 FO:298 FJ:679 FI:358 FR:33 GF:594 PF:689 GA:241
    GM:220 GE:995 DE:49 GH:233 GI:350 GR:30 GL:299 GD:1 GP:590 GU:1 GT:502
    GN:224 GW:245 GY:592 HT:509 HN:504 HK:852 HU:36 IS:354 IN:91 ID:62 IR:98
    IQ:964 IE:353 IL:972 IT:39 JM:1 JP:81 JO:962 KZ:7 KE:254 KI:686 KP:850
    KR:82 KW:965 KG:996 LA:856 LV:371 LB:961 LS:266 LR:231 LY:218 LI:423
    LT:370 LU:352 MO:853 MG:261 MW:265 MY:60 MV:960 ML:223 MT:356 MH:692
    MQ:596 MR:222 MU:230 YT:262 MX:52 FM:691 MD:373 MC:377 MN:976 ME:382
    MS:1 MA:212 MZ:258 MM:95 NA:264 NR:674 NP:977 NL:31 NC:687 NZ:64 NI:505
    NE:227 NG:234 NU:683 NF:672     MK:389 NO:47 OM:968 PK:92 PW:680 PS:970 MP:1 PN:64
    PA:507 PG:675 PY:595 PE:51 PH:63 PL:48 PT:351 PR:1 QA:974 RE:262 RO:40
    RU:7 RW:250 BL:590 GS:500 HM:672 SH:290 KN:1 LC:1 MF:590 PM:508 VC:1 WS:685 SM:378
    ST:239 SA:966 SN:221 RS:381 SC:248 SL:232 SG:65 SK:421 SI:386 SB:677
    SO:252 ZA:27 SS:211 ES:34 LK:94 SD:249 SR:597 SJ:47 SE:46 CH:41 SY:963
    TW:886 TJ:992 TZ:255 TH:66 TL:670 TG:228 TK:690 TO:676 TT:1 TN:216
    TR:90 TM:993 TC:1 TV:688 UG:256 UA:380 AE:971 GB:44 US:1 UY:598 UZ:998
    TF:262 UM:1 VU:678 VA:39 VE:58 VI:1 VN:84 WF:681 EH:212 YE:967 ZM:260 ZW:263
    AX:358 BQ:599 CW:599 SX:1 XK:383
  `.trim().split(/\s+/).map((entry) => {
    const [iso, dialCode] = entry.split(':');
    return { iso, dialCode: dialCode || '' };
  });
  const selectableCountryIsos = new Set(['BH', 'EG', 'KW', 'OM', 'QA', 'SA', 'AE']);

  const englishNames = new Intl.DisplayNames(['en'], { type: 'region' });
  const arabicNames = new Intl.DisplayNames(['ar'], { type: 'region' });
  const countryAliases = {
    SA: ['السعودية', 'السعوديه', 'المملكة العربية السعودية', 'المملكه العربيه السعوديه', 'KSA', 'Kingdom of Saudi Arabia'],
    AE: ['الإمارات', 'الامارات', 'الإمارات العربية المتحدة', 'الامارات العربية المتحدة', 'UAE', 'U.A.E.'],
    EG: ['مصر', 'جمهورية مصر العربية', 'Egypt'],
    BH: ['البحرين', 'Bahrain'],
    KW: ['الكويت', 'Kuwait'],
    OM: ['عمان', 'سلطنة عمان', 'Oman'],
    QA: ['قطر', 'Qatar'],
    YE: ['اليمن'],
    US: ['أمريكا', 'امريكا', 'الولايات المتحدة', 'الولايات المتحدة الأمريكية', 'الولايات المتحده الامريكيه'],
    GB: ['بريطانيا', 'المملكة المتحدة', 'المملكه المتحده'],
    KR: ['كوريا الجنوبية', 'كوريا الجنوبيه'],
    KP: ['كوريا الشمالية', 'كوريا الشماليه']
  };
  const countryByNormalizedName = new Map();

  function normalizeCountryName(value) {
    return String(value || '').trim().toLocaleLowerCase()
      .normalize('NFKD')
      .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/\s+/g, ' ');
  }

  for (const country of countryCodes) {
    const names = [
      country.iso,
      englishNames.of(country.iso),
      arabicNames.of(country.iso),
      ...(countryAliases[country.iso] || [])
    ];
    for (const name of names) {
      const normalized = normalizeCountryName(name);
      if (normalized && !countryByNormalizedName.has(normalized)) {
        countryByNormalizedName.set(normalized, country);
      }
    }
  }

  const countryByName = (value) => {
    return countryByNormalizedName.get(normalizeCountryName(value)) || null;
  };

  function getCountryChoices(language = 'ar', historicalValues = [], selectedHistoricalValue = '') {
    const locale = language === 'en' ? 'en' : 'ar';
    const selectedValue = String(selectedHistoricalValue || '').trim();
    const localizedNames = new Intl.DisplayNames([locale], { type: 'region' });
    const selectedCountry = countryByName(selectedValue);
    const choices = countryCodes.filter(({ iso }) => selectableCountryIsos.has(iso)).map(({ iso, dialCode }) => ({
      value: selectedCountry?.iso === iso ? selectedValue : englishNames.of(iso),
      label: dialCode ? `${localizedNames.of(iso)} (+${dialCode})` : localizedNames.of(iso),
      dialCode,
      iso,
      historical: false
    }));
    const seen = new Set(choices.map(({ value }) => value));
    for (const item of historicalValues) {
      const value = String(item || '').trim();
      if (!value || seen.has(value)) continue;
      if (value !== selectedValue) continue;
      const country = countryByName(value);
      seen.add(value);
      choices.push({
        value,
        label: country && selectableCountryIsos.has(country.iso)
          ? `${localizedNames.of(country.iso)} (+${country.dialCode})`
          : value,
        dialCode: country?.dialCode || '',
        iso: country?.iso || '',
        historical: !(country && selectableCountryIsos.has(country.iso))
      });
    }
    return choices.sort((left, right) => left.label.localeCompare(right.label, locale));
  }

  function getLocationValues(records, field, country, area, historicalValue = '') {
    const areaKey = String(area || '').trim();
    const values = new Set();
    for (const record of records || []) {
      if (country && !sameCountry(record.Country, country)) continue;
      if (field === 'City' && areaKey && normalizeCountryName(record.Area) !== normalizeCountryName(areaKey)) continue;
      const value = String(record[field] || '').trim();
      if (value) values.add(value);
    }
    const historical = String(historicalValue || '').trim();
    if (historical) values.add(historical);
    return [...values].sort((left, right) => left.localeCompare(right));
  }

  function matchesLocationFilters(record, { country = '', area = '', city = '' } = {}) {
    const sameValue = (left, right) => normalizeCountryName(left) === normalizeCountryName(right);
    return (!country || sameCountry(record.Country, country))
      && (!area || sameValue(record.Area, area))
      && (!city || sameValue(record.City, city));
  }

  function sameCountry(left, right) {
    const leftCountry = countryByName(left);
    const rightCountry = countryByName(right);
    if (leftCountry && rightCountry) return leftCountry.iso === rightCountry.iso;
    return normalizeCountryName(left) === normalizeCountryName(right);
  }

  root.FikratakLocationData = {
    countryCodes, countryByName, getCountryChoices, getLocationValues, matchesLocationFilters
  };
})(globalThis);
