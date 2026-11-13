import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { after, test } from 'node:test';

const directory = mkdtempSync(path.join(os.tmpdir(), 'cms-session-store-test-'));
process.env.CMS_DATA_DIR = directory;
const { sessionStore } = await import('../src/session-store.js');
const db = new Database(path.join(directory, 'sessions.sqlite'));
after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
const hour = 60 * 60 * 1000;
function value(now = Date.now()) {
  return { adminId: 1, authenticatedAt: now, cookie: { expires: new Date(now + 9 * hour).toISOString() } };
}
function call(method, ...args) {
  return new Promise((resolve, reject) => sessionStore[method](...args, (error, result) => error ? reject(error) : resolve(result)));
}

test('set and touch independently cannot restore destroyed sessions, even after reload', async () => {
  for (const method of ['set', 'touch']) {
    const sid = `logged-out-${method}`;
    await call('set', sid, value());
    const stale = await call('get', sid);
    assert.ok(stale);
    await call('destroy', sid);
    await call(method, sid, stale);
    assert.equal(await call('get', sid), null);
  }
  const { sessionStore: reloaded } = await import('../src/session-store.js?reload');
  await new Promise((resolve, reject) => reloaded.set('logged-out-set', value(), (error) => error ? reject(error) : resolve()));
  assert.equal(reloaded.isActive('logged-out-set'), false);
});

test('touch clamps an existing session to its absolute expiry before and after the boundary', async (t) => {
  const started = Date.now();
  let now = started;
  t.mock.method(Date, 'now', () => now);
  const stale = value(started);
  await call('set', 'touch-boundary', stale);
  assert.ok(await call('get', 'touch-boundary'));
  now += 8 * hour - 1000;
  await call('touch', 'touch-boundary', stale);
  assert.equal(db.prepare('SELECT expired FROM sessions WHERE sid = ?').get('touch-boundary').expired, started + 8 * hour);
  now += 2000;
  await call('touch', 'touch-boundary', stale);
  assert.equal(await call('get', 'touch-boundary'), null);
  assert.equal(sessionStore.isActive('touch-boundary'), false);
});

test('expired and legacy authentication cannot be saved, even after revocations are pruned', async (t) => {
  const started = Date.now();
  let now = started;
  t.mock.method(Date, 'now', () => now);
  const stale = value(started);
  await call('set', 'pruned', stale);
  await call('destroy', 'pruned');
  now += 25 * hour;
  db.prepare('DELETE FROM revoked_sessions WHERE expired < ?').run(now);
  stale.cookie.expires = new Date(now + hour).toISOString();
  await call('set', 'pruned', stale);
  assert.equal(await call('get', 'pruned'), null);
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE sid = ?').get('pruned'), undefined);
  await call('set', 'legacy', { ...stale, authenticatedAt: undefined });
  assert.equal(await call('get', 'legacy'), null);
});

test('consumer callback exceptions propagate without a second callback for every store operation', () => {
  for (const method of ['get', 'set', 'touch', 'destroy']) {
    let calls = 0;
    const sentinel = new Error(`consumer-${method}`);
    const callback = () => { calls++; throw sentinel; };
    assert.throws(() => {
      if (method === 'set' || method === 'touch') sessionStore[method]('callback', value(), callback);
      else sessionStore[method]('callback', callback);
    }, (error) => error === sentinel);
    assert.equal(calls, 1);
  }
});
