// Loaded only by the integration-test server. Pause file validation after the
// route has read the revision, so tests can deterministically interleave a save.
import fs from 'node:fs/promises';
import path from 'node:path';

export function createUploadBarrier(notify) {
  let state = 'idle';
  let release;
  return {
    handleMessage(message) {
      if (message === 'arm-upload-barrier') {
        if (state !== 'idle') {
          notify('upload-barrier-error');
          return;
        }
        state = 'armed';
        notify('upload-barrier-armed');
      }
      if (message === 'release-upload-barrier') {
        const resume = release;
        state = 'idle';
        release = undefined;
        resume?.();
      }
    },
    pause() {
      if (state !== 'armed') return;
      state = 'paused';
      return new Promise((resolve) => {
        release = resolve;
        notify('upload-barrier-paused');
      });
    }
  };
}

if (process.send) {
  const barrier = createUploadBarrier((message) => process.send(message));
  process.on('message', barrier.handleMessage);
  const open = fs.open;
  fs.open = async function (filename, ...args) {
    if (typeof filename === 'string' && filename.includes(`${path.sep}uploads${path.sep}.tmp${path.sep}`)) {
      await barrier.pause();
    }
    return open.call(this, filename, ...args);
  };
}
