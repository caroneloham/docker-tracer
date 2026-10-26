import { docker } from '../server/docker.mjs';
const prefix = 'dtr-mode-probe-' + Date.now().toString(36);
for (const mode of ['id', 'name']) {
  let net, container;
  try {
    const name = prefix + '-' + mode;
    net = await docker.createNetwork({ Name: name });
    container = await docker.createContainer({ name, Image: 'alpine:3.23', Cmd: ['sleep', 'infinity'], HostConfig: { NetworkMode: mode === 'id' ? net.id : name } });
    await container.start(); await container.stop({ t: 1 });
    await net.disconnect({ Container: container.id }); await net.remove();
    net = await docker.createNetwork({ Name: name });
    await net.connect({ Container: container.id });
    try { await container.start(); console.log(mode + ': ancien conteneur redémarré sur le réseau recréé'); }
    catch (e) { console.log(mode + ': refus réel de redémarrage : ' + e.message); }
    console.log(mode + ': mode actuel ' + (await container.inspect()).HostConfig.NetworkMode);
  } finally {
    if (container) await container.remove({ force: true });
    if (net) await net.remove();
  }
}
