import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const indexPath = new URL('../index.html', import.meta.url);
const indexHtml = await readFile(indexPath, 'utf8');

test('About FKRETK presents the approved team, available functions, and workflow', () => {
  const sectionStart = indexHtml.indexOf('<section class="workspace section-panel" id="about-section"');
  const sectionEnd = indexHtml.indexOf('<section class="dashboard section-panel" id="dashboard-section"', sectionStart);
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, 'About section should exist in the authenticated application');
  const section = indexHtml.slice(sectionStart, sectionEnd);

  for (const requiredText of [
    'من نحن | About FKRETK',
    'فكرتك الرقمية هي شركة متخصصة في إدارة الحملات التسويقية عبر المؤثرين وصناع المحتوى',
    'رؤيتنا',
    'رسالتنا',
    'خدماتنا',
    'إمكانياتنا التقنية',
    'آلية العمل',
    'الإشراف',
    'م/ محمد سند',
    'التنفيذ',
    'م/ محمد الجاكي',
    'الاختبار والتجربة',
    'م/ أميرة المرشدي',
    'إدارة حملات التسويق بالمؤثرين',
    'استيراد البيانات وتصديرها'
  ]) {
    assert.ok(section.includes(requiredText), `About section should include: ${requiredText}`);
  }

  assert.doesNotMatch(section, /قبول العميل لأسماء المعلنين في العرض لا يعني تلقائيًا بدء حملة أو تأكيد حجز أو تنفيذ زيارة\./);
  assert.match(indexHtml, /id="about-tab"[^>]+aria-controls="about-section"/);
  assert.match(indexHtml, /about-tab'\)\.addEventListener\('click', \(\) => activateSection\('about'/);
});
