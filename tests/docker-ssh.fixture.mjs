// Real SSH transport to the local Docker engine, using a temporary authenticated loopback endpoint.
import net from 'node:net';
import ssh2 from 'ssh2';
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const key = () =>
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  });
export async function dockerSshEndpoint(dir, engine, shellCommand) {
  const userKey = key(),
    hostKey = key(),
    allowed = ssh2.utils.parseKey(userKey),
    clients = new Set(),
    pipes = new Set();
  const identityFile = path.join(dir, 'ssh-test-key');
  await writeFile(identityFile, userKey, { mode: 0o600 });
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client
      .on('authentication', (ctx) => {
        if (
          ctx.method !== 'publickey' ||
          ctx.username !== 'tester' ||
          !ctx.key.data.equals(allowed.getPublicSSH())
        )
          return ctx.reject();
        if (ctx.signature && !allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo))
          return ctx.reject();
        ctx.accept();
      })
      .on('ready', () =>
        client.on('session', (accept) =>
          accept().on('exec', (accept, reject, info) => {
            if (info.command === 'sh -s' && shellCommand) return shellCommand(accept());
            if (info.command !== 'docker system dial-stdio') return reject();
            const stream = accept(),
              socket = net.connect(engine.modem.socketPath);
            pipes.add(socket);
            socket.on('close', () => {
              pipes.delete(socket);
              stream.end();
            });
            socket.on('error', () => stream.destroy());
            stream.on('error', () => socket.destroy());
            stream.on('close', () => socket.destroy());
            stream.pipe(socket).pipe(stream);
          }),
        ),
      );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let closed = false;
  return {
    profile: {
      kind: 'ssh',
      name: 'SSH de validation',
      address: '127.0.0.1',
      port: server.address().port,
      username: 'tester',
      auth: 'key',
      identityFile,
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of pipes) socket.destroy();
      for (const client of clients) client.end();
      await new Promise((r) => server.close(r));
    },
  };
}
