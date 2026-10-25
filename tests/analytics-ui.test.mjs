import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as metrics from '../lib/analytics/metrics.ts';

const require = createRequire(import.meta.url);
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const demoExports = {};
new Script(compile('../lib/analytics/demo.ts')).runInNewContext({ exports: demoExports, require: name => name === './metrics' ? metrics : require(name) });
const dataset = demoExports.createDemoDataset(new Date('2026-10-25T12:00:00Z'));
const componentCode = compile('../components/analytics-dashboard.tsx');

function harness() {
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
  };
  const exports = {};
  new Script(componentCode, { filename: 'analytics-dashboard.js' }).runInNewContext({ exports, console, Blob, URLSearchParams, AbortController,
    window: { scrollTo: value => scrolls.push(value), print() {} },
    fetch() { throw new Error('The demo must never fetch a live workspace.'); },
    require(name) {
      if (name === 'react') return hooks;
      if (name === './analytics.css') return {};
      if (name === '@/lib/analytics/metrics') return metrics;
      if (name === '@/lib/analytics/client') return { loadAnalyticsDataset() { throw new Error('The demo must never load live data.'); } };
      if (name === '@/lib/product') return { PRODUCT_NAME: 'Distribution Desk' };
      if (name === '@/lib/pages') return { parsePage() { throw new Error('No add-page dialog is opened in these tests.'); } };
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
  click(h.render(), 'Monthly report'); click(h.render(), 'Export CSV');
  assert.match(h.downloads.at(-1).filename, /^distribution-monthly-/);
  assert.match(await h.downloads.at(-1).blob.text(), /Period comparison/);
  click(h.render(), 'Posts'); click(h.render(), 'Export CSV');
  assert.match(h.downloads.at(-1).filename, /^distribution-posts-/);
  assert.match(await h.downloads.at(-1).blob.text(), /"Caption","URL"/);
  click(h.render(), 'Alerts'); click(h.render(), 'Export CSV');
  assert.match(h.downloads.at(-1).filename, /^distribution-alerts-/);
  assert.match(await h.downloads.at(-1).blob.text(), /Typical views need a closer look/);
  click(h.render(), 'Overview');
  find(h.render(), node => node.type === 'button' && node.props.className === 'an-page-name').props.onClick();
  click(h.render(), 'Export CSV');
  assert.match(h.downloads.at(-1).filename, /^distribution-page-instagram-demo_studio_north-/);
  const csv = await h.downloads.at(-1).blob.text();
  assert.equal(csv.trim().split('\r\n').length, 2, 'A page detail export has one header and one selected page');
  assert.doesNotMatch(csv, /Everyday Edit/);
});
