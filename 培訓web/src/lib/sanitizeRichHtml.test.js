import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedEmbedUrl, isAllowedRichUrl } from './sanitizeRichHtml.js';

test('rich text URLs reject executable and inline-data schemes', () => {
  assert.equal(isAllowedRichUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedRichUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isAllowedRichUrl('vbscript:msgbox(1)'), false);
});

test('rich text URLs preserve ordinary links and hosted images', () => {
  assert.equal(isAllowedRichUrl('/announcements/123'), true);
  assert.equal(isAllowedRichUrl('https://example.com/image.png', 'image'), true);
  assert.equal(isAllowedRichUrl('data:image/png;base64,iVBORw0KGgo=', 'image'), true);
  assert.equal(isAllowedRichUrl('data:image/svg+xml;base64,PHN2Zz4=', 'image'), false);
  assert.equal(isAllowedRichUrl('data:text/html;base64,PHNjcmlwdD4=', 'image'), false);
  assert.equal(isAllowedRichUrl('mailto:teacher@example.com'), true);
  assert.equal(isAllowedRichUrl('mailto:teacher@example.com', 'image'), false);
});

test('embedded media is limited to HTTPS YouTube embed URLs', () => {
  assert.equal(isAllowedEmbedUrl('https://www.youtube.com/embed/abc123'), true);
  assert.equal(isAllowedEmbedUrl('https://www.youtube-nocookie.com/embed/abc123'), true);
  assert.equal(isAllowedEmbedUrl('https://www.youtube.com/watch?v=abc123'), false);
  assert.equal(isAllowedEmbedUrl('https://evil.example/embed/abc123'), false);
});
