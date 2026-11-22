'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const PAGE_SIZE = 24;
const state = {
  account: null,
  lists: [],
  listId: '',
  items: [],
  preview: false,
  previewItems: [],
  preview: false,
  previewItems: [],
  total: 0,
  page: 1,
  pageCount: 1,
  activeItem: null,
  requestId: 0,
  language: 'ar',
  theme: 'light',
  view: 'grid'
};

const translations = {
  clientExperience: ['تجربة العميل', 'Client experience'],
  curatedBy: ['اختيارات فريق فكرتك', 'Curated by Fkretk'],
  loginHeadline: ['مساحة خاصة، واختيارات صُنعت لعلامتكم.', 'A private space, with a shortlist made for your brand.'],
  loginDescription: ['اكتشفوا المؤثرين المختارين لحملتكم، واحفظوا الأسماء الأقرب لرؤيتكم.', 'Explore creators selected for your campaign and save the ones that fit your vision.'],
  brandTagline: ['حلول تسويق بالمؤثرين، بتفاصيل تصنع الفرق.', 'Influencer marketing, with details that make a difference.'],
  welcome: ['مرحبًا بكم', 'Welcome'],
  signIn: ['تسجيل الدخول', 'Sign in'],
  loginHint: ['استخدموا البريد الإلكتروني وكلمة المرور المرسلين من فريق فكرتك.', 'Use the email and password shared by the Fkretk team.'],
  email: ['البريد الإلكتروني', 'Email address'],
  password: ['كلمة المرور', 'Password'],
  logout: ['تسجيل الخروج', 'Sign out'],
  privacyNote: ['هذه المساحة خاصة بحسابكم والقوائم التي شاركها فريق فكرتك معكم.', 'This private space only includes lists shared with your account by Fkretk.'],
  selectedFor: ['اختيارات مخصصة لكم', 'Selected for you'],
  selectedProfilesTitle: ['المؤثرون المختارون لـ', 'Selected influencers for'],
  previewMode: ['معاينة كعميل', 'Client preview'],
  backToAgency: ['العودة للوكالة', 'Back to agency'],
  previewOnly: ['هذه معاينة؛ لم يتم حفظ أي تغيير.', 'Preview only. Changes were not saved.'],
  selectedProfiles: ['ملفًا مختارًا', 'selected profiles'],
  theShortlist: ['قائمة مختارة', 'Curated shortlist'],
  meetCreators: ['تعرّفوا على المؤثرين', 'Meet the creators'],
  sort: ['ترتيب', 'Sort'],
  curatedOrder: ['ترتيب فكرتك', 'Curated order'],
  nameOrder: ['الاسم', 'Name'],
  followersOrder: ['المتابعون', 'Followers'],
  pageFollowers: ['متابعو الصفحة', 'Followers on this page'],
  pageCities: ['مدن الصفحة', 'Cities on this page'],
  themeDark: ['الوضع الداكن', 'Dark mode'],
  themeLight: ['الوضع الفاتح', 'Light mode'],
  gridView: ['عرض شبكي', 'Grid view'],
  listView: ['عرض قائمة', 'List view'],
  emptyTitle: ['لا يوجد مؤثرون في هذه القائمة', 'There are no creators in this list'],
  creatorProfile: ['ملف المؤثر', 'Creator profile'],
  yourComment: ['ملاحظتكم للفريق', 'A note for the team'],
  commentPlaceholder: ['اكتبوا ملاحظة حول هذا الاختيار', 'Leave a note about this creator'],
  addToShortlist: ['إضافة إلى قائمتي', 'Add to my shortlist'],
  removeFromShortlist: ['إزالة من قائمتي', 'Remove from my shortlist'],
  sendFeedback: ['حفظ الملاحظة', 'Save note'],
  footerNote: ['اختياراتكم، في مساحة خاصة من فكرتك الرقمية.', 'Your shortlist, in a private Fkretk space.'],
  allCreators: ['كل المؤثرين', 'All creators'],
  noLists: ['لا توجد قوائم منشورة مرتبطة بهذا الحساب.', 'No published lists are assigned to this account.'],
  followers: ['متابع', 'followers'],
  verified: ['موثّق من المنصة', 'Platform verified'],
  mawthouq: ['شهادة موثوق', 'Mawthouq certified'],
  viewProfile: ['عرض الملف', 'View profile'],
  locationUnavailable: ['الموقع غير محدد', 'Location not specified'],
  noSocialAccounts: ['لا توجد حسابات اجتماعية مسجلة.', 'No social accounts listed.'],
  results: ['نتيجة', 'results'],
  page: ['صفحة', 'Page'],
  of: ['من', 'of'],
  loading: ['جارٍ تحميل القائمة…', 'Loading the shortlist…'],
  loginError: ['تعذر تسجيل الدخول. تحققوا من البيانات وحاولوا مجددًا.', 'Could not sign in. Check your details and try again.'],
  loadError: ['تعذر تحميل القائمة. حدّثوا الصفحة أو تواصلوا مع فريق فكرتك.', 'Could not load the list. Refresh or contact the Fkretk team.'],
  feedbackSaved: ['تم حفظ اختياركم وملاحظتكم.', 'Your shortlist and note were saved.'],
};

