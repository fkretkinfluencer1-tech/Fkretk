'use strict';

(() => {
  const dictionaries = new Map();
  let locale = document.documentElement.lang === 'en' ? 'en' : 'ar';
  const displayValues = new Map(Object.entries({
    'Saudi Arabia': 'السعودية',
    Riyadh: 'الرياض',
    Jeddah: 'جدة',
    Makkah: 'مكة المكرمة',
    Qatif: 'القطيف',
    Khobar: 'الخبر',
    Nano: 'نانو',
    Micro: 'مايكرو',
    Mid: 'ميد',
    Macro: 'ماكرو',
    'Semi Mega': 'سيمي ميجا',
    Mega: 'ميجا',
    'السعودية': 'Saudi Arabia',
    'الرياض': 'Riyadh',
    'جدة': 'Jeddah',
    'مكة المكرمة': 'Makkah',
    'القطيف': 'Qatif',
    'الخبر': 'Khobar',
    'نانو': 'Nano',
    'مايكرو': 'Micro',
    'ميد': 'Mid',
    'ماكرو': 'Macro',
    'سيمي ميجا': 'Semi Mega',
    'ميجا': 'Mega',
    Fashion: 'الأزياء',
    Beauty: 'الجمال',
    Food: 'الطعام',
    Travel: 'السفر',
    Lifestyle: 'نمط الحياة',
    Technology: 'التقنية',
    Gaming: 'الألعاب',
    Sports: 'الرياضة',
    Family: 'العائلة',
    Parenting: 'الأمومة والأبوة',
    Health: 'الصحة',
    Comedy: 'الكوميديا',
    Education: 'التعليم',
    'الأزياء': 'Fashion',
    'الجمال': 'Beauty',
    'الطعام': 'Food',
    'السفر': 'Travel',
    'نمط الحياة': 'Lifestyle',
    'التقنية': 'Technology',
    'الألعاب': 'Gaming',
    'الرياضة': 'Sports',
    'العائلة': 'Family',
    'الأمومة والأبوة': 'Parenting',
    'الصحة': 'Health',
    'الكوميديا': 'Comedy',
    'التعليم': 'Education'
  }));

  function register(namespace, translations) {
    if (!namespace || !translations || typeof translations !== 'object') {
      throw new TypeError('A translation namespace and dictionary are required.');
    }
    dictionaries.set(namespace, translations);
  }

  function translate(key, namespace) {
    const dictionary = namespace ? dictionaries.get(namespace) : null;
    const localized = dictionary?.[key];
    if (typeof localized === 'string') return localized;
    if (Array.isArray(localized)) return localized[locale === 'en' ? 1 : 0] || key;
    for (const candidate of dictionaries.values()) {
      const value = candidate[key];
      if (typeof value === 'string') return value;
      if (Array.isArray(value)) return value[locale === 'en' ? 1 : 0] || key;
    }
    return key;
  }

  function setLocale(nextLocale) {
    locale = nextLocale === 'en' ? 'en' : 'ar';
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'en' ? 'ltr' : 'rtl';
    return locale;
  }

  function displayValue(value, nextLocale = locale) {
    const text = String(value ?? '');
    const translation = displayValues.get(text.trim());
    if (!translation) return text;
    const sourceIsEnglish = /^[\x00-\x7F]*$/.test(text.trim());
    return (nextLocale === 'en') === sourceIsEnglish ? text : translation;
  }

  function apply(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((element) => {
      element.textContent = translate(element.dataset.i18n, element.dataset.i18nNamespace);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
      element.placeholder = translate(element.dataset.i18nPlaceholder, element.dataset.i18nNamespace);
    });
  }

  window.FKI18n = Object.freeze({
    register,
    t: translate,
    setLocale,
    displayValue,
    getLocale: () => locale,
    apply
  });
})();
