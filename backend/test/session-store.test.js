import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'cms-session-store-test-'));
process.env.CMS_DATA_DIR = directory;
const { sessionStore } = await import('../src/session-store.js');
after(() => rmSync(directory, { recursive: true, force: true }));

function call(method, ...args) {
  return new Promise((resolve, reject) => {
    sessionStore[method](...args, (error, value) => error ? reject(error) : resolve(value));
  });
}

test('a stale request cannot restore a destroyed session, including after store reload', async () => {
  const value = {
    adminId: 1, authenticatedAt: Date.now(),
    cookie: { expires: new Date(Date.now() + 30 * 60 * 1000).toISOString() }
  };
  await call('set', 'logged-out', value);
  assert.equal(sessionStore.isActive('logged-out'), true);
  const stale = await call('get', 'logged-out');
  await call('destroy', 'logged-out');
  await call('set', 'logged-out', stale);
  await call('touch', 'logged-out', stale);
  assert.equal(await call('get', 'logged-out'), null);
  const { sessionStore: reloaded } = await import('../src/session-store.js?reload');
  await new Promise((resolve, reject) => reloaded.set('logged-out', stale, (error) => error ? reject(error) : resolve()));
  assert.equal(reloaded.isActive('logged-out'), false);
});

test('saving or touching an old authenticated session cannot extend its absolute expiry', async () => {
  const expired = {
    adminId: 1, authenticatedAt: Date.now() - 8 * 60 * 60 * 1000 - 1000,
    cookie: { expires: new Date(Date.now() + 30 * 60 * 1000).toISOString() }
  };
  await call('set', 'expired', expired);
  await call('touch', 'expired', expired);
  assert.equal(await call('get', 'expired'), null);
  assert.equal(sessionStore.isActive('expired'), false);
  await call('set', 'legacy', { ...expired, authenticatedAt: undefined });
  assert.equal(await call('get', 'legacy'), null);
});
