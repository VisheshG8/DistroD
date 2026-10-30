import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as metrics from '../lib/analytics/metrics.ts';
import * as matching from '../lib/analytics/matching.ts';

const require = createRequire(import.meta.url);
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const demoExports = {};
new Script(compile('../lib/analytics/demo.ts')).runInNewContext({ exports: demoExports, require: name => name === './metrics' ? metrics : require(name) });
const historyWindow = {};
new Script(compile('../lib/analytics/history-window.ts')).runInNewContext({ exports: historyWindow, require: name => name === '../scope' ? require('../lib/scope.ts') : require(name) });
const dataset = demoExports.createDemoDataset(new Date('2026-10-25T12:00:00Z'));
const componentCode = compile('../components/analytics-dashboard.tsx');

const studioNorth = { platform: 'instagram', handle: 'demo_studio_north', url: 'https://www.instagram.com/demo_studio_north/' };
function harness({ parsePage } = {}) {
  const slots = [], downloads = [], scrolls = [];
  let cursor = 0;
  const hooks = { ...React,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useMemo(factory) { return factory(); },
    useEffect() {},
    useDeferredValue(value) { return value; },
  };
  const exports = {};
  new Script(componentCode, { filename: 'analytics-dashboard.js' }).runInNewContext({ exports, console, Blob, URLSearchParams, AbortController,
    window: { scrollTo: value => scrolls.push(value), print() {} },
    fetch() { throw new Error('The demo must never fetch a live workspace.'); },
    require(name) {
      if (name === 'react') return hooks;
      if (name === './analytics.css') return {};
      if (name === '@/lib/analytics/metrics') return metrics;
      if (name === '@/lib/analytics/matching') return matching;
      if (name === '@/lib/analytics/history-window') return historyWindow;
      if (name === '@/lib/analytics/client') return { loadAnalyticsDataset() { throw new Error('The demo must never load live data.'); } };
      if (name === '@/lib/product') return { PRODUCT_NAME: 'Distribution Desk' };
      if (name === '@/lib/pages') return { parsePage: parsePage || (() => { throw new Error('No add-page dialog is opened in these tests.'); }) };
      if (name === '@/lib/workspace-transfer') return { downloadFile: (blob, filename) => downloads.push({ blob, filename }) };
      if (name === '@/components/auth/sign-out-button') return { default: () => null };
      if (name === '@/components/workspace-dialog') return { WorkspaceDialog: ({ children }) => React.createElement('div', null, children) };
      return require(name);
    },
  });
  return { downloads, scrolls, render() {
    cursor = 0;
    return exports.default({ account: { id: 'demo', email: null, name: 'Sample workspace', userType: 'user' }, initialDataset: dataset, demo: true });
  } };
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } return null; }
  return predicate(node) ? node : find(node.props?.children, predicate);
}
function text(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text(node.props?.children) : '';
}
function click(tree, label) {
  const button = find(tree, node => node.type === 'button' && text(node).replace(/^\d+/, '') === label);
  assert.ok(button, `Button exists: ${label}`);
  button.props.onClick();
}
const byProps = (tree, props) => find(tree, node => Object.entries(props).every(([key, value]) => node.props?.[key] === value));
function labelled(tree, label) {
  const wrapper = find(tree, node => node.type === 'label' && Array.isArray(node.props.children) && node.props.children[0] === label);
  assert.ok(wrapper, `Control exists: ${label}`);
  return find(wrapper.props.children, node => node.type === 'select' || node.type === 'input');
}
const choose = (control, value) => control.props.onChange({ target: { value, checked: value } });
const pageNames = html => [...html.matchAll(/class="an-page-name"><span class="an-avatar [a-z]+">[^<]*<\/span><span><strong>([^<]+)<\/strong>/g)].map(match => match[1]);
function openPageNamed(h, name) {
  const button = find(h.render(), node => node.type === 'button' && node.props.className === 'an-page-name' && text(node).includes(name));
  assert.ok(button, `Page link exists: ${name}`); button.props.onClick();
}
function renderWithoutWarnings(tree) {
  const messages = [], priorError = console.error, priorWarn = console.warn;
  console.error = (...args) => messages.push(args.map(String).join(' '));
  console.warn = (...args) => messages.push(args.map(String).join(' '));
  let html;
  try { html = renderToStaticMarkup(tree); }
  finally { console.error = priorError; console.warn = priorWarn; }
  assert.equal(messages.length, 0, 'Actual React SSR must render without warnings: ' + (messages[0] || ''));
  assert.doesNotMatch(html, /<title>[^<]*<!--/);
  return html;
}

