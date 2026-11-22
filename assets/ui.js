'use strict';

(() => {
  const preference = (key, fallback) => {
    try { return localStorage.getItem(key) || fallback; }
    catch { return fallback; }
  };

  function setPreference(key, value) {
    try { localStorage.setItem(key, value); }
    catch { return false; }
    return true;
  }

  function setLanguage(language) {
    const locale = language === 'en' ? 'en' : 'ar';
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'en' ? 'ltr' : 'rtl';
    window.FKI18n?.setLocale(locale);
    return locale;
  }

  function setTheme(theme) {
    const value = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = value;
    if (document.body) document.body.dataset.theme = value;
    return value;
  }

  function formatCompactNumber(value, locale = document.documentElement.lang || 'ar') {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat(locale, {
      notation: Math.abs(number) >= 1000 ? 'compact' : 'standard',
      maximumFractionDigits: 1
    }).format(number);
  }

  function toast(message, { type = 'info', duration = 2800 } = {}) {
    let region = document.querySelector('[data-fk-toast-region]');
    if (!region) {
      region = document.createElement('div');
      region.dataset.fkToastRegion = '';
      region.className = 'fk-toast-region';
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'true');
      document.body.append(region);
    }
    const item = document.createElement('div');
    item.className = `fk-toast fk-toast-${type}`;
    item.setAttribute('role', type === 'error' ? 'alert' : 'status');
    item.textContent = String(message ?? '');
    region.append(item);
    window.setTimeout(() => item.remove(), Math.max(1000, duration));
    return item;
  }

  function openModal(dialog) {
    if (!(dialog instanceof HTMLDialogElement)) throw new TypeError('A dialog element is required.');
    if (!dialog.open) dialog.showModal();
  }

  function closeModal(dialog, returnValue = '') {
    if (!(dialog instanceof HTMLDialogElement)) throw new TypeError('A dialog element is required.');
    if (dialog.open) dialog.close(returnValue);
  }

  function setSkeleton(container, count = 3) {
    if (!(container instanceof Element)) throw new TypeError('A container element is required.');
    const amount = Math.max(1, Math.min(20, Math.trunc(Number(count) || 1)));
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < amount; index += 1) {
      const item = document.createElement('div');
      item.className = 'fk-skeleton';
      item.setAttribute('aria-hidden', 'true');
      fragment.append(item);
    }
    container.replaceChildren(fragment);
    container.setAttribute('aria-busy', 'true');
  }

  function createAvatar(name, seed = name) {
    const avatar = document.createElement('span');
    const label = String(name || '').trim();
    const initials = label.split(/\s+/u).slice(0, 2).map((part) => part[0] || '').join('');
    let hash = 0;
    for (const character of String(seed || 'FKRETK')) hash = ((hash * 31) + character.codePointAt(0)) | 0;
    avatar.className = 'fk-avatar';
    avatar.textContent = initials || '؟';
    avatar.dataset.palette = String(Math.abs(hash) % 8);
    avatar.setAttribute('aria-label', label || 'Avatar');
    return avatar;
  }

  function icon(name, { size = 20 } = {}) {
    const paths = {
      search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M20 8v6m-3-3h6"/>',
      chart: '<path d="M3 3v18h18"/><path d="M18 17V9m-5 8V5m-5 12v-3"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      close: '<path d="m18 6-12 12M6 6l12 12"/>',
      menu: '<path d="M4 6h16M4 12h16M4 18h16"/>'
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const template = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    template.innerHTML = paths[name] || paths.search;
    svg.append(...template.childNodes);
    return svg;
  }

  function initMobileFilterSheets() {
    const updateLabels = () => {
      const english = document.documentElement.lang === 'en';
      for (const element of document.querySelectorAll('[data-mobile-filter-label-ar]')) {
        element.textContent = element.dataset[english ? 'mobileFilterLabelEn' : 'mobileFilterLabelAr'] || '';
      }
      for (const element of document.querySelectorAll('[data-mobile-filter-open]')) {
        element.setAttribute('aria-label', element.dataset[english ? 'mobileFilterAriaEn' : 'mobileFilterAriaAr'] || '');
      }
      for (const element of document.querySelectorAll('[data-mobile-filter-close]')) {
        element.setAttribute('aria-label', element.dataset[english ? 'mobileFilterAriaEn' : 'mobileFilterAriaAr'] || '');
      }
    };

    function close(panel, restoreFocus = true) {
      if (!panel) return;
      const id = panel.id;
      const trigger = [...document.querySelectorAll('[data-mobile-filter-open]')]
        .find((element) => element.dataset.mobileFilterOpen === id);
      const backdrop = [...document.querySelectorAll('[data-mobile-filter-backdrop]')]
        .find((element) => element.dataset.mobileFilterBackdrop === id);
      panel.classList.remove('mobile-filter-sheet-open');
      panel.removeAttribute('aria-modal');
      if (panel.dataset.mobileFilterOriginalRole !== undefined) {
        if (panel.dataset.mobileFilterOriginalRole) panel.setAttribute('role', panel.dataset.mobileFilterOriginalRole);
        else panel.removeAttribute('role');
        delete panel.dataset.mobileFilterOriginalRole;
      }
      if (backdrop) backdrop.hidden = true;
      if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus && trigger.isConnected) trigger.focus();
      }
      document.body.classList.remove('mobile-filter-sheet-active');
      delete document.body.dataset.mobileFilterPanelId;
    }

    document.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      const trigger = event.target.closest('[data-mobile-filter-open]');
      if (trigger) {
        const panel = document.getElementById(trigger.dataset.mobileFilterOpen);
        if (!panel) throw new Error(`Mobile filter panel "${trigger.dataset.mobileFilterOpen}" was not found.`);
        const activeId = document.body.dataset.mobileFilterPanelId;
        if (activeId && activeId !== panel.id) close(document.getElementById(activeId), false);
        panel.dataset.mobileFilterOriginalRole = panel.getAttribute('role') || '';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.classList.add('mobile-filter-sheet-open');
        document.body.classList.add('mobile-filter-sheet-active');
        document.body.dataset.mobileFilterPanelId = panel.id;
        const backdrop = [...document.querySelectorAll('[data-mobile-filter-backdrop]')]
          .find((element) => element.dataset.mobileFilterBackdrop === panel.id);
        if (backdrop) backdrop.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        updateLabels();
        panel.querySelector('[data-mobile-filter-close]')?.focus();
        return;
      }
      const closeButton = event.target.closest('[data-mobile-filter-close]');
      const backdrop = event.target.closest('[data-mobile-filter-backdrop]');
      if (closeButton || backdrop) {
        const panelId = closeButton?.dataset.mobileFilterClose || backdrop?.dataset.mobileFilterBackdrop;
        close(document.getElementById(panelId));
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const panelId = document.body.dataset.mobileFilterPanelId;
      if (panelId) close(document.getElementById(panelId));
    });

    new MutationObserver(updateLabels).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['lang']
    });
    updateLabels();
  }

  window.FKUI = Object.freeze({
    getPreference: preference,
    setPreference,
    setLanguage,
    setTheme,
    formatCompactNumber,
    toast,
    openModal,
    closeModal,
    setSkeleton,
    createAvatar,
    icon,
    initMobileFilterSheets
  });

  initMobileFilterSheets();
})();
