import { LABEL, attachedNetworks, endpointSettings, volumeMounts } from '../shared/model.mjs';
import { installConfiguration } from './configuration.mjs';
import { bridgeDriverOptions, bridgeIpam } from '../shared/bridge.mjs';

export const labLabels = (t, node, role) => ({
  [`${LABEL}.project`]: t.id,
  [`${LABEL}.node`]: node,
  [`${LABEL}.role`]: role,
});
export const labName = (t, n) => `dtr-${t.id}-${n.id}`;
export const createLabNetwork = (engine, t, n) =>
  engine.createNetwork({
    Name: labName(t, n),
    Driver: 'bridge',
    Internal: n.data.internal,
    Labels: labLabels(t, n.id, 'network'),
    EnableIPv6: !!n.data.bridge?.ipv6,
    Options: bridgeDriverOptions(n.data),
    ...(bridgeIpam(n.data).length
      ? {
          IPAM: {
            Config: bridgeIpam(n.data).map((p) => ({
              Subnet: p.subnet,
              ...(p.gateway ? { Gateway: p.gateway } : {}),
              ...(p.ip_range ? { IPRange: p.ip_range } : {}),
            })),
          },
        }
      : {}),
  });

export async function createLabContainer(engine, t, n, networks, onCreated) {
  const d = n.data,
    nets = attachedNetworks(t, n.id),
    portBindings = {},
    exposed = {},
    mounts = [];
  for (const p of d.ports) {
    const key = `${p.container}/${p.protocol || 'tcp'}`;
    (portBindings[key] ||= []).push({ HostIp: p.hostIp || '127.0.0.1', HostPort: String(p.host) });
    exposed[key] = {};
  }
  for (const m of volumeMounts(n)) {
    const name = `${labName(t, n)}-${m.id}`;
    try {
      const existing = await engine.getVolume(name).inspect();
      if (Object.entries(labLabels(t, n.id, 'volume')).some(([k, v]) => existing.Labels?.[k] !== v))
        throw Error(`Le volume ${name} existe et n’appartient pas à cet équipement.`);
    } catch (e) {
      if (e.statusCode !== 404) throw e;
      await engine.createVolume({
        Name: name,
        Labels: { ...labLabels(t, n.id, 'volume'), [LABEL + '.mount-target']: m.target },
      });
    }
    mounts.push({ Type: 'volume', Source: name, Target: m.target, ReadOnly: m.readOnly });
  }
  const first = nets[0];
  const c = await engine.createContainer({
    name: labName(t, n),
    Hostname: d.label,
    Image: d.image,
    Labels: labLabels(t, n.id, 'node'),
    ...(d.command ? { Cmd: ['/bin/sh', '-lc', d.command] } : {}),
    Env: d.env.split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#')),
    ExposedPorts: exposed,
    HostConfig: {
      NetworkMode: first ? labName(t, first) : 'none',
      PortBindings: portBindings,
      Mounts: mounts,
      Memory: (d.memoryMb ?? 512) * 1024 * 1024,
      NanoCpus: Math.round((d.cpus ?? 1) * 1e9),
      PidsLimit: d.pidsLimit ?? 256,
      RestartPolicy: { Name: d.restart || 'no' },
      Dns: d.dns || [],
    },
    ...(first
      ? {
          NetworkingConfig: {
            EndpointsConfig: { [networks.get(first.id)]: endpointSettings(t, n.id, first.id) },
          },
        }
      : {}),
  });
  onCreated(c);
  await installConfiguration(c, t, n);
  for (const net of nets.slice(1))
    await engine
      .getNetwork(networks.get(net.id))
      .connect({ Container: c.id, EndpointConfig: endpointSettings(t, n.id, net.id) });
  return c;
}
