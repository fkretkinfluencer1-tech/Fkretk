import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [clientHtml, campaignHtml, managementHtml, portalHtml, clientAccountsHtml, clientStyles,
  campaignStyles, managementStyles, portalStyles, clientAccountsStyles] = await Promise.all([
  readFile(new URL('../client.html', import.meta.url), 'utf8'),
  readFile(new URL('../campaign-presentation.html', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../portal.html', import.meta.url), 'utf8'),
  readFile(new URL('../client-accounts.html', import.meta.url), 'utf8'),
  readFile(new URL('../assets/client.css', import.meta.url), 'utf8'),
  readFile(new URL('../assets/presentation.css', import.meta.url), 'utf8'),
  readFile(new URL('../assets/admin.css', import.meta.url), 'utf8'),
  readFile(new URL('../assets/portal.css', import.meta.url), 'utf8'),
  readFile(new URL('../assets/client-accounts.css', import.meta.url), 'utf8')
]);
const clientPage = `${clientHtml}\n${clientStyles}`;
const campaignPage = `${campaignHtml}\n${campaignStyles}`;
const managementPage = `${managementHtml}\n${managementStyles}`;
const portalPage = `${portalHtml}\n${portalStyles}`;
const clientAccountsPage = `${clientAccountsHtml}\n${clientAccountsStyles}`;
const showcasePage = await readFile(new URL('../showcase.html', import.meta.url), 'utf8');
const showcaseScript = await readFile(new URL('../assets/showcase.js', import.meta.url), 'utf8');
const sharedDesign = await readFile(new URL('../assets/fikratak-design.css', import.meta.url), 'utf8');
const sharedUi = await readFile(new URL('../assets/ui.js', import.meta.url), 'utf8');
const showcaseStyles = await readFile(new URL('../assets/showcase.css', import.meta.url), 'utf8');
const releaseScript = await readFile(new URL('../scripts/create-production-release.mjs', import.meta.url), 'utf8');
const placeholders = await Promise.all(['male', 'female', 'neutral'].map((type) =>
  readFile(new URL(`../assets/influencer-placeholder-${type}.svg`, import.meta.url), 'utf8')));
const avatarFiles = ['female.svg', 'female-hijab.svg', 'male.svg', 'neutral.svg'];
const avatars = await Promise.all(avatarFiles.map((name) =>
  readFile(new URL(`../assets/avatars/${name}`, import.meta.url), 'utf8')));
const serverSource = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

test('versioned UI assets are external, included in releases, and readable on mobile', () => {
  const pages = [managementHtml, clientAccountsHtml, clientHtml, portalHtml, campaignHtml, showcasePage];
  for (const page of pages) {
    assert.doesNotMatch(page, /<style\b|\sstyle\s*=/i);
  }
  assert.match(managementHtml, /<div class="sidebar-footer-card">[\s\S]*?UI v2\.0[\s\S]*?<\/div>/);
  for (const page of [clientAccountsHtml, clientHtml, portalHtml, campaignHtml, showcasePage]) {
    assert.doesNotMatch(page, /class="ui-version-footer"|>UI v2\.0</);
  }
  for (const asset of ['fikratak-design.css', 'admin.css', 'client-accounts.css', 'client.css',
    'portal.css', 'presentation.css', 'showcase.css', 'ui.js', 'i18n.js',
    'influencer-placeholder-male.svg', 'influencer-placeholder-female.svg',
    'influencer-placeholder-neutral.svg']) {
    assert.ok(releaseScript.includes(`'assets/${asset}'`), `Missing ${asset} in release manifest`);
  }
  for (const name of avatarFiles) assert.ok(releaseScript.includes(`'assets/avatars/${name}'`));
  const styles = [sharedDesign, clientStyles, campaignStyles, managementStyles, portalStyles,
    clientAccountsStyles, showcaseStyles].join('\n');
  assert.doesNotMatch(styles, /font-size:\s*(?:[0-9]|1[01])px/);
  assert.match(styles, /@media\s*\(max-width:/);
});

test('client showcase and portal expose no search or filters; database filters stay available', () => {
  assert.doesNotMatch(showcasePage, /id="(?:search-input|category-filter|city-filter|platform-filter|tier-filter|clear-filters|shortlist-toggle)"/);
  assert.doesNotMatch(showcaseScript, /\$\('#(?:search-input|category-filter|city-filter|platform-filter|tier-filter|clear-filters|shortlist-toggle)'/);
  assert.doesNotMatch(portalHtml, /id="(?:campaign-search|offer-search|offer-platform-filter|offer-status-filter|visit-from|visit-to|visit-sort|published-visit-day)"|data-mobile-filter|data-offer-filter/);
  assert.doesNotMatch(portalHtml, /\$\('#(?:campaign-search|offer-search|offer-platform-filter|offer-status-filter|visit-from|visit-to|visit-sort|published-visit-day)'/);
  assert.doesNotMatch(portalStyles, /\.portal-tools|\.offer-filters/);
  assert.match(managementHtml, /id="platform-filter"/);
  assert.match(sharedDesign, /\[data-mobile-filter-panel\]\.mobile-filter-sheet-open/);
  assert.match(sharedUi, /function initMobileFilterSheets\(\)/);
  assert.match(sharedUi, /event\.key !== 'Escape'/);
});

test('admin header has no disconnected search or notification controls and retains database filters', () => {
  assert.doesNotMatch(managementHtml, /app-global-search|notification-button|Ctrl.{0,3}K/);
  assert.doesNotMatch(managementStyles, /app-global-search|search-shortcut|notification-dot/);
  assert.match(managementHtml, /class="database-filter-panel"/);
  assert.match(managementStyles, /grid-template-columns:\s*minmax\(0,1fr\)\s+auto/);
});

test('client-facing pages remove PDF export and suppress browser printing', () => {
  const clientPages = [
    [clientHtml, clientStyles, 'print-catalog', 'cards-grid-view', 'cards-list-view'],
    [portalHtml, portalStyles, 'print-offers', 'offer-grid-view', 'offer-list-view'],
    [campaignHtml, campaignStyles, 'print-presentation', null, null],
    [showcasePage, showcaseStyles, 'pdf-button', 'grid-view-button', 'list-view-button']
  ];
  for (const [html, styles, printId, gridId, listId] of clientPages) {
    assert.doesNotMatch(html, new RegExp(`id="${printId}"|window\\.print\\(|طباعة\\\\s*\\\\/\\\\s*PDF|Print\\\\s*\\\\/\\\\s*PDF`));
    if (gridId) assert.ok(html.includes(`id="${gridId}"`), `Missing grid view control ${gridId}`);
    if (listId) assert.ok(html.includes(`id="${listId}"`), `Missing list view control ${listId}`);
    assert.match(styles, /@media print\s*\{\s*body \* \{\s*display:\s*none !important;\s*\}\s*body::after\s*\{\s*content:\s*"هذا العرض غير متاح للطباعة";\s*display:\s*block;\s*text-align:\s*center;\s*padding:\s*48px;\s*font:\s*700 18px Cairo, sans-serif;/);
  }
  assert.doesNotMatch(showcaseScript, /PRINT_PAGE_SIZE|PRINT_LIMIT|printShowcase|printMode|pdf-button|savePdf|pdfLimit|pdfError|print-sheet|window\.print|PDF/i);
});

test('Arabic typography and text selection are consistent across system pages and themes', () => {
  assert.match(sharedDesign, /font-family:\s*Cairo;[\s\S]*?url\("\/assets\/cairo-arabic\.woff2"\)/);
  assert.match(sharedDesign, /font-family:\s*Cairo;[\s\S]*?url\("\/assets\/cairo-latin\.woff2"\)/);
  assert.match(sharedDesign, /body\s*\{\s*line-height:\s*1\.75;/);
  assert.match(sharedDesign, /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{\s*line-height:\s*1\.55;/);
  assert.match(sharedDesign, /::selection\s*\{\s*color:\s*var\(--fk-selection-foreground\);\s*background:\s*var\(--fk-selection-background\);/);
  assert.match(sharedDesign, /--fk-selection-background:\s*#B9D9EF/);
  assert.match(sharedDesign, /--fk-selection-foreground:\s*#123F5E/);
  assert.match(sharedDesign, /:root\[data-theme="light"\]\s*\{[^}]*--fk-selection-background:\s*#B9D9EF/);
  assert.match(sharedDesign, /--fk-selection-background:\s*#2D668B/);
  assert.match(sharedDesign, /--fk-selection-foreground:\s*#FFFFFF/);
  assert.match(managementPage, /h1\s*\{[^}]*line-height:\s*1\.55/);
  assert.match(clientPage, /h1\s*\{[^}]*line-height:\s*1\.55/);
  assert.match(showcaseStyles, /\.login-copy h1\s*\{[^}]*line-height:\s*1\.55/);
  assert.match(showcaseStyles, /\.showcase-hero h1\s*\{[^}]*line-height:\s*1\.55/);
  for (const page of [managementHtml, clientHtml, portalHtml, clientAccountsHtml, showcasePage, campaignHtml]) {
    assert.match(page, /href="\/assets\/fikratak-design\.css(?:\?v=[^"]+)?"/);
  }
});

test('admin database adds accessible selection, filter chips, and role-gated bulk controls', () => {
  for (const id of ['database-select-page', 'database-active-filters', 'database-bulk-actions',
    'database-export-selected', 'database-archive-selected', 'database-column-options']) {
    assert.ok(managementHtml.includes(`id="${id}"`), `Missing database control ${id}`);
  }
  assert.match(managementHtml, /state\.user\?\.role !== 'admin' \|\|/);
  assert.match(managementHtml, /state\.user\?\.role !== 'admin' \|\| !state\.databaseSelectedIds\.size/);
  assert.match(managementHtml, /data-database-column-toggle/);
  assert.match(managementStyles, /#table-wrap tbody tr \{ height:\s*56px/);
  assert.match(managementStyles, /\.table-wrap thead \{ position:\s*sticky/);
  assert.match(managementStyles, /@media \(max-width: 560px\) \{\s*#table-wrap \{ max-height: none; overflow: visible; \}\s*#table-wrap table \{ width: 100%; min-width: 0; \}\s*#table-wrap tbody tr \{ height: auto; \}\s*#table-wrap tbody td \{ height: auto; overflow: visible; \}\s*#table-wrap \.database-accounts \{ display: grid; grid-template-columns: minmax\(0,1fr\); overflow: visible; \}\s*#table-wrap \.database-account \{ max-width: 100%; flex: initial; flex-wrap: wrap; \}/);
  assert.match(managementStyles, /\.auth-main \{ direction:ltr/);
  assert.match(clientAccountsStyles, /\.form \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test('Ryfaq client presentations use isolated premium light and dark themes', () => {
  assert.match(clientPage, /body\[data-brand="ryfaq"\]\[data-theme="dark"\]/);
  assert.match(clientPage, /--paper: #111a14/);
  assert.match(clientPage, /--surface: #202c24/);
  assert.match(clientPage, /--green: #427e60/);
  assert.match(clientPage, /ryfaq\.client\.theme/);
  assert.match(clientPage, /sanitizeRyfaqSurface\(\)/);
  assert.match(clientPage, /favicon\.removeAttribute\('href'\)/);
  assert.match(clientPage, /brandLink\.removeAttribute\('href'\)/);
  assert.match(clientPage, /#company-work-gallery,[\s\S]*#work-video-dialog \{ display: none !important; \}/);
});

test('Ryfaq campaign presentations expose a brand-specific theme toggle without changing FKRETK defaults', () => {
  assert.match(campaignPage, /id="theme-toggle"[^>]+hidden/);
  assert.match(campaignPage, /body\[data-brand="ryfaq"\]\[data-theme="dark"\]/);
  assert.match(campaignPage, /presentationThemeKey = 'ryfaq-campaign-presentation-theme'/);
  assert.match(campaignPage, /themeToggle\.hidden = brand\.id !== 'ryfaq'/);
  assert.match(campaignPage, /sanitizeRyfaqSurface\(\)/);
  assert.match(campaignPage, /brand\?\.id === 'ryfaq' \? \[\]/);
  assert.match(campaignPage, /renderCompanyWorkGallery\(selectedVideos\)/);
});

test('Client video showcases use horizontal lazy previews and preview selected videos before publishing', () => {
  assert.match(clientPage, /id="company-work-title">من مكتبة فكرتك الرقمية مع صُنّاع المحتوى والمؤثرين/);
  assert.match(clientPage, /نمنح علامتك التجارية صوتًا يصل إلى جمهورها، ونحوّل رسالتها إلى محتوى إبداعي يتحدث عنها بأسلوب مؤثر/);
  assert.match(clientPage, /ومن المملكة إلى الخليج العربي، نصنع لعلامتك حضورًا يُسمع ويُرى، ونوسّع انتشارها من خلال صُنّاع المحتوى والمؤثرين/);
  assert.match(clientPage, /width: min\(1680px, 100%\)/);
  assert.match(clientPage, /grid-auto-columns: minmax\(350px, min\(37%, 530px\)\)/);
  assert.match(clientPage, /grid-auto-columns: 100%/);
  assert.match(clientPage, /grid-auto-flow: column/);
  assert.match(clientPage, /overflow-x: auto/);
  assert.match(clientPage, /scrollBy\(\{/);
  assert.match(clientPage, /pointermove/);
  assert.match(clientPage, /thumbnail\.loading = 'lazy'/);
  assert.match(clientPage, /object-fit: contain/);
  assert.match(clientPage, /id="coverage-gallery"/);
  assert.match(clientPage, /Portfolio · Coverage/);
  assert.match(clientPage, /grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 360px\), 1fr\)\)/);
  assert.match(clientPage, /aspect-ratio: 16 \/ 9/);
  assert.match(clientPage, /coverageVideos: Array\.isArray\(result\.coverageVideos\)/);
  assert.match(clientPage, /new IntersectionObserver/);
  assert.match(clientPage, /prefers-reduced-motion: reduce/);
  assert.match(clientPage, /body\[data-theme="dark"\] \{/);
  assert.match(clientPage, /--paper: #101922/);
  assert.match(clientPage, /width: min\(1680px, 100%\)/);
  assert.match(clientPage, /@media \(min-width: 1500px\)/);
  assert.match(clientPage, /data-reveal/);
  assert.match(clientPage, /bestPlatform/);
  assert.match(campaignPage, /بعض أعمال فكرتك الرقمية مع صُنّاع المحتوى والمؤثرين/);
  assert.match(campaignPage, /من رؤيتك إلى جمهورك، نصنع حضورًا لعلامتك التجارية من خلال رسائل تسويقية تعكس هويتها، وتنقل كل تفصيلة تحب توصلها لعملائك/);
  assert.match(campaignPage, /ونصنع لمنتجاتك تجربة يرويها صُنّاع المحتوى من واقع تجربتهم، ليقترب الجمهور منها ويتعرّف على قيمتها ومميزاتها/);
  assert.match(campaignPage, /width: min\(1480px,calc\(100vw - 40px\)\)/);
  assert.match(campaignPage, /grid-auto-columns: clamp\(340px,44vw,600px\)/);
  assert.match(campaignPage, /grid-auto-columns: 100%/);
  assert.match(campaignPage, /scrollbar-width: none/);
  assert.match(campaignPage, /\.video-grid:focus-visible/);
  assert.match(campaignPage, /event\.key === 'ArrowRight'/);
  assert.match(campaignPage, /getComputedStyle\(rail\)\.direction === 'rtl' \? -1 : 1/);
  assert.match(campaignPage, /track\.tabIndex = 0/);
  assert.match(campaignPage, /if \(titleText\) \{/);
  assert.match(campaignPage, /host: 'https:\/\/www\.youtube-nocookie\.com'/);
  assert.match(campaignPage, /controls: 1/);
  assert.match(campaignPage, /autoplay: 1/);
  assert.match(campaignPage, /image\.loading = 'lazy'/);
  assert.match(campaignPage, /new youtube\.Player/);
  assert.match(campaignPage, /openVideoPreview\(video, card, words\)/);
  assert.match(managementPage, /id="catalog-work-video-preview"/);
  assert.match(managementPage, /معاينة الاختيارات/);
  assert.match(managementPage, /renderSelectedWorkVideoPreviews\(preview, videos, selectedIds\)/);
  assert.match(managementPage, /input\.disabled = !video\.active && !input\.checked/);
  assert.match(managementPage, /width: 235px; min-width: 235px/);
  assert.match(managementPage, /grid-auto-columns: minmax\(310px, 34vw\)/);
  assert.match(clientPage, /setInfluencerAvatar\(avatarBox, influencer\)/);
  assert.match(clientPage, /\/assets\/avatars\/female-hijab\.svg/);
  assert.doesNotMatch(clientPage, /FKUI\.createAvatar\(name, influencer\.influencerId\)/);
  assert.ok(clientPage.includes('profileImage = String(influencer.profileImage || \'\')'));
  assert.ok(clientPage.includes('[a-f0-9]{32}'));
  assert.match(campaignPage, /target\.placeholderImage/);
  assert.match(managementPage, /function profilePlaceholderSource\(record\)/);
  assert.ok(placeholders.every((svg) => svg.includes('<svg') && svg.includes('</svg>')));
  assert.ok(avatars.every((svg) => svg.includes('<svg') && svg.includes('</svg>')));
  assert.match(serverSource, /function profilePlaceholderUrl\(record\)/);
  assert.match(serverSource, /\/assets\/avatars\/female-hijab\.svg/);
  assert.match(serverSource, /\/assets\/avatars\/male\.svg/);
  assert.match(serverSource, /\/assets\/avatars\/neutral\.svg/);
});

test('agency preview returns to the saved client-preparation state', () => {
  assert.match(managementPage, /function saveClientPreparationReturnState\(\)/);
  assert.match(managementPage, /function restoreClientPreparationReturnState\(user\)/);
  assert.match(managementPage, /sessionStorage\.setItem\(CLIENT_PREP_RETURN_KEY/);
  assert.match(managementPage, /selectedIds: \[\.\.\.state\.clientSelectedIds\]/);
  assert.match(managementPage, /if \(!saveClientPreparationReturnState\(\)\) return;/);
  assert.match(managementPage, /restoreClientPreparationReturnState\(session\.user\)/);
  assert.match(clientPage, /href="\/\?restore-client-preparation=1"/);
  assert.match(clientPage, /history\.back\(\)/);
  assert.doesNotMatch(managementPage, /import-catalog-decisions|catalogDecisionImportId/);
  assert.doesNotMatch(managementPage, /catalog-export-city|catalog-export-followers|catalog-export-date/);
});

test('custom influencer offers use an expanded presentation layout with lazy reveal and Coverage', () => {
  assert.match(clientPage, /width: min\(1680px, 100%\)/);
  assert.match(clientPage, /grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 340px\), 1fr\)\)/);
  assert.match(clientPage, /id="company-identity"/);
  assert.match(clientPage, /id="coverage-gallery"/);
  assert.match(clientPage, /aspect-ratio: 16 \/ 9/);
  assert.match(clientPage, /object-fit: contain/);
  assert.match(clientPage, /new IntersectionObserver/);
  assert.match(clientPage, /prefers-reduced-motion: reduce/);
  assert.match(clientPage, /--paper: #101922/);
  assert.match(clientPage, /catalogSettings\.coverageVideos/);
  assert.match(clientPage, /bestPlatform/);
});

test('country dialing code is derived from the selected country and previewed with the local number', () => {
  assert.match(managementPage, /name: 'Country Code'[^\n]*readOnly: true/);
  assert.match(managementPage, /countryCode\.value = country\?\.dialCode \|\| ''/);
  assert.match(managementPage, /fullInput\.value = code && local \? `\+\$\{code\}\$\{local\}` : ''/);
});

test('catalog account visibility and Coverage have independent agency controls', () => {
  assert.match(managementPage, /id="coverage-tab"/);
  assert.match(managementPage, /id="coverage-section"/);
  assert.match(managementPage, /id="coverage-url"/);
  assert.match(managementPage, /id="coverage-influencer"/);
  assert.match(managementPage, /id="coverage-campaign"/);
  assert.match(managementPage, /coverage-filter-influencer/);
  assert.match(managementPage, /coverage-filter-campaign/);
  assert.match(managementPage, /function catalogVisibilityForRecord\(record\)/);
  assert.match(managementPage, /checkbox\.checked = visibility\[platform\] !== false/);
  assert.match(managementPage, /accountVisibility: catalogVisibilityPayload\(\)/);
  assert.match(managementPage, /coverageCount \|\| 0/);
  assert.match(managementPage, /if \(!\['admin', 'editor'\]\.includes\(state\.user\?\.role\)\) return;/);
});

test('Coverage edits are temporary until the API confirms a save', () => {
  const coverageForm = managementPage.match(/<form id="coverage-form"[\s\S]*?<\/form>/)?.[0] || '';
  const sectionActivation = managementPage.match(/function activateSection\(sectionName[\s\S]*?\n    \}/)?.[0] || '';
  const coverageSubmit = managementPage.match(/\$\('#coverage-form'\)\.addEventListener\('submit'[\s\S]*?\n    \}\);/)?.[0] || '';
  assert.match(coverageForm, /autocomplete="off"/);
  assert.match(sectionActivation, /!coverageActive[\s\S]*?resetCoverageForm\(\)/);
  assert.match(managementPage, /addEventListener\('pagehide', resetCoverageForm\)/);
  assert.match(managementPage, /addEventListener\('pageshow', resetCoverageForm\)/);
  assert.doesNotMatch(managementPage, /(?:localStorage|sessionStorage)\.(?:getItem|setItem)\([^)]*coverage/i);
  assert.match(coverageSubmit, /await api\(id \?/);
  assert.match(coverageSubmit, /resetCoverageForm\(\);[\s\S]*?showToast\(text\('تم حفظ فيديو التغطية\.'\)\)/);
  assert.match(coverageSubmit, /catch \(error\)[\s\S]*?saveButton\.disabled = false;[\s\S]*?showToast\(error\.message\)/);
  assert.match(managementPage, /:root\[data-theme="dark"\]/);
  assert.match(managementPage, /\.toast \{[^}]*background: var\(--green-dark\)/);
});

test('influencer photo management maps Excel and ZIP files by row and influencer ID', () => {
  const photoSection = managementPage.match(/<section\b[^>]*id="influencer-photos-section"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(photoSection, /id="influencer-photo-template"/);
  assert.match(photoSection, /id="influencer-photo-workbook"/);
  assert.match(photoSection, /id="influencer-photo-zip"/);
  assert.match(photoSection, /id="influencer-photo-zip-button"/);
  assert.match(photoSection, /Influencer ID/);
  assert.match(photoSection, /Username/);
  assert.match(photoSection, /Image File Name/);
  assert.match(photoSection, /ZIP/);
  assert.match(photoSection, /id="influencer-photo-upload"[^>]*>اعتماد الصور المحددة/);
  assert.match(photoSection, /id="influencer-photo-image-dialog"/);
  assert.match(managementPage, /addEventListener\('drop'/);
  assert.match(managementPage, /setInfluencerPhotoStatus\('جارٍ مطابقة الحسابات والتحقق من الصور\.\.\.'/);
  assert.match(managementPage, /@media \(max-width: 850px\)/);
  assert.match(managementPage, /influencer-photo-preview-list tbody tr \{ display: grid;/);
  assert.match(managementPage, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(managementPage, /:root\[data-theme="dark"\] #influencer-photos-section/);
  assert.match(managementPage, /body\.imageArchiveBase64 = await fileAsBase64\(imageArchive\)/);
  assert.doesNotMatch(photoSection, /influencer-photo-folder|Influencer Image/);
});

test('admin login uses the split-screen design with one logo and icon-only floating controls', () => {
  const authShell = managementHtml.match(/<div class="auth-shell"[\s\S]*?<div class="shell" id="app-shell">/)?.[0] || '';
  assert.ok(authShell);
  assert.doesNotMatch(authShell, /<header class="topbar"/);
  assert.equal((authShell.match(/class="auth-mark"/g) || []).length, 1);
  assert.match(authShell, /class="auth-floating-tools"/);
  assert.match(authShell, /<p class="auth-contact-note">تواصل مع مدير النظام<\/p>/);
  assert.doesNotMatch(authShell, /<(?:button|a)[^>]*>تواصل مع مدير النظام/);
  assert.doesNotMatch(authShell, /fkretkinfluencer1@gmail\.com/);
  assert.match(managementStyles, /\.auth-main \{ display: grid; width: 100%; max-width: none; min-height: 100vh; height: 100vh; grid-template-columns: 1fr 1fr/);
  assert.match(managementStyles, /\.auth-form \.form-field input \{ height: 48px/);
});

test('shared local icons and trust badges are versioned with the client and admin pages', async () => {
  const iconHelper = await readFile(new URL('../assets/icons.js', import.meta.url), 'utf8');
  const sprite = await readFile(new URL('../assets/icons/sprite.svg', import.meta.url), 'utf8');
  for (const icon of ['shield-check', 'badge-check', 'female', 'male', 'users', 'at-sign',
    'share', 'map-pin', 'search', 'download', 'instagram', 'tiktok', 'snapchat']) {
    assert.ok(sprite.includes(`id="${icon}"`), `Missing icon ${icon}`);
  }
  assert.match(iconHelper, /stroke-width="1\.75"/);
  assert.match(iconHelper, /data-badge="\$\{kind\}"/);
  assert.match(managementHtml, /assets\/icons\.js/);
  assert.match(clientHtml, /assets\/icons\.js/);
  assert.ok(releaseScript.includes("'assets/icons.js'"));
  assert.ok(releaseScript.includes("'assets/icons/sprite.svg'"));
});

test('showcase cards keep creator identity below the platform banner', () => {
  assert.match(showcaseStyles, /\.creator-card-top \{[^}]*padding: 56px/);
  assert.match(showcaseStyles, /\.creator-card-top \.profile-avatar \{ margin-top: -34px; \}/);
  assert.doesNotMatch(showcaseStyles, /\.creator-card:nth-child/);
  assert.match(showcaseScript, /card\.dataset\.mainPlatform =/);
});

test('dashboard statistics use six semantic icon cards and locally themed tokens', () => {
  const metrics = managementHtml.match(/<div class="dashboard-metrics"[\s\S]*?<\/div>\s*<div class="dashboard-grid">/)?.[0] || '';
  assert.equal((metrics.match(/<article class="dashboard-metric/g) || []).length, 6);
  for (const label of ['الحسابات', 'شهادة موثوق', 'حسابات موثّقة', 'رجال', 'سيدات', 'المدن']) {
    assert.ok(metrics.includes(`<span>${label}</span>`), `Missing metric ${label}`);
  }
  assert.match(metrics, /مؤثرون حاصلون على شهادة موثوق/);
  assert.match(metrics, /مؤثرون بشارة التوثيق على المنصة/);
  assert.match(managementStyles, /\.dashboard-metrics \{ grid-template-columns: repeat\(3,minmax\(0,1fr\)\)/);
});

test('shared light and dark palettes and the client offer preserve the existing profile fields', async () => {
  for (const [token, light, dark] of [
    ['paper', '#F4F8FC', '#0B1B2E'],
    ['surface', '#FFFFFF', '#112740'],
    ['surface-2', '#EEF4FA', '#16304D'],
    ['ink', '#0F2236', '#EAF2FA'],
    ['muted', '#5A6B7D', '#9FB3C8'],
    ['blue-500', '#2D82C4', '#4A9BDB'],
    ['orange-500', '#F78E1E', '#FFA23A'],
    ['success', '#16A34A', '#34D399'],
    ['danger', '#DC2626', '#F87171'],
    ['warning', '#D97706', '#FBBF24']
  ]) {
    assert.match(sharedDesign, new RegExp(`--fk-${token}: ${light}`));
    assert.match(sharedDesign, new RegExp(`--fk-${token}: ${dark}`));
  }
  assert.match(clientHtml, /function avatarFallback\(details\)/);
  assert.match(clientHtml, /female-hijab\.svg/);
  assert.match(clientHtml, /FKBadge\.badge\('mawthouq'/);
  assert.match(clientHtml, /FKBadge\.badge\('verified'/);
  assert.doesNotMatch(clientHtml, /اسم المستخدم الرئيسي|Main username/);
  assert.match(clientHtml, /card\.dataset\.mainPlatform/);
  assert.match(clientStyles, /\.card\[data-main-platform="snapchat"\]::before/);
  assert.match(clientStyles, /\.card\[data-main-platform="instagram"\]::before/);
});
