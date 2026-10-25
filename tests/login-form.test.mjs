import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { authCallbackUrl } from '../lib/auth-urls.ts';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../components/auth/login-form.tsx', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function harness({ props = {}, response = { error: null }, send } = {}) {
  const slots = [], requests = [], redirects = [];
  let cursor = 0;
  const hooks = { ...React, useState(initial) {
    const index = cursor++; if (!(index in slots)) slots[index] = initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  } };
  const exports = {};
  new Script(code, { filename: 'login-form.js' }).runInNewContext({ exports,
    window: { location: { assign: url => redirects.push(url) } },
    require(name) {
      if (name === 'react') return hooks;
      if (name === '@/lib/auth-urls') return { authCallbackUrl };
      if (name === '@/lib/supabase/client') return { createClient: () => ({ auth: {
        async signInWithOtp(value) { requests.push({ method: 'otp', value }); return send ? send(value) : response; },
        async signInWithPassword(value) { requests.push({ method: 'password', value }); return response; },
        async signUp(value) { requests.push({ method: 'signup', value }); return { data: { session: null }, ...response }; },
      } }) };
      return require(name);
    },
  });
  const render = () => { cursor = 0; return exports.default({ next: '/dashboard', appOrigin: 'https://desk.example.com', configurationError: '', googleEnabled: false, initialMode: 'signin', ...props }); };
  return { render, requests, redirects };
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const child of node) { const match = find(child, predicate); if (match) return match; } return null; }
  return predicate(node) ? node : find(node.props?.children, predicate);
}
function button(tree, label) {
  const match = find(tree, node => node.type === 'button' && renderToStaticMarkup(node).includes(label));
  assert.ok(match, `Button exists: ${label}`); return match;
}
function setEmail(h, email = 'person@example.com') {
  const input = find(h.render(), node => node.type === 'input' && node.props.type === 'email');
  input.props.onChange({ target: { value: email } });
}
function submit(h) { return find(h.render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} }); }

test('email-link mode sends only an existing-user request with a safe callback and no password', async () => {
  const h = harness({ props: { next: '//outside.example' } });
  button(h.render(), 'Email me a sign-in link').props.onClick();
  const linkForm = renderToStaticMarkup(h.render());
  assert.match(linkForm, /Email a sign-in link/); assert.doesNotMatch(linkForm, /type="password"/);
  setEmail(h, ' person@example.com '); await submit(h);
  assert.equal(h.requests.length, 1); const request = h.requests[0];
  assert.equal(request.method, 'otp'); assert.equal(request.value.email, 'person@example.com');
  assert.equal(request.value.options.shouldCreateUser, false);
  const callback = new URL(request.value.options.emailRedirectTo);
  assert.equal(callback.origin, 'https://desk.example.com'); assert.equal(callback.pathname, '/auth/callback');
  assert.equal(callback.searchParams.get('next'), '/dashboard');
  assert.equal('password' in request.value, false); assert.equal(h.redirects.length, 0);
  const complete = renderToStaticMarkup(h.render());
  assert.match(complete, /role="status"/); assert.match(complete, /Open the link in this browser/);
  assert.doesNotMatch(complete, /admin|user type|choose.*role/i);
});

test('email-link errors explain rate limits and allow retry without pretending an email was sent', async () => {
  const h = harness({ response: { error: { code: 'over_email_send_rate_limit', message: 'internal vendor response' } } });
  button(h.render(), 'Email me a sign-in link').props.onClick(); setEmail(h); await submit(h);
  const html = renderToStaticMarkup(h.render());
  assert.match(html, /Too many attempts/); assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /internal vendor response|on its way/);
  assert.equal(button(h.render(), 'Send sign-in link').props.disabled, false);
});

test('sending a link disables duplicate submissions until the request finishes', async () => {
  let finish;
  const h = harness({ send: () => new Promise(resolve => { finish = resolve; }) });
  button(h.render(), 'Email me a sign-in link').props.onClick(); setEmail(h);
  const pending = submit(h);
  assert.equal(button(h.render(), 'Send sign-in link').props.disabled, true);
  await submit(h); assert.equal(h.requests.length, 1);
  finish({ error: null }); await pending;
  assert.equal(button(h.render(), 'Send sign-in link').props.disabled, false);
});

test('switching back to password sign-in preserves the email and uses the original login flow', async () => {
  const h = harness(); button(h.render(), 'Email me a sign-in link').props.onClick(); setEmail(h);
  button(h.render(), 'Sign in with a password').props.onClick();
  const tree = h.render(); const password = find(tree, node => node.type === 'input' && node.props.type === 'password');
  assert.ok(password); password.props.onChange({ target: { value: 'correct-password' } });
  await submit(h);
  assert.equal(h.requests[0].method, 'password'); assert.equal(h.requests[0].value.email, 'person@example.com');
  assert.equal(h.requests[0].value.password, 'correct-password'); assert.deepEqual(h.redirects, ['/dashboard']);
});

test('missing auth configuration prevents requests and callback errors stay readable', async () => {
  const h = harness({ props: { configurationError: 'Sign-in is not configured.', appOrigin: null, initialError: 'callback' } });
  assert.equal(button(h.render(), 'Email me a sign-in link').props.disabled, true);
  await submit(h); assert.equal(h.requests.length, 0);
  const html = renderToStaticMarkup(h.render()); assert.match(html, /link may have expired/); assert.match(html, /Sign-in is not configured/);
});
