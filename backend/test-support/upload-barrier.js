// Loaded only by the integration-test server. Pause file validation after the
// route has read the revision, so tests can deterministically interleave a save.
import fs from 'node:fs/promises';
import path from 'node:path';
let armed = false;
let release;
process.on('message', (message) => {
  if (message === 'arm-upload-barrier') {
    armed = true;
    process.send('upload-barrier-armed');
  }
  if (message === 'release-upload-barrier') release?.();
});
const open = fs.open;
fs.open = async function (filename, ...args) {
  if (armed && typeof filename === 'string' && filename.includes(`${path.sep}uploads${path.sep}.tmp${path.sep}`)) {
    armed = false;
    await new Promise((resolve) => {
      release = resolve;
      process.send('upload-barrier-paused');
    });
    release = undefined;
  }
  return open.call(this, filename, ...args);
};
