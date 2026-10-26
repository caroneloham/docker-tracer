import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { openWorkspaceStore } from '../server/workspace-store.mjs';
import { HostRegistry, keyFingerprint } from '../server/hosts.mjs';
import { qualifyInventory } from '../shared/workspace.mjs';

const key = () =>
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  });
async function endpoint(hostKey, userKey, name, port = 0) {
  const sockets = new Set();
  let authentications = 0;
  const allowed = ssh2.utils.parseKey(userKey);
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    client
      .on('authentication', (ctx) => {
        authentications++;
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
            if (info.command !== 'docker system dial-stdio') return reject();
            const stream = accept();
            let input = '';
            stream.on('data', (chunk) => {
              input += chunk;
              if (!input.includes('\r\n\r\n')) return;
              const url = input.split(' ')[1];
              const value = url.startsWith('/info')
                ? { OSType: 'linux', ID: name, Name: name, ServerVersion: 'test-engine' }
                : url.startsWith('/containers/json')
                  ? [
                      {
                        Id: 'a'.repeat(64),
                        Names: ['/web'],
                        Image: 'nginx',
                        State: 'running',
                        Labels: {
                          'com.docker.compose.project': 'demo',
                          'com.docker.compose.service': 'web',
                        },
                        NetworkSettings: {
                          Networks: { net: { NetworkID: 'n'.repeat(64), IPAddress: '172.20.0.2' } },
                        },
                      },
                    ]
                  : [{ Id: 'n'.repeat(64), Name: 'net', Driver: 'bridge' }];
              const body = JSON.stringify(value);
              stream.end(
                `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
              );
              input = '';
            });
          }),
        ),
      );
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    authentications: () => authentications,
    close: async () => {
      for (const c of sockets) c.end();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
test(
  'SSH réel isolé : première confiance, deux hôtes homonymes, clé modifiée et coupure',
  { timeout: 30000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-ssh-')),
      userKey = key(),
      hostKey = key();
    const identityFile = path.join(dir, 'test-key');
    await writeFile(identityFile, userKey, { mode: 0o600 });
    const servers = [];
    t.after(async () => {
      await Promise.allSettled(servers.map((s) => s.close()));
      await rm(dir, { recursive: true, force: true });
    });
    const a = await endpoint(hostKey, userKey, 'engine-a'),
      b = await endpoint(key(), userKey, 'engine-b');
    servers.push(a, b);
    const store = await openWorkspaceStore(dir),
      hosts = new HostRegistry(store, {});
    const create = (port) =>
      hosts.save({
        kind: 'ssh',
        name: 'Test SSH',
        address: '127.0.0.1',
        port,
        username: 'tester',
        auth: 'key',
        identityFile,
        fingerprint: keyFingerprint(ssh2.utils.parseKey(hostKey).getPublicSSH()),
      });
    const ha = await create(a.port),
      hb = await create(b.port);
    assert.equal(ha.fingerprint, null, 'Le formulaire ne peut pas injecter une confiance SSH');
    const untrusted = await hosts.test(ha.id);
    assert.equal(untrusted.state, 'untrusted');
    assert.equal(a.authentications(), 0);
    await assert.rejects(hosts.trust(ha.id, 'SHA256:incorrect'));
    assert.equal((await hosts.trust(ha.id, untrusted.fingerprint)).state, 'connected');
    const clientBeforeRename = await hosts.client(ha.id);
    const renamed = await hosts.save({ id: ha.id, name: 'Serveur renommé' });
    assert.equal(renamed.identityFile, identityFile);
    assert.equal(renamed.port, a.port);
    assert.equal(renamed.auth, 'key');
    assert.equal(
      await hosts.client(ha.id),
      clientBeforeRename,
      'Renommer ne coupe pas les captures actives',
    );
    const ub = await hosts.test(hb.id);
    assert.equal((await hosts.trust(hb.id, ub.fingerprint)).state, 'connected');
    const ia = qualifyInventory(await hosts.inventory(ha.id), ha),
      ib = qualifyInventory(await hosts.inventory(hb.id), hb);
    assert.equal(ia.containers[0].name, ib.containers[0].name);
    assert.notEqual(ia.containers[0].id, ib.containers[0].id);
    await a.close();
    servers.splice(servers.indexOf(a), 1);
    const changed = await endpoint(key(), userKey, 'replacement', a.port);
    servers.push(changed);
    const refused = await hosts.test(ha.id);
    assert.equal(refused.state, 'changed-key');
    assert.equal(changed.authentications(), 0);
    assert.notEqual(refused.fingerprint, refused.previousFingerprint);
    await changed.close();
    servers.splice(servers.indexOf(changed), 1);
    assert.equal((await hosts.test(ha.id)).state, 'offline');
  },
);