test('demo overview renders real SVG line-chart titles as single text strings without React warnings', () => {
  const html = renderWithoutWarnings(harness().render());
  assert.match(html, /<title>Views gained over time<\/title>/);
  assert.match(html, /<circle[^>]*><title>[^<]+: [^<]+<\/title><\/circle>/);
});

test('page detail renders the consistency chart and its post titles without React warnings', () => {
  const h = harness();
  const pageButton = find(h.render(), node => node.type === 'button' && node.props.className === 'an-page-name');
  assert.ok(pageButton); pageButton.props.onClick();
  const html = renderWithoutWarnings(h.render());
  assert.match(html, /<title>Post consistency at day seven<\/title>/);
  assert.match(html, /<title>[^<]+: [^<]+ day-seven views<\/title>/);
  assert.equal(h.scrolls.at(-1).top, 0);
});

test('economics renders page-pay scatter titles without React warnings', () => {
  const h = harness(); click(h.render(), 'Economics');
  const html = renderWithoutWarnings(h.render());
  assert.match(html, /<title>Pay versus views gained<\/title>/);
  assert.match(html, /<title>Studio North Clips: [^<]+ pay, [^<]+ views gained<\/title>/);
  assert.equal(h.scrolls.at(-1).top, 0);
});

test('header CSV downloads match monthly, posts, alerts, and selected-page views', async () => {
  const h = harness();
  click(h.render(), 'Monthly Report'); click(h.render(), 'Export CSV');
  assert.match(h.downloads.at(-1).filename, /^distribution-monthly-/);
  const monthly = await h.downloads.at(-1).blob.text();
  assert.match(monthly, /"Metric","Jun 2026","Jul 2026","Aug 2026","Sep 2026","Oct 2026 \(partial\)","Change \(fraction\)"/, 'May has no pay, views or posts yet, so it is left off');
  assert.doesNotMatch(monthly, /"2026-05"/);
  assert.match(monthly, /"Total pay INR"(,"[^"]*"){6}\r\n"Total views gained"/);
  assert.match(monthly, /"Cost per 1K views INR"/);
  click(h.render(), 'Content Tracker'); click(h.render(), 'Export CSV');
  assert.match(h.downloads.at(-1).filename, /^distribution-posts-/);
  assert.match(await h.downloads.at(-1).blob.text(), /"Caption","URL"/);
  click(h.render(), 'Economics'); click(h.render(), 'Export CSV');
  assert.match(h.downloads.at(-1).filename, /^distribution-economics-/);
  const economics = await h.downloads.at(-1).blob.text();
  for (const label of ['"Cost per 1K views INR"', '"Views per INR 1000"', '"By responsible person"', '"Month by month"', '"Total pay INR"']) assert.ok(economics.includes(label), label);
  click(h.render(), 'Attention / Alerts'); click(h.render(), 'Export CSV');
  assert.match(h.downloads.at(-1).filename, /^distribution-alerts-/);
  assert.match(await h.downloads.at(-1).blob.text(), /No post in 7 days/);
  click(h.render(), 'Command Center');
  openPageNamed(h, 'Studio North Clips');
  click(h.render(), 'Export CSV');
  assert.match(h.downloads.at(-1).filename, /^distribution-page-instagram-demo_studio_north-/);
  const csv = await h.downloads.at(-1).blob.text();
  assert.equal(csv.trim().split('\r\n').length, 2, 'A page detail export has one header and one selected page');
  assert.doesNotMatch(csv, /Everyday Edit/);
});

test('batch refreshes defer alert checks to one reconcile after the loop', () => {
  for (const file of ['../components/analytics-dashboard.tsx', '../components/distribution-dashboard.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /fetch\(["']\/api\/refresh["'][^\n]*reconcile: false/, `${file} must not reload the whole workspace history once per page`);
    assert.equal(source.match(/action: ["']reconcileAlerts["']/g)?.length, 1, `${file} reconciles alerts once per batch`);
  }
});

test('sections use the spec names and codes', () => {
  const h = harness(), html = renderWithoutWarnings(h.render());
  const nav = [...html.matchAll(/<button[^>]*><small>(\d\d)<\/small><svg[\s\S]*?<\/svg><span>([^<]+)<\/span><\/button>/g)].map(match => match[1] + ' ' + match[2]);
  assert.deepEqual(nav, ['01 Command Center', '02 Page Master', '03 Page Performance', '04 Content Tracker', '06 Page × Content', '07 Economics', '08 Monthly Report', '09 Attention / Alerts']);
});

const matrixRows = html => [...html.matchAll(/<tr><th scope="row"><div class="an-post-title"><div><strong>([^<]+)<\/strong>[\s\S]*?<\/th>([\s\S]*?)<\/tr>/g)].map(match => ({ title: match[1], cells: [...match[2].matchAll(/<td[^>]*>(?:<strong>)?([\d,]+|·|-)/g)].map(cell => cell[1]) }));
const number = value => Number(value.replace(/,/g, ''));
test('06 Page × Content shows the linked content matrix with row and page totals', async () => {
  const h = harness();
  click(h.render(), 'Page × Content');
  const html = renderWithoutWarnings(h.render()), rows = matrixRows(html);
  assert.match(html, /Content across pages/);
  assert.deepEqual(rows.map(row => row.title).sort(), ['How a street vendor prices a cup of tea', 'The five-minute habit that fixed my mornings', 'What really happens when your phone overheats', 'Why the metro beats the road at rush hour']);
  for (const row of rows) {
    const values = row.cells.slice(0, -1).filter(cell => /\d/.test(cell)).map(number);
    assert.equal(number(row.cells.at(-1)), values.reduce((a, b) => a + b, 0), `${row.title}: Total is the sum of its page cells`);
  }
  assert.match(html, /Per-page total/);
  assert.doesNotMatch(html, /#learn|#shorts/, 'Row titles drop hashtags');
  click(h.render(), 'Day-7 views');
  assert.match(renderWithoutWarnings(h.render()), /Day-7 views compare every copy at the same age/);
  click(h.render(), 'Export CSV');
  const csv = await h.downloads.at(-1).blob.text();
  assert.match(h.downloads.at(-1).filename, /^distribution-page-content-/);
  assert.match(csv, /"Content","Group","First posted","First page","Studio North Clips \(Instagram\)"/);
  assert.match(csv, /"Per-page total"/);
  assert.match(csv, /"Why the metro beats the road at rush hour","ca_demo-1"/);
});

test('06 review queue: confirm, reject and unlink change only the demo copy, never the API', () => {
  const h = harness();
  click(h.render(), 'Page × Content');
  let html = renderWithoutWarnings(h.render());
  assert.match(html, /Suggested matches/);
  assert.equal((html.match(/Confirm same content/g) || []).length, 2, 'Both unlinked reposts are suggested');
  assert.match(html, /Likely · 9\d(\.\d)?%/);
  assert.match(html, /The real reason airline food tastes different/);
  assert.equal(matrixRows(html).length, 4, 'A suggestion is not linked until it is confirmed');
  // The harness fetch throws, so each step below also proves the demo never calls the API.
  click(h.render(), 'Confirm same content');
  html = renderWithoutWarnings(h.render());
  assert.equal(matrixRows(html).length, 5);
  assert.match(html, /In the demo this changes only this browser tab/);
  assert.equal((html.match(/Confirm same content/g) || []).length, 1);
  click(h.render(), 'Not the same');
  html = renderWithoutWarnings(h.render());
  assert.doesNotMatch(html, /Confirm same content/);
  assert.match(html, /3 posts are marked as unique/);
  // A captionless post of nearly the same length (38.5 s vs 38.57 s) can join the confirmed group, but only as a possible match.
  assert.match(html, /1 possible match needs a closer look/);
  click(h.render(), 'Allow suggestions again');
  assert.equal((renderWithoutWarnings(h.render()).match(/Confirm same content/g) || []).length, 1);
  click(h.render(), 'Unlink');
  html = renderWithoutWarnings(h.render());
  assert.equal(matrixRows(html).length, 4);
  assert.equal((html.match(/Confirm same content/g) || []).length, 2, 'Unlinked posts return to the review queue');
});

test('06 explains what to do when nothing is linked or suggested', () => {
  const h = harness();
  click(h.render(), 'Page × Content');
  // Unlink every linked row; their posts then wait in the queue instead of the matrix.
  for (let index = 0; index < 4; index++) click(h.render(), 'Unlink');
  let html = renderWithoutWarnings(h.render());
  assert.match(html, /No linked content in these dates/);
  assert.match(html, /Confirm a suggested match above to add a row/);
  assert.match(html, /within 1.5 seconds and publish dates within 21 days/);
  while (/Not the same/.test(html)) { click(h.render(), 'Not the same'); html = renderWithoutWarnings(h.render()); }
  assert.match(html, /No new matches to review/);
});

test('opening the Monthly Report never loses the user’s date filters', () => {
  const h = harness();
  const presetSelect = () => find(h.render(), node => node.type === 'select' && node.props['aria-label'] === 'Date preset');
  click(h.render(), 'Monthly Report');
  assert.equal(presetSelect().props.value, '6m', 'A short default range opens the report on six months');
  click(h.render(), 'Economics');
  assert.equal(presetSelect().props.value, '30d', 'Leaving the report restores the earlier preset');
  choose(presetSelect(), '90d');
  click(h.render(), 'Monthly Report');
  assert.equal(presetSelect().props.value, '90d', 'A range the user chose is kept');
  click(h.render(), 'Command Center');
  assert.equal(presetSelect().props.value, '90d');
  choose(presetSelect(), '7d'); click(h.render(), 'Monthly Report'); choose(presetSelect(), 'last-month'); click(h.render(), 'Command Center');
  assert.equal(presetSelect().props.value, 'last-month', 'Dates changed inside the report are not reverted');
});

test('Command Center shows today’s attention list, grouped KPIs, freshness, and worst-first health', () => {
  const h = harness(), html = renderWithoutWarnings(h.render());
  assert.match(html, /Needs attention today/);
  assert.match(html, /pages need your attention today/);
  assert.match(html, /class="an-today-list"/);
  assert.match(html, /No post in \d+ days/);
  assert.match(html, /See all \d+/);
  assert.match(html, /Data refreshed/);
  const reach = html.indexOf('Reach &amp; output'), money = html.indexOf('>Money<');
  assert.ok(reach > 0 && money > reach);
  for (const label of ['Total active pages', 'Total views', 'Content published', 'Avg / typical views per content', 'Total followers', 'Follower growth', 'Best page', 'Best content']) assert.ok(html.indexOf('<span>' + label + '</span>') > reach && html.indexOf('<span>' + label + '</span>') < money, label);
  for (const label of ['Total monthly page pay', 'Cost per 1M views', 'Views per ₹1,000']) assert.ok(html.indexOf('<span>' + label + '</span>') > money, label);
  assert.match(html, /IG [\d.,]+[KLC]? · TT [\d.,]+[KLC]? · YT [\d.,]+[KLC]?/, 'Mixed platforms show typical views per platform');
  const healthStart = html.indexOf('class="an-health-list"'), scores = [...html.slice(healthStart).matchAll(/class="an-health (good|watch|low|pending)"[^>]*>(\d+)\/100 · (Healthy|Watch|At risk)/g)];
  assert.ok(scores.length > 1);
  scores.forEach(([, band, score, label]) => { assert.equal(band, metrics.healthBand(Number(score))); assert.equal(label, { good: 'Healthy', watch: 'Watch', low: 'At risk' }[band]); });
  const values = scores.map(match => Number(match[2]));
  assert.deepEqual(values, [...values].sort((a, b) => a - b), 'Lowest health first');
});

test('Page Master toggles status, sorts, filters, totals, and warns about duplicates with a prefilled start date', () => {
  const h = harness({ parsePage: () => studioNorth });
  click(h.render(), 'Page Master');
  let tree = h.render(), html = renderWithoutWarnings(tree);
  const toggle = find(tree, node => node.props?.role === 'switch');
  assert.ok(toggle); assert.equal(typeof toggle.props['aria-checked'], 'boolean');
  assert.match(html, /role="switch" aria-checked="false"[^>]*>.*?Inactive/);
  assert.match(html, /Paid through/);
  assert.match(html, /<tfoot>.*7 pages.*6 active · 1 inactive.*Monthly pay, active pages/);
  assert.match(html, /₹1,13,000<small>Monthly pay, active pages/);
  find(tree, node => node.props?.id === 'pay' && typeof node.props.onSort === 'function').props.onSort({ key: 'pay', dir: 'desc' });
  assert.equal(pageNames(renderWithoutWarnings(h.render()))[0], 'Loop Lab');
  choose(labelled(h.render(), 'Show'), 'inactive');
  assert.deepEqual(pageNames(renderWithoutWarnings(h.render())), ['Campus Notes']);
  find(h.render(), node => node.props?.role === 'switch').props.onClick(); // The harness fetch throws, so this also proves the demo stays local.
  assert.match(renderWithoutWarnings(h.render()), /Campus Notes is active again\. In the demo this changes only this browser tab\./);
  choose(labelled(h.render(), 'Show'), 'active');
  assert.ok(pageNames(renderWithoutWarnings(h.render())).includes('Campus Notes'), 'The demo switch reactivates the page in this tab');
  choose(labelled(h.render(), 'Show'), 'all');
  click(h.render(), 'Add page');
  tree = h.render();
  assert.equal(labelled(tree, 'Start date (pay counted from)').props.value, metrics.indiaDay());
  assert.equal(labelled(tree, 'Display name').props.value, '');
  find(tree, node => node.type === 'input' && node.props.placeholder?.startsWith('instagram.com')).props.onChange({ target: { value: '@demo_studio_north' } });
  tree = h.render(); html = renderWithoutWarnings(tree);
  assert.match(html, /Already in your page master: Studio North Clips/);
  click(tree, 'Edit instead');
  tree = h.render();
  assert.ok(find(tree, node => node.props?.title === 'Edit Studio North Clips'), 'Edit instead opens the saved page');
  assert.equal(labelled(tree, 'Monthly pay (₹)').props.value, '18000');
});

test('Page Performance shows the new comparison columns, sortable headers, and shared health bands', () => {
  const h = harness(); click(h.render(), 'Page Performance');
  const tree = h.render(), html = renderWithoutWarnings(tree);
  for (const label of ['Distribution score', 'Avg views / post', 'Highest content', 'Lowest content', 'Consistency', 'Saves', 'Cost / 1M views', 'Views / ₹1,000']) assert.match(html, new RegExp('aria-sort="[a-z]+"[^>]*><button[^>]*>' + label.replace(/[/₹]/g, '.')), label);
  assert.match(html, /<strong>#1<\/strong>/);
  assert.match(html, /Steady|Variable|Erratic/);
  assert.doesNotMatch(html, /at least eight/);
  const youtube = () => pageNames(renderWithoutWarnings(h.render())).filter(name => ['Loop Lab', 'Minute Science'].includes(name));
  find(tree, node => node.props?.id === 'name' && typeof node.props.onSort === 'function').props.onSort({ key: 'name', dir: 'desc' });
  assert.deepEqual(youtube(), ['Minute Science', 'Loop Lab']);
  find(h.render(), node => node.props?.id === 'name' && typeof node.props.onSort === 'function').props.onSort({ key: 'name', dir: 'asc' });
  assert.deepEqual(youtube(), ['Loop Lab', 'Minute Science']);
});

test('Content Tracker shows editor and type, best and worst panels, filters, and sorts across platforms', () => {
  const h = harness(); click(h.render(), 'Content Tracker');
  let html = renderWithoutWarnings(h.render());
  assert.match(html, /<th>Type<\/th><th>Editor<\/th>/);
  assert.match(html, /Top performing content/); assert.match(html, /Lowest performing content/);
  assert.match(html, /Highest follower-gaining<\/span><small[^>]*>Public data does not attribute follower gains/);
  assert.match(html, /Lowest vs page baseline/);
  choose(labelled(h.render(), 'Editor'), 'Kabir');
  html = renderWithoutWarnings(h.render());
  const editors = [...html.matchAll(/<\/td><td>(?:Reel|Short|Video|Post|Carousel|Unknown type)<\/td><td>([^<]+)<\/td>/g)].map(match => match[1]);
  assert.ok(editors.length > 0); assert.ok(editors.every(name => name === 'Kabir'), editors.join());
  const order = labelled(h.render(), 'Order by');
  assert.equal(find(order.props.children, node => node.type === 'option' && node.props.value === 'views')?.props.disabled, undefined, 'Sorting stays available in All platforms');
  choose(order, 'views');
  html = renderWithoutWarnings(h.render());
  assert.match(html, /Raw counts mix platforms/);
  choose(labelled(h.render(), 'Type'), 'Short');
  html = renderWithoutWarnings(h.render());
  const types = [...html.matchAll(/<\/small><\/td><td>([A-Za-z ]+)<\/td><td>Kabir<\/td>/g)].map(match => match[1]);
  assert.ok(types.length > 0 && types.every(type => type === 'Short'), types.join());
});

test('Economics and Monthly Report show metrics as rows with month columns and a Change column', () => {
  const h = harness(); click(h.render(), 'Economics');
  let html = renderWithoutWarnings(h.render());
  assert.match(html, /<th>Metric<\/th><th>Sep 2026<small>Partial month<\/small><\/th><th>Oct 2026<small>Month to date<\/small><\/th><th>Change<small>vs same days of Sep 2026<\/small><\/th>/);
  for (const label of ['Total pay', 'Total views', 'Total posts', 'Cost / 1K views', 'Avg views / post']) assert.match(html, new RegExp('<th scope="row">' + label.replace('/', '\\/') + '</th>'), label);
  assert.match(html, /<span>Cost per 1K views<\/span>/);
  assert.match(html, /By responsible person/);
  click(h.render(), 'Monthly Report');
  html = renderWithoutWarnings(h.render());
  assert.match(html, /<th>Jul 2026<\/th><th>Aug 2026<\/th><th>Sep 2026<\/th><th>Oct 2026<small>Month to date<\/small><\/th>/);
  assert.match(html, /Oct 2026 so far against the same days of Sep 2026: pay/);
});

test('page detail lists that page’s open alerts with their numbers', () => {
  const h = harness();
  const alert = dataset.alerts.find(item => !item.resolvedAt && item.type === 'no-posts');
  assert.ok(alert, 'The demo has a quiet page');
  const page = dataset.pages.find(item => item.id === alert.pageId);
  click(h.render(), 'Page Master'); openPageNamed(h, page.name);
  const html = renderWithoutWarnings(h.render());
  assert.match(html, /Needs attention on this page/);
  assert.ok(html.includes(alert.title)); assert.match(alert.details, /\d/);
  assert.match(html, /Health needs at least five posts measured at day 7/);
});


test('review fixes: content filters stay out of page detail, rollup cost counts paid pages without views, page CSV follows the Show filter', async () => {
  const h = harness(); click(h.render(), 'Content Tracker');
  choose(labelled(h.render(), 'Editor'), 'Kabir');
  click(h.render(), 'Command Center'); openPageNamed(h, 'Studio North Clips');
  const html = renderWithoutWarnings(h.render());
  assert.doesNotMatch(html, /No posts in these dates/, 'A hidden editor filter must not empty another editor’s page');
  click(h.render(), 'Economics'); click(h.render(), 'Export CSV');
  const rows = (await h.downloads.at(-1).blob.text()).replace(/^﻿/, '').split('\r\n').map(line => line ? line.slice(1, -1).split('","') : []);
  const header = rows[0], pages = rows.slice(1, rows.findIndex(row => row[0] === 'All filtered pages')), at = name => header.indexOf(name);
  const rollup = rows.slice(rows.findIndex(row => row[0] === 'Editor') + 1, rows.findIndex((row, index) => index > 0 && row[0] === 'Month by month') - 1);
  assert.ok(rollup.length > 0);
  for (const row of rollup) {
    const own = pages.filter(page => (page[at('Editor')] || 'Unassigned') === row[0]), paid = own.filter(page => page[at('Pay for range INR')] !== '' && page[at('Views gained')] !== '' && (Number(page[at('Pay for range INR')]) > 0 || page[at('Active')] === 'Yes' && page[at('Monthly pay INR')] === '0'));
    const views = paid.reduce((n, page) => n + Number(page[at('Views gained')]), 0), pay = paid.reduce((n, page) => n + Number(page[at('Pay for range INR')]), 0);
    if (views > 0) assert.ok(Math.abs(Number(row[7]) - pay / views * 1_000_000) < 0.01, row[0]); else assert.equal(row[7], '');
  }
  click(h.render(), 'Page Master'); choose(labelled(h.render(), 'Show'), 'inactive'); click(h.render(), 'Export CSV');
  const csv = await h.downloads.at(-1).blob.text();
  assert.equal(csv.trim().split('\r\n').length, 2); assert.match(csv, /Campus Notes/);
});
