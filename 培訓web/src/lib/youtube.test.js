import test from 'node:test';
import assert from 'node:assert/strict';
import { toYouTubeEmbedUrl } from './youtube.js';

test('converts ordinary YouTube video URLs without changing existing behavior', () => {
  assert.equal(
    toYouTubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
  );
  assert.equal(
    toYouTubeEmbedUrl('https://youtu.be/dQw4w9WgXcQ?si=share-token'),
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
  );
  assert.equal(
    toYouTubeEmbedUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'),
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
  );
});

test('converts a YouTube playlist page to the videoseries embed URL', () => {
  assert.equal(
    toYouTubeEmbedUrl('https://youtube.com/playlist?list=PL3LUAZG7SV_xB0z6jPB1bYa3n04sXU7pA&si=u0TtLjc-_l040Z6W'),
    'https://www.youtube.com/embed/videoseries?list=PL3LUAZG7SV_xB0z6jPB1bYa3n04sXU7pA',
  );
});

test('keeps playlist context when the shared URL points to one video in the list', () => {
  assert.equal(
    toYouTubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123_example&index=4'),
    'https://www.youtube.com/embed/dQw4w9WgXcQ?list=PL123_example&index=4',
  );
  assert.equal(
    toYouTubeEmbedUrl('https://youtu.be/dQw4w9WgXcQ?list=PL123_example'),
    'https://www.youtube.com/embed/dQw4w9WgXcQ?list=PL123_example',
  );
});

test('preserves existing embed URLs and unsupported input', () => {
  assert.equal(
    toYouTubeEmbedUrl('https://www.youtube.com/embed/videoseries?list=PL123_example'),
    'https://www.youtube.com/embed/videoseries?list=PL123_example',
  );
  assert.equal(toYouTubeEmbedUrl('not-a-url'), 'not-a-url');
  assert.equal(toYouTubeEmbedUrl(''), '');
});
