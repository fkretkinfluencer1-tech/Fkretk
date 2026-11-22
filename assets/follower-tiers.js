(function exposeFollowerTierRules(root) {
  'use strict';

  const tiers = Object.freeze(['Nano', 'Micro', 'Macro', 'Semi Mega', 'Mega']);
  const defaultThresholds = Object.freeze([10000, 100000, 500000, 1000000]);
  const thresholds = defaultThresholds;
  const minimumFollowers = 0;
  const arabicDigits = '٠١٢٣٤٥٦٧٨٩';

  function validateThresholds(value) {
    return Array.isArray(value) && value.length === defaultThresholds.length &&
      value.every((threshold, index) => threshold === defaultThresholds[index]);
  }

  function setThresholds(value) {
    return validateThresholds(value);
  }

  function parse(value) {
    const normalized = String(value ?? '').trim()
      .replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
      .replace(/[٬،,\s]/g, '')
      .replace('٫', '.');
    const match = normalized.match(/^(\d+(?:\.\d+)?)([kKmMbB])?$/);
    if (!match) return null;
    const multiplier = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
    const count = Number(match[1]) * multiplier;
    return Number.isFinite(count) ? count : null;
  }

  function classify(value) {
    const count = parse(value);
    if (count === null || count < minimumFollowers) return '';
    if (count < thresholds[0]) return tiers[0];
    if (count < thresholds[1]) return tiers[1];
    if (count < thresholds[2]) return tiers[2];
    if (count < thresholds[3]) return tiers[3];
    return tiers[4];
  }

  function highest(values) {
    return values.reduce((highestTier, value) => {
      const tier = classify(value);
      return tiers.indexOf(tier) > tiers.indexOf(highestTier) ? tier : highestTier;
    }, '');
  }

  root.FikratakFollowerTiers = Object.freeze({
    tiers,
    get thresholds() { return [...thresholds]; },
    defaultThresholds,
    minimumFollowers,
    parse,
    classify,
    highest,
    setThresholds,
    validateThresholds
  });
})(globalThis);
