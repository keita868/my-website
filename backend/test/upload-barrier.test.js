import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUploadBarrier } from '../test-support/upload-barrier.js';

test('releasing before the upload cancels the barrier and it can be armed again', async () => {
  const notifications = [];
  const barrier = createUploadBarrier((message) => notifications.push(message));
  barrier.handleMessage('arm-upload-barrier');
  barrier.handleMessage('release-upload-barrier');
  assert.equal(barrier.pause(), undefined);
  assert.deepEqual(notifications, ['upload-barrier-armed']);
  barrier.handleMessage('arm-upload-barrier');
  const paused = barrier.pause();
  assert.ok(paused instanceof Promise);
  barrier.handleMessage('release-upload-barrier');
  await paused;
  assert.equal(barrier.pause(), undefined);
});

test('arming while armed or paused is rejected without losing the paused upload', async () => {
  const notifications = [];
  const barrier = createUploadBarrier((message) => notifications.push(message));
  barrier.handleMessage('arm-upload-barrier');
  barrier.handleMessage('arm-upload-barrier');
  const paused = barrier.pause();
  barrier.handleMessage('arm-upload-barrier');
  assert.equal(barrier.pause(), undefined);
  assert.deepEqual(notifications, [
    'upload-barrier-armed', 'upload-barrier-error', 'upload-barrier-paused', 'upload-barrier-error'
  ]);
  barrier.handleMessage('release-upload-barrier');
  // Re-arming before the old continuation runs must not erase the new resolver.
  barrier.handleMessage('arm-upload-barrier');
  const next = barrier.pause();
  await paused;
  barrier.handleMessage('release-upload-barrier');
  await next;
  assert.equal(barrier.pause(), undefined);
});