window.FKI18n?.register('showcase', translations);
function t(key) { return window.FKI18n?.t(key, 'showcase') || translations[key]?.[state.language === 'en' ? 1 : 0] || key; }
function makeIcon(name, className = '') {
  const host = make('span', className);
  host.innerHTML = FKIcons.icon(name, { size: 18 });
  return host;
}
function setLanguage(language) {
  state.language = language;
  window.FKUI?.setLanguage(language);
  document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  $('#language-toggle').textContent = language === 'ar' ? 'English' : 'العربية';
  $('#language-toggle').setAttribute('aria-label', language === 'ar' ? 'English' : 'العربية');
  $('#theme-toggle').setAttribute('aria-label', state.theme === 'dark' ? t('themeLight') : t('themeDark'));
  renderListTabs();
  renderShowcaseHeader();
  renderItems();
  renderProfile();
}

function setTheme(theme) {
  state.theme = theme;
  window.FKUI?.setTheme(theme);
  $('#theme-toggle').innerHTML = FKIcons.icon(theme === 'dark' ? 'sun' : 'moon');
  $('#theme-toggle').setAttribute('aria-label', theme === 'dark' ? t('themeLight') : t('themeDark'));
}

async function api(path, options = {}) {
  const body = options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body;
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store', ...options, body,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || t('loadError')), { status: response.status });
  return result;
}

