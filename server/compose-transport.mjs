// The local CLI uses the same explicit socket as Dockerode.
// SSH projects execute Compose on their Linux host through compose-remote.mjs.
export async function composeTransport(hosts, hostId) {
  if (hostId !== 'local') throw Error('Compose SSH doit être exécuté sur le serveur.');
  const engine = await hosts.client(hostId);
  const socket = await engine.modem.getSocketPath();
  if (!socket) throw Error('Le moteur local doit utiliser son socket Docker.');
  return {
    host:
      process.platform === 'win32' ? 'npipe://' + socket.replaceAll('\\', '/') : 'unix://' + socket,
    close: async () => {},
  };
}
