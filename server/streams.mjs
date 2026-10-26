// Decode Docker's multiplexed stdout/stderr frames.
export function decodeDockerLog(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer);
  const output = [];
  let offset = 0;
  while (
    offset + 8 <= buffer.length &&
    buffer[offset] <= 2 &&
    buffer[offset + 1] === 0 &&
    buffer[offset + 2] === 0 &&
    buffer[offset + 3] === 0
  ) {
    const length = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + length > buffer.length) break;
    output.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  return output.length ? Buffer.concat(output).toString('utf8') : buffer.toString('utf8');
}

// HTTP IncomingMessage delegates setTimeout to its socket. Dockerode's SSH
// channel has no such method; connection/command deadlines are managed separately.
export function disableIdleTimeout(stream) {
  if (typeof stream.socket?.setTimeout === 'function') stream.socket.setTimeout(0);
  else if (!stream.socket && typeof stream.setTimeout === 'function') stream.setTimeout(0);
}

export function requestTimeout(options) {
  const url = new URL(options.path, 'http://docker.local');
  if (options.method === 'PUT' && /\/containers\/[^/]+\/archive$/.test(url.pathname))
    return 30 * 60 * 1000;
  if (options.method === 'POST' && /\/containers\/[^/]+\/stop$/.test(url.pathname)) {
    const seconds = Number(url.searchParams.get('t'));
    if (Number.isFinite(seconds) && seconds > 0)
      return Math.max(12000, Math.min(seconds, 120) * 1000 + 5000);
  }
  return 12000;
}
