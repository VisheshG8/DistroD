import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
import * as metrics from '../lib/analytics/metrics.ts';

const source = ts.transpileModule(readFileSync(new URL('../lib/analytics/demo.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const demo = {};
new Script(source).runInNewContext({ exports: demo, require: name => { if (name === './metrics') return metrics; throw new Error('Unexpected demo import: ' + name); } });
const now = new Date('2026-10-29T06:00:00Z');
const dataset = demo.createDemoDataset(now);
const posts = dataset.pages.flatMap(page => page.posts.map(post => ({ ...post, page })));

test('the demo is deterministic for a given date', () => {
  assert.deepEqual(demo.createDemoDataset(new Date(now)), dataset);
  assert.notDeepEqual(demo.createDemoDataset(new Date('2026-10-30T06:00:00Z')).generatedAt, dataset.generatedAt);
});

test('demo alerts are exactly the engine output, including red, amber and green levels', () => {
  const candidates = metrics.alertCandidates(dataset, now);
  assert.deepEqual(dataset.alerts.map(({ pageId, level, type, title, details }) => ({ pageId, level, type, title, details })),
    candidates.map(({ pageId, level, type, title, details }) => ({ pageId, level, type, title, details })));
  assert.deepEqual(new Set(dataset.alerts.map(alert => alert.level)), new Set(['red', 'amber', 'green']));
  for (const type of ['no-posts', 'median-drop', 'engagement-drop', 'follower-loss', 'viral-post']) assert.ok(dataset.alerts.some(alert => alert.type === type), type);
  assert.equal(new Set(dataset.alerts.map(alert => alert.id)).size, dataset.alerts.length);
  // Inactive pages are never alerted on.
  assert.ok(dataset.alerts.every(alert => dataset.pages.find(page => page.id === alert.pageId).active));
});

test('public-data limits hold: only TikTok has shares and saves, carousel views stay unavailable on Instagram', () => {
  assert.ok(posts.some(post => post.platform === 'tiktok' && post.saves > 0 && post.shares > 0));
  assert.ok(posts.filter(post => post.platform !== 'tiktok').every(post => post.saves === null && post.shares === null));
  assert.ok(dataset.postSnapshots.filter(s => s.pageId === 'demo-page-5').every(s => Number.isInteger(s.saves)));
  const carousels = posts.filter(post => post.platform === 'instagram' && post.type === 'carousel');
  assert.ok(carousels.length > 0 && carousels.every(post => post.views === null && post.durationSeconds === null));
});

test('content types, editors, fractional durations and an inactive page are all represented', () => {
  const labels = new Set(posts.map(post => metrics.contentTypeLabel(post.platform, post.type, post.durationSeconds)));
  for (const label of ['Reel', 'Short', 'Video', 'Carousel', 'Unknown type']) assert.ok(labels.has(label), label);
  assert.ok(posts.every(post => [null, 'reel', 'short', 'video', 'carousel'].includes(post.type)));
  assert.ok(posts.some(post => post.durationSeconds !== null && !Number.isInteger(post.durationSeconds)));
  assert.ok(dataset.pages.every(page => page.editor));
  assert.ok(new Set(dataset.pages.map(page => page.editor)).size < dataset.pages.length, 'An editor manages more than one page');
  const inactive = dataset.pages.filter(page => !page.active);
  assert.equal(inactive.length, 1);
  assert.match(inactive[0].endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(inactive[0].posts.every(post => post.publishedAt <= dataset.pages.find(page => page.id === inactive[0].id).lastSyncedAt));
  assert.ok(dataset.pages.some(page => page.alertQuietDays === 3));
});

test('monthly pay changes month over month across at least three months', () => {
  const analysis = metrics.calculateWorkspace(dataset, { from: '2026-07-01', to: '2026-10-28' }, null, now);
  assert.ok(analysis.monthly.length >= 4);
  const changes = analysis.monthly.map(row => row.change?.metrics.pay.percent).filter(value => typeof value === 'number' && value !== 0);
  assert.ok(changes.length >= 3, 'Pay changes in each later month');
  assert.ok(changes.some(value => value > 0) && changes.some(value => value < 0));
});

test('the same content is posted on several pages, partly pre-linked and partly left for review', () => {
  const groups = Map.groupBy(posts.filter(post => post.sourceAssetId), post => post.sourceAssetId);
  assert.ok(groups.size >= 4);
  for (const [asset, members] of groups) {
    assert.match(asset, /^ca_demo-\d+$/);
    assert.ok(members.length >= 3 && members.length <= 4);
    assert.equal(new Set(members.map(post => post.pageId)).size, members.length, 'One post per page');
    const durations = members.map(post => post.durationSeconds), times = members.map(post => Date.parse(post.publishedAt));
    assert.ok(Math.max(...durations) - Math.min(...durations) < .2);
    assert.ok(Math.max(...times) - Math.min(...times) < 4 * 86400000);
    assert.ok(members.every(post => post.views > 0));
  }
  const core = title => title.toLowerCase().replace(/#\w+|\nfollow for more|[^\p{L}\p{N} ]/gu, '').trim();
  const unlinked = Map.groupBy(posts.filter(post => !post.sourceAssetId), post => core(post.title));
  const candidates = [...unlinked.values()].filter(members => new Set(members.map(post => post.pageId)).size >= 3 && members.length <= 4);
  assert.ok(candidates.length >= 2, 'Unlinked reposts remain for the automatic-match queue');
  // A shared audio ID is only a hint, so it must never tie an unrelated post to a group.
  const metro = posts.filter(post => post.audioId === 'demo-audio-metro');
  assert.ok(metro.length > 0 && metro.every(post => post.sourceAssetId === 'ca_demo-1'));
  for (const post of posts.filter(post => post.audioId && post.sourceAssetId === null)) assert.equal(posts.filter(other => other.audioId === post.audioId).length, 1, post.id);
});
