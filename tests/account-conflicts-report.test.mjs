import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const sectionStart = indexHtml.indexOf('<section class="workspace section-panel" id="account-conflicts-section"');
const sectionEnd = indexHtml.indexOf('<section class="workspace section-panel" id="about-section"', sectionStart);
const section = indexHtml.slice(sectionStart, sectionEnd);

test('account conflicts report explains detection, review status, evidence, and safe next steps', () => {
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, 'Account conflicts report should exist');
  for (const requiredText of [
    'ما هو تقرير تعارضات الحسابات؟',
    'هذا التقرير يساعد الإدارة على اكتشاف حسابات التواصل الاجتماعي التي تم ربطها بأكثر من سجل لمؤثر داخل النظام.',
    'قد يحدث ذلك بسبب خطأ في إدخال البيانات، أو استيراد ملف Excel، أو وجود حساب مشترك بين أكثر من سجل.',
    'يعرض التقرير هذه الحالات للمراجعة فقط، ولا يعني بالضرورة أن البيانات خاطئة. لا يقوم النظام تلقائيًا بنقل الحسابات أو دمج المؤثرين أو حذف أي بيانات.',
    'حالات تعارض مكتشفة',
    'حالات تم التحقق منها',
    'حالات لا تزال للمراجعة',
    'تعارض مكتشف:',
    'يحتاج مراجعة:',
    'تم التحقق:',
    'ماذا أفعل الآن؟',
    'id="account-conflicts-scanned-at"',
    'id="account-conflicts-rows"'
  ]) {
    assert.ok(section.includes(requiredText), `Account conflicts report should include: ${requiredText}`);
  }
});

test('account conflict cards distinguish recorded links from proof of ownership', () => {
  assert.match(indexHtml, /account-conflict-evidence/);
  assert.match(indexHtml, /لا يثبت ذلك ملكية الحساب أو السجل الصحيح/);
  assert.match(indexHtml, /Influencer ID/);
  assert.match(indexHtml, /account-conflicts-reviewed'\)\.textContent = numberFormat\.format\(0\)/);
  assert.match(indexHtml, /account-conflicts-pending'\)\.textContent = numberFormat\.format\(pending\)/);
});
