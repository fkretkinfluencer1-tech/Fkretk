'use strict';

(() => {
  const allowedIcons = new Set([
    'shield-check', 'badge-check', 'female', 'male', 'users', 'at-sign', 'share',
    'map-pin', 'search', 'eye', 'eye-off', 'sun', 'moon', 'globe', 'star', 'grid', 'list', 'close', 'heart', 'external-link', 'arrow-left', 'arrow-right', 'download', 'play', 'instagram', 'tiktok', 'snapchat'
  ]);
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);

  function icon(name, { className = '', size = 20 } = {}) {
    if (!allowedIcons.has(name)) throw new TypeError(`Unknown icon: ${name}`);
    const classes = className ? ` class="${escape(className)}"` : '';
    return `<svg${classes} width="${Number(size)}" height="${Number(size)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="/assets/icons/sprite.svg#${name}"></use></svg>`;
  }

  const badgeDefinitions = Object.freeze({
    mawthouq: Object.freeze({ icon: 'shield-check', tone: 'success', ar: 'موثوق', en: 'Mawthouq' }),
    verified: Object.freeze({ icon: 'badge-check', tone: 'info', ar: 'حساب موثّق على المنصة', en: 'Platform verified' })
  });

  function badge(kind, language = document.documentElement.lang, size = 'sm', label) {
    const definition = badgeDefinitions[kind];
    if (!definition || !['sm', 'md'].includes(size)) throw new TypeError('Unknown badge type or size.');
    const text = label || (language === 'en' ? definition.en : definition.ar);
    return `<span class="fk-badge fk-badge-${definition.tone} fk-badge-${size}" data-badge="${kind}">${icon(definition.icon, { size: size === 'md' ? 18 : 16 })}<span>${escape(text)}</span></span>`;
  }

  window.FKIcons = Object.freeze({ icon });
  window.FKBadge = Object.freeze({ badge });
})();
