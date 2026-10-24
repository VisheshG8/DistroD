import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePage } from '../lib/pages.ts';

test('URLs infer their platform and canonicalize query, case, tabs, and trailing slashes', () => {
  const instagram = { platform: 'instagram', handle: 'creator.name', url: 'https://www.instagram.com/creator.name/' };
  for (const value of [' @Creator.Name ', 'https://www.instagram.com/Creator.Name/?igsh=tracking', 'INSTAGRAM.COM/Creator.Name/reels/', 'https://m.instagram.com/Creator.Name/tagged']) {
    assert.deepEqual(parsePage(value), instagram);
  }
  assert.deepEqual(parsePage('https://www.tiktok.com/@Some_Creator?lang=en', 'youtube'), {
    platform: 'tiktok', handle: 'some_creator', url: 'https://www.tiktok.com/@some_creator',
  });
  for (const value of ['youtube.com/@Creator/shorts', 'https://m.youtube.com/@Creator/videos/', 'https://youtube.com/@Creator/featured']) {
    assert.deepEqual(parsePage(value), { platform: 'youtube', handle: 'creator', url: 'https://www.youtube.com/@creator' });
  }
});

test('bare handles use the selected platform; native YouTube channel IDs keep their case', () => {
  assert.equal(parsePage('@Creator', 'tiktok').platform, 'tiktok');
  assert.equal(parsePage('@Creator', 'youtube').url, 'https://www.youtube.com/@creator');
  const id = 'UCAbCdEfGhIjKlMnOpQrStUv';
  for (const value of [id, `https://youtube.com/channel/${id}`, `https://youtube.com/channel/${id}/videos`]) {
    assert.deepEqual(parsePage(value, 'youtube'), { platform: 'youtube', handle: id, url: `https://www.youtube.com/channel/${id}` });
  }
});

test('content links, arbitrary URLs, malformed encodings and unsupported profile forms are rejected', () => {
  const invalid = [
    '', '   ', 'with space', 'https://example.com/creator', 'https://instagram.com.evil.test/creator',
    'https://instagram.com@evil.test/creator', 'https://instagram.com/p/abc', 'instagram.com/reel/abc',
    'https://tiktok.com/@creator/video/123', 'https://tiktok.com/creator', 'https://youtube.com/watch?v=abc',
    'https://youtube.com/shorts/abc', 'https://youtube.com/channel/not-a-channel', 'https://instagram.com/%ZZ',
    'https://instagram.com/creator%2Fother', 'javascript:alert(1)', 'file:///C:/secret', 'a'.repeat(301),
  ];
  for (const value of invalid) assert.throws(() => parsePage(value), undefined, value);
});