function showToast(message) {
  const toast = $('#toast-message');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

function formatCompactFollowers(value) {
  const count = window.FikratakFollowerTiers?.parse(value);
  return count === null || count === undefined
    ? (value ? String(value) : '—')
    : new Intl.NumberFormat(state.language === 'ar' ? 'ar' : 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(count);
}

function make(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function currentList() { return state.lists.find((list) => list.id === state.listId) || null; }

function renderShowcaseHeader() {
  const list = currentList();
  const clientName = state.account?.clientName || state.account?.companyName || '';
  $('#showcase-title').textContent = clientName ? `${t('selectedProfilesTitle')} ${clientName}` : '';
  $('#showcase-company').textContent = list?.title || state.account?.companyName || '';
}

function renderListTabs() {
  const host = $('#showcase-lists');
  host.replaceChildren();
  for (const list of state.lists) {
    const button = make('button', 'showcase-list-tab');
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(list.id === state.listId));
    button.textContent = `${list.title} · ${list.total}`;
    button.addEventListener('click', () => {
      state.listId = list.id;
      state.page = 1;
      loadItems();
    });
    host.append(button);
  }
}

function createTrustBadge(kind) {
  const template = document.createElement('template');
  template.innerHTML = FKBadge.badge(kind, state.language, 'sm');
  return template.content.firstElementChild;
}

function avatarFallback(item) {
  const gender = String(item.Gender || item.gender || item.details?.Gender || '').trim().toLowerCase();
  const hijab = ['yes', 'y', 'نعم', 'true', '1'].includes(String(item.Hijab || item.hijab || item.details?.Hijab || '').trim().toLowerCase());
  if (['female', 'f', 'أنثى', 'انثى'].includes(gender)) {
    return hijab ? '/assets/avatars/female-hijab.svg' : '/assets/avatars/female.svg';
  }
  if (['male', 'm', 'ذكر'].includes(gender)) return '/assets/avatars/male.svg';
  return '/assets/avatars/neutral.svg';
}

function avatarImageSource(item) {
  const fallback = avatarFallback(item);
  if (/^\/profile-images\/[a-f0-9]{32}(?:\?v=[a-f0-9]{12})?$/i.test(item.profileImage || '')) return item.profileImage;
  return /^[a-f0-9]{32}$/i.test(item.id || '') ? `/profile-images/${item.id}` : fallback;
}

function setAvatarImage(image, item) {
  const fallback = avatarFallback(item);
  image.src = avatarImageSource(item);
  image.addEventListener('error', () => {
    if (image.getAttribute('src') !== fallback) image.src = fallback;
  }, { once: true });
}

function queryFor(page = state.page, pageSize = PAGE_SIZE) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const sort = $('#sort-select').value;
  if (sort === 'name' || sort === 'followers') params.set('sort', sort);
  return params;
}

function renderSocialAccounts(item, compact = false) {
  const host = make('div', compact ? 'profile-socials' : 'creator-socials');
  if (!item.socialAccounts.length) {
    host.append(make('p', 'comment-indicator', t('noSocialAccounts')));
    return host;
  }
  for (const account of item.socialAccounts) {
    const row = make('div', compact ? 'profile-social-card' : 'social-account');
    const platform = make('div', 'social-platform');
    const mark = make('img', `platform-mark ${account.platform.toLowerCase()}`);
    mark.src = `/assets/platform-${account.platform.toLowerCase()}.${account.platform === 'Snapchat' ? 'png' : 'jpg'}`;
    mark.alt = '';
    mark.loading = 'lazy';
    mark.onerror = () => {
      const fallback = make('span', `platform-mark ${account.platform.toLowerCase()}`);
      fallback.innerHTML = FKIcons.icon(account.platform.toLowerCase(), { size: 20 });
      mark.replaceWith(fallback);
    };
    platform.append(mark, make('span', '', account.platform));
    const numbers = make('div', 'social-numbers');
    numbers.append(make('strong', 'social-followers', formatCompactFollowers(account.followers)));
    const tier = window.FikratakFollowerTiers?.classify(account.followers);
    if (tier) numbers.append(make('span', `social-tier tier-${tier.toLowerCase().replace(/\s/g, '-')}`, window.FKI18n?.displayValue(tier, state.language) || tier));
    row.append(platform, numbers);
    if (account.username && account.profileUrl) {
      const link = make('a', 'social-account-link', `@${account.username.replace(/^@/, '')}`);
      link.href = account.profileUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${account.platform} @${account.username}`);
      link.append(makeIcon('external-link', 'social-link-icon'));
      row.append(link);
    }
    host.append(row);
  }
  return host;
}

function renderCreatorCard(item) {
  const card = make('article', 'creator-card');
  const mainPlatform = String(item.platform || item.bestPlatform || '').trim().toLowerCase();
  card.dataset.mainPlatform = mainPlatform.includes('snap') ? 'snapchat'
    : mainPlatform.includes('insta') ? 'instagram'
      : mainPlatform.includes('tik') ? 'tiktok' : 'default';
  const top = make('div', 'creator-card-top');
  const avatar = make('div', 'profile-avatar');
  const image = make('img', '');
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  setAvatarImage(image, item);
  avatar.append(image);
  top.append(avatar);
  const title = make('div', 'creator-title');
  title.append(make('h3', '', item.name || t('creatorProfile')));
  if (item.mainUsername) title.append(make('p', 'creator-username', `@${item.mainUsername.replace(/^@/, '')}`));
  top.append(title);
  const favorite = make('button', 'favorite-button');
  favorite.innerHTML = FKIcons.icon('heart', { size: 20 });
  favorite.classList.toggle('is-favorite', item.favorite);
  favorite.type = 'button';
  favorite.setAttribute('aria-label', item.favorite ? t('removeFromShortlist') : t('addToShortlist'));
  favorite.setAttribute('aria-pressed', String(item.favorite));
  favorite.addEventListener('click', () => saveFeedback(item, !item.favorite, item.comment));
  top.append(favorite);
  card.append(top);

  const badges = make('div', 'creator-status');
  if (item.verified) badges.append(createTrustBadge('verified'));
  if (item.mawthouq) badges.append(createTrustBadge('mawthouq'));
  card.append(badges);
  card.append(renderSocialAccounts(item));

  const location = make('div', 'creator-location');
  if (item.city) {
    const city = make('span', 'creator-city');
    city.append(makeIcon('map-pin', 'creator-city-icon'));
    city.append(make('span', '', window.FKI18n?.displayValue(item.city, state.language) || item.city));
    location.append(city);
  }
  if (item.area) location.append(make('span', '', window.FKI18n?.displayValue(item.area, state.language) || item.area));
  if (!item.city && !item.area) location.append(make('span', '', t('locationUnavailable')));
  card.append(location);

  const categories = make('div', 'creator-categories');
  for (const category of item.categories.slice(0, 3)) categories.append(make('span', 'fk-chip', window.FKI18n?.displayValue(category, state.language) || category));
  if (item.categories.length > 3) categories.append(make('span', 'fk-chip category-more', `+${item.categories.length - 3}`));
  card.append(categories);

  const footer = make('div', 'card-footer');
  if (item.comment) {
    const comment = make('span', 'comment-indicator');
    comment.innerHTML = FKIcons.icon('at-sign', { size: 16 });
    comment.append(document.createTextNode(item.comment));
    footer.append(comment);
  }
  const details = make('button', 'fk-button fk-button-secondary', t('viewProfile'));
  details.type = 'button';
  details.addEventListener('click', () => openProfile(item));
  footer.append(details);
  card.append(footer);
  return card;
}

function renderItems() {
  const grid = $('#creator-grid');
  grid.replaceChildren();
  grid.classList.toggle('list-view', state.view === 'list');
  for (const item of state.items) grid.append(renderCreatorCard(item));
  const parseFollowers = (value) => window.FikratakFollowerTiers?.parse(value) || 0;
  const pageFollowers = state.items.reduce((sum, item) => sum + item.socialAccounts.reduce((total, account) => total + parseFollowers(account.followers), 0), 0);
  const pageCities = new Set(state.items.map((item) => item.city).filter(Boolean)).size;
  $('#visible-followers').textContent = new Intl.NumberFormat(state.language === 'ar' ? 'ar' : 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(pageFollowers);
  $('#visible-cities').textContent = new Intl.NumberFormat(state.language === 'ar' ? 'ar' : 'en').format(pageCities);
  const list = currentList();
  $('#list-count').textContent = new Intl.NumberFormat(state.language === 'ar' ? 'ar' : 'en').format(list?.total || 0);
  $('#results-label').textContent = `${new Intl.NumberFormat(state.language === 'ar' ? 'ar' : 'en').format(state.total)} ${t('results')}`;
  $('#empty-state').hidden = state.items.length > 0;
  renderPagination();
}

function renderPagination() {
  const host = $('#pagination');
  host.replaceChildren();
  if (state.pageCount <= 1) return;
  const previous = make('button', '', state.language === 'ar' ? 'السابق' : 'Previous');
  previous.type = 'button';
  previous.disabled = state.page <= 1;
  previous.addEventListener('click', () => { state.page -= 1; loadItems(); });
  host.append(previous);
  const start = Math.max(1, state.page - 2);
  const end = Math.min(state.pageCount, state.page + 2);
  for (let page = start; page <= end; page += 1) {
    const button = make('button', '', String(page));
    button.type = 'button';
    if (page === state.page) button.setAttribute('aria-current', 'page');
    button.setAttribute('aria-label', `${t('page')} ${page} ${t('of')} ${state.pageCount}`);
    button.addEventListener('click', () => { state.page = page; loadItems(); });
    host.append(button);
  }
  const next = make('button', '', state.language === 'ar' ? 'التالي' : 'Next');
  next.type = 'button';
  next.disabled = state.page >= state.pageCount;
  next.addEventListener('click', () => { state.page += 1; loadItems(); });
  host.append(next);
}

function renderProfile() {
  const dialog = $('#profile-dialog');
  const item = state.activeItem;
  if (!item) return;
  const profileAvatar = $('#profile-avatar');
  const profileImage = make('img', '');
  profileImage.alt = '';
  setAvatarImage(profileImage, item);
  profileAvatar.replaceChildren(profileImage);
  $('#profile-title').textContent = item.name || t('creatorProfile');
  $('#profile-username').textContent = item.mainUsername ? `@${item.mainUsername.replace(/^@/, '')}` : '';
  const badges = $('#profile-badges');
  badges.replaceChildren();
  if (item.verified) badges.append(createTrustBadge('verified'));
  if (item.mawthouq) badges.append(createTrustBadge('mawthouq'));
  $('#profile-location').textContent = [item.city, item.area].filter(Boolean).map((value) => window.FKI18n?.displayValue(value, state.language) || value).join(' · ') || t('locationUnavailable');
  const categories = $('#profile-categories');
  categories.replaceChildren(...item.categories.map((category) => make('span', 'fk-chip', window.FKI18n?.displayValue(category, state.language) || category)));
  const socials = $('#profile-socials');
  socials.replaceWith(renderSocialAccounts(item, true));
  $('#profile-socials')?.removeAttribute('id');
  const profileSocials = $('.profile-socials', dialog);
  if (profileSocials) profileSocials.id = 'profile-socials';
  $('#feedback-form [name="comment"]').value = item.comment || '';
  const favoriteButton = $('#profile-favorite');
  favoriteButton.dataset.favorite = String(item.favorite);
  favoriteButton.setAttribute('aria-pressed', String(item.favorite));
  favoriteButton.querySelector('span[aria-hidden="true"]').innerHTML = FKIcons.icon('heart', { size: 18 });
  favoriteButton.classList.toggle('is-favorite', item.favorite);
  favoriteButton.querySelector('span:last-child').textContent = t(item.favorite ? 'removeFromShortlist' : 'addToShortlist');
  $('#feedback-message').textContent = '';
}

function openProfile(item) {
  state.activeItem = item;
  renderProfile();
  $('#profile-dialog').showModal();
}

async function saveFeedback(item, favorite, comment) {
  if (state.preview) {
    item.favorite = favorite;
    item.comment = comment;
    if (state.activeItem?.id === item.id) renderProfile();
    renderItems();
    showToast(t('previewOnly'));
    return;
  }
  try {
    const wasFavorite = Boolean(item.favorite);
    const result = await api(`/api/client-portal/showcases/${state.listId}/feedback/${item.id}`, {
      method: 'PUT', body: { favorite, comment }
    });
    item.favorite = result.favorite;
    item.comment = result.comment;
    const list = currentList();
    if (list && wasFavorite !== result.favorite) list.favoriteCount = Math.max(0, Number(list.favoriteCount || 0) + (result.favorite ? 1 : -1));
    if (state.activeItem?.id === item.id) renderProfile();
    await loadItems(state.page);
    showToast(t('feedbackSaved'));
  } catch (error) {
    showToast(error.message);
  }
}

function setBusy(busy) {
  $('#creator-grid').setAttribute('aria-busy', String(busy));
  if (busy) {
    const grid = $('#creator-grid');
    grid.replaceChildren();
    for (let index = 0; index < 6; index += 1) {
      const skeleton = make('div', 'fk-surface creator-skeleton');
      skeleton.append(make('div', 'fk-skeleton skeleton-avatar'), make('div', 'fk-skeleton skeleton-line'), make('div', 'fk-skeleton skeleton-line short'));
      grid.append(skeleton);
    }
  }
}

function sortPreviewItems() {
  let items = [...state.previewItems];
  if ($('#sort-select').value === 'name') items = [...items].sort((left, right) => left.name.localeCompare(right.name, state.language));
  if ($('#sort-select').value === 'followers') {
    const score = (item) => Math.max(0, ...item.socialAccounts.map((account) => {
      const value = String(account.followers || '').replace(/[٬،,\s]/g, '');
      const match = value.match(/^([\d.]+)([kKmMbB])?$/);
      if (!match) return 0;
      return Number(match[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1);
    }));
    items = [...items].sort((left, right) => score(right) - score(left));
  }
  return items;
}

async function loadItems(page = state.page) {
  if (!state.listId) return;
  state.page = page;
  const requestId = ++state.requestId;
  setBusy(true);
  try {
    if (state.preview) {
      const sorted = sortPreviewItems();
      state.total = sorted.length;
      state.pageCount = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
      state.page = Math.min(Math.max(1, page), state.pageCount);
      state.items = sorted.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
      renderShowcaseHeader();
      renderListTabs();
      renderItems();
      return;
    }
    const params = queryFor(page);
    const result = await api(`/api/client-portal/showcases/${state.listId}?${params}`);
    if (requestId !== state.requestId) return;
    state.items = result.items || [];
    state.total = result.total || 0;
    state.page = result.page || 1;
    state.pageCount = result.pageCount || 1;
    const selectedList = currentList();
    renderShowcaseHeader();
    renderListTabs();
    renderItems();
  } catch (error) {
    if (error.status === 401) showLogin();
    else showToast(error.message || t('loadError'));
  } finally {
    if (requestId === state.requestId) setBusy(false);
  }
}

async function loadShowcases(account) {
  state.account = account;
  const result = await api('/api/client-portal/showcases');
  state.lists = result.lists || [];
  $('#client-identity').textContent = result.client?.name || result.client?.company || account.clientName || '';
  $('#client-identity').hidden = false;
  $('#login-view').hidden = true;
  $('#client-view').hidden = false;
  $('#logout-button').hidden = false;
  if (!state.lists.length) {
    $('#showcase-title').textContent = account.clientName || account.companyName || '';
    $('#showcase-company').textContent = t('noLists');
    $('#list-count').textContent = '0';
    $('#creator-grid').replaceChildren();
    $('#empty-state').hidden = false;
    renderListTabs();
    return;
  }
  state.listId = state.lists[0].id;
  renderListTabs();
  await loadItems(1);
}

function showLogin(message = '') {
  $('#client-view').hidden = true;
  $('#login-view').hidden = false;
  $('#logout-button').hidden = true;
  $('#client-identity').hidden = true;
  $('#preview-exit').hidden = true;
  $('#login-message').textContent = message;
}

async function boot() {
  const previewCatalogId = new URLSearchParams(location.search).get('previewCatalog');
  if (previewCatalogId) {
    try {
      const result = await api(`/api/client-catalogs/${encodeURIComponent(previewCatalogId)}/showcase-preview`);
      state.preview = true;
      state.account = result.client;
      state.lists = [{ ...result.list, favoriteCount: 0 }];
      state.listId = result.list.id;
      state.previewItems = result.items || [];
      state.total = state.previewItems.length;
      $('#client-identity').textContent = t('previewMode');
      $('#client-identity').hidden = false;
      $('#preview-exit').hidden = false;
      $('#login-view').hidden = true;
      $('#client-view').hidden = false;
      $('#logout-button').hidden = true;
      renderListTabs();
      await loadItems(1);
    } catch (error) {
      showLogin(error.status === 401 || error.status === 403 ? 'سجّل دخولك إلى النظام الداخلي لمعاينة العرض.' : error.message);
    }
    return;
  }
  try {
    const session = await api('/api/client-portal/session');
    if (session.account) await loadShowcases(session.account);
    else showLogin();
  } catch {
    showLogin();
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  const button = formElement.querySelector('button[type="submit"]');
  button.disabled = true;
  $('#login-message').textContent = '';
  try {
    const result = await api('/api/client-portal/login', { method: 'POST', body: { email: form.get('email'), password: form.get('password') } });
    formElement.reset();
    await loadShowcases(result.account);
  } catch {
    $('#login-message').textContent = t('loginError');
  } finally { button.disabled = false; }
});

$('#logout-button').addEventListener('click', async () => {
  try { await api('/api/client-portal/logout', { method: 'POST', body: {} }); } catch {}
  state.account = null;
  state.lists = [];
  state.items = [];
  showLogin();
});

$('#language-toggle').addEventListener('click', () => {
  state.language = state.language === 'ar' ? 'en' : 'ar';
  try { localStorage.setItem('fikratak.showcase.language', state.language); } catch {}
  setLanguage(state.language);
});

$('#theme-toggle').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('fikratak.showcase.theme', state.theme); } catch {}
  setTheme(state.theme);
});

$('#sort-select').addEventListener('change', () => loadItems(1));

$('#grid-view-button').addEventListener('click', () => {
  state.view = 'grid';
  $('#grid-view-button').setAttribute('aria-pressed', 'true');
  $('#list-view-button').setAttribute('aria-pressed', 'false');
  $('#creator-grid').classList.remove('list-view');
});
$('#list-view-button').addEventListener('click', () => {
  state.view = 'list';
  $('#grid-view-button').setAttribute('aria-pressed', 'false');
  $('#list-view-button').setAttribute('aria-pressed', 'true');
  $('#creator-grid').classList.add('list-view');
});

$('#close-profile').addEventListener('click', () => $('#profile-dialog').close());
$('#profile-dialog').addEventListener('click', (event) => { if (event.target === $('#profile-dialog')) $('#profile-dialog').close(); });
$('#profile-favorite').addEventListener('click', () => {
  const item = state.activeItem;
  if (item) void saveFeedback(item, !item.favorite, $('#feedback-form [name="comment"]').value.trim());
});
$('#feedback-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const item = state.activeItem;
  if (!item) return;
  const comment = new FormData(event.currentTarget).get('comment');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  await saveFeedback(item, item.favorite, String(comment || '').trim());
  button.disabled = false;
});

state.language = window.FKUI?.getPreference('fikratak.showcase.language', 'ar') === 'en' ? 'en' : 'ar';
state.theme = window.FKUI?.getPreference('fikratak.showcase.theme', 'light') === 'dark' ? 'dark' : 'light';
setTheme(state.theme);
setLanguage(state.language);
boot();