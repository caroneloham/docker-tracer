// In-memory Docker contract fixture. No real network traffic or container is created.
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import tar from 'tar-stream';
import { tsharkFields } from '../../server/packets.mjs';
const id = (n) => n.toString(16).padStart(64, '0');
const mux = (text) => {
  const body = Buffer.from(text),
    header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};
const archive = (name, body) => {
  const pack = tar.pack();
  pack.entry({ name }, body);
  pack.finalize();
  return pack;
};
export function fixtureEngine(count = 2) {
  const state = {
    dns: true,
    tcp: true,
    http: 200,
    tls: true,
    offline: false,
    imageAvailable: true,
    removed: [],
    commands: [],
    created: [],
    sequence: 10000,
  };
  const apps = new Map(
    Array.from({ length: count }, (_, i) => [
      id(i + 1),
      {
        Id: id(i + 1),
        Names: [`/${i === 0 ? 'client' : i === 1 ? 'web' : `service-${i + 1}`}`],
        Image: i === 0 ? 'fixture/no-shell' : 'nginx:alpine',
        State: 'running',
        Status: 'Up',
        Labels: {
          'com.docker.compose.project': `projet-${Math.floor(i / 10) + 1}`,
          'com.docker.compose.service': i === 0 ? 'client' : i === 1 ? 'web' : `service-${i + 1}`,
        },
        HostConfig: { NetworkMode: `net-${Math.floor(i / 10) + 1}` },
        Ports: [{ PrivatePort: 80, Type: 'tcp' }],
        NetworkSettings: {
          Networks: {
            [`net-${Math.floor(i / 10) + 1}`]: {
              NetworkID: id(1000 + Math.floor(i / 10)),
              IPAddress: `172.20.${Math.floor(i / 10)}.${(i % 10) + 2}`,
            },
          },
        },
      },
    ]),
  );
  const helpers = new Map();
  const checked = () => {
    if (state.offline) throw Error('SSH connection interrupted (fixture)');
  };
  const packet = () => {
    const values = {
      'frame.time_epoch': String(Date.now() / 1000),
      'ip.src': '172.20.0.2',
      'ip.dst': '172.20.0.3',
      'frame.len': '60',
      'frame.protocols': 'eth:ip:tcp',
      'tcp.srcport': '42500',
      'tcp.dstport': '80',
      '_ws.col.Info': '42500 → 80 [SYN]',
      'tcp.flags': '0x0002',
    };
    const line = tsharkFields.map((f) => values[f] || '').join('\t') + '\n';
    for (const h of helpers.values())
      if (h.options.Labels['io.dockertracer.role'] === 'observer' && h.running)
        h.stream.write(mux(line));
  };
  const docker = {
    modem: new Docker({ socketPath: 'fixture-unused' }).modem,
    info: async () => {
      checked();
      return { OSType: 'linux', ID: 'fixture', Name: 'Test synthétique', ServerVersion: 'fixture' };
    },
    listContainers: async (options = {}) => {
      checked();
      const all = [
        ...apps.values(),
        ...Array.from(helpers, ([Id, h]) => ({
          Id,
          Names: [`/${h.options.name}`],
          Image: h.options.Image,
          State: h.running ? 'running' : 'exited',
          Labels: h.options.Labels,
          NetworkSettings: { Networks: {} },
          HostConfig: h.options.HostConfig,
        })),
      ];
      return all.filter(
        (c) =>
          !options.filters?.label ||
          options.filters.label.every((v) => {
            const [k, x] = v.split('=');
            return c.Labels[k] === x;
          }),
      );
    },
    listNetworks: async () => {
      checked();
      return Array.from({ length: Math.ceil(count / 10) }, (_, i) => ({
        Id: id(1000 + i),
        Name: `net-${i + 1}`,
        Driver: 'bridge',
        IPAM: { Config: [{ Subnet: `172.20.${i}.0/24` }] },
      }));
    },
    getImage: () => ({
      inspect: async () => {
        checked();
        if (!state.imageAvailable) throw Error('Registry unavailable (fixture)');
        return {};
      },
    }),
    getContainer(containerId) {
      const app = apps.get(containerId),
        h = helpers.get(containerId);
      const container = {
        id: containerId,
        inspect: async () => {
          checked();
          if (!app && !h) throw Object.assign(Error('No container'), { statusCode: 404 });
          return {
            Config: { Tty: false },
            State: {
              Running: app ? app.State === 'running' : h.running,
              Status: app?.State || 'running',
              ExitCode: 0,
            },
            HostConfig: app?.HostConfig || h.options.HostConfig,
          };
        },
        start: async () => {
          checked();
          if (app) app.State = 'running';
          else h.running = true;
        },
        stop: async () => {
          checked();
          if (app) app.State = 'exited';
          else {
            h.running = false;
            h.stream.end();
          }
        },
        restart: async () => {
          checked();
          if (app) app.State = 'running';
        },
        kill: async () => {
          h.running = false;
          h.stream.end();
        },
        wait: async () => ({ StatusCode: 0 }),
        remove: async () => {
          state.removed.push(containerId);
          helpers.delete(containerId);
        },
        logs: async () => mux('fixture log\n'),
        stats: async () => ({
          cpu_stats: { cpu_usage: { total_usage: 0 } },
          precpu_stats: { cpu_usage: {} },
          memory_stats: { usage: 0 },
          networks: {},
        }),
        attach: async () => h.stream,
        getArchive: async ({ path }) => {
          if (path.endsWith('resolv.conf'))
            return archive('resolv.conf', Buffer.from('nameserver 127.0.0.11\n'));
          if (path.endsWith('hosts')) return archive('hosts', Buffer.from('127.0.0.1 localhost\n'));
          const pcap = Buffer.alloc(24);
          pcap.writeUInt32LE(0xa1b2c3d4, 0);
          pcap.writeUInt16LE(2, 4);
          pcap.writeUInt16LE(4, 6);
          pcap.writeUInt32LE(65535, 16);
          pcap.writeUInt32LE(1, 20);
          return archive('trace.pcap', pcap);
        },
        exec: async ({ Cmd }) => {
          if (app) throw Error('Application has no executable tools');
          state.commands.push(Cmd);
          let exitCode = 0,
            output = '';
          if (Cmd[0] === 'dig') output = state.dns ? '172.20.0.3\n' : '';
          if (Cmd[0] === 'nc' || Cmd[0] === 'ping') {
            packet();
            exitCode = state.tcp ? 0 : 1;
            output = state.tcp ? 'Connection succeeded' : 'Connection refused';
          }
          if (Cmd[0] === 'curl') {
            packet();
            exitCode = state.tls ? 0 : 60;
            output = state.tls ? `${state.http}\n0.005` : '000\n0.005';
          }
          return {
            start: async () => {
              const stream = new PassThrough();
              setImmediate(() => stream.end(mux(output)));
              return stream;
            },
            inspect: async () => ({ Running: false, ExitCode: exitCode }),
          };
        },
      };
      return container;
    },
    createContainer: async (options) => {
      checked();
      const key = id(state.sequence++);
      state.created.push(options);
      helpers.set(key, { options, running: false, stream: new PassThrough() });
      return docker.getContainer(key);
    },
  };
  return { docker, state, apps, helpers };
}
