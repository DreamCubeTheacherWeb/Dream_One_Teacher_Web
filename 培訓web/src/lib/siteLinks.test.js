import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeHttpUrl, resolveHttpUrl, TEACHING_MATERIALS_LINK } from './siteLinks.js';

test('教材資源預設連結使用指定的 HTTPS 網址', () => {
    assert.equal(TEACHING_MATERIALS_LINK.label, '教材資源');
    assert.equal(TEACHING_MATERIALS_LINK.url, 'https://dreamone-teaching-materials.vercel.app/');
    assert.equal(isSafeHttpUrl(TEACHING_MATERIALS_LINK.url), true);
});

test('只接受不含帳密的 HTTP 或 HTTPS 外部網址', () => {
    assert.equal(isSafeHttpUrl('https://example.com/resources?q=1'), true);
    assert.equal(isSafeHttpUrl(' http://example.com/path '), true);
    assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
    assert.equal(isSafeHttpUrl('data:text/html,unsafe'), false);
    assert.equal(isSafeHttpUrl('ftp://example.com/file'), false);
    assert.equal(isSafeHttpUrl('https://user:password@example.com/'), false);
    assert.equal(isSafeHttpUrl('example.com'), false);
});

test('資料庫網址無效時回退到預設網址', () => {
    const fallback = TEACHING_MATERIALS_LINK.url;
    assert.equal(resolveHttpUrl('https://example.com/materials', fallback), 'https://example.com/materials');
    assert.equal(resolveHttpUrl('javascript:alert(1)', fallback), fallback);
    assert.equal(resolveHttpUrl('', fallback), fallback);
});
