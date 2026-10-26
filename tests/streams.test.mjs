import test from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { disableIdleTimeout } from '../server/streams.mjs';
test('captures : IncomingMessage sur canal SSH sans setTimeout, et socket local', () => {
  const ssh = new IncomingMessage(new PassThrough());
  assert.throws(() => ssh.setTimeout(0), /setTimeout/);
  assert.doesNotThrow(() => disableIdleTimeout(ssh));
  const calls = [],
    socket = new PassThrough();
  socket.setTimeout = (n) => calls.push(n);
  disableIdleTimeout(new IncomingMessage(socket));
  disableIdleTimeout({ setTimeout: (n) => calls.push(n) });
  assert.deepEqual(calls, [0, 0]);
  ssh.destroy();
  socket.destroy();
});
