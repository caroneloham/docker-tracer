// Explicit integration run: creates and removes an isolated, labelled Docker lab.
import assert from 'node:assert/strict';
import { initialTopology } from '../shared/model.mjs';
import { probeCommand } from '../shared/probes.mjs';
import { packetChecks } from '../shared/packet-checks.mjs';
import {
  deploy,
  runtime,
  resources,
  execute,
  labAction,
  CaptureManager,
} from '../server/docker.mjs';

const t = initialTopology();
t.id = `verify-${Date.now().toString(36)}`;
t.nodes = t.nodes.filter((n) => ['client', 'frontend', 'web'].includes(n.id));
t.edges = t.edges.filter(
  (e) => t.nodes.some((n) => n.id === e.source) && t.nodes.some((n) => n.id === e.target),
);
const packets = [];
const capture = new CaptureManager((event) => {
  if (event.type === 'packet') packets.push(event.packet);
  else if (event.message) console.log(event.message);
});
try {
  await deploy(t, console.log);
  const state = await runtime(t);
  assert.equal(Object.values(state.nodes).filter((n) => n.state === 'running').length, 2);
  assert.ok(state.nodes.client.addresses[0]);
  assert.ok(state.nodes.client.metrics.memory >= 0);
  assert.equal(state.nodes.client.ports.length, 0);
  assert.equal(state.nodes.client.interfaces[0].networkId, 'frontend');
  assert.equal(state.nodes.client.interfaces[0].name, 'eth0');
  assert.equal(state.nodes.client.interfaces[0].ip, state.nodes.client.addresses[0]);
  await capture.start(t, state.addressMap);
  console.log('Vérification de la capture après 13 secondes sans trafic…');
  await new Promise((resolve) => setTimeout(resolve, 13000));
  const target = state.nodes.web.addresses[0];
  const command = (options) =>
    probeCommand({ source: 'client', target: 'web', ...options }, target, 'web');
  const ping = await execute(
    t,
    'client',
    command({ protocol: 'ICMP', count: 3, size: 100, ttl: 41 }),
  );
  assert.equal(ping.exitCode, 0, ping.output);
  const http = await execute(
    t,
    'client',
    command({ protocol: 'HTTP', headers: 'X-Docker-Tracer: verification' }),
  );
  assert.equal(http.exitCode, 0, http.output);
  assert.match(http.output, /Welcome to nginx/);
  const http404 = await execute(
    t,
    'client',
    command({ protocol: 'HTTP', path: '/docker-tracer-missing' }),
  );
  assert.notEqual(http404.exitCode, 0);
  const tcp = await execute(
    t,
    'client',
    command({ protocol: 'TCP', port: 80, payload: 'GET / HTTP/1.0\r\n\r\n' }),
  );
  assert.match(tcp.output, /200 OK/);
  const udp = await execute(
    t,
    'client',
    command({ protocol: 'UDP', port: 9, payload: 'Docker Tracer verification' }),
  );
  assert.equal(udp.exitCode, 0);
  const dns = await execute(t, 'client', command({ protocol: 'DNS' }));
  assert.equal(dns.exitCode, 0, dns.output);
  const deadline = Date.now() + 5000;
  while (
    Date.now() < deadline &&
    (!packets.some((p) => p.layers?.application?.dnsResponse === '1') ||
      packets.filter((p) => p.protocol === 'ICMP').length < 6)
  )
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    packets.filter((p) => p.protocol === 'ICMP').length >= 6,
    'Les requêtes et réponses ICMP doivent être capturées.',
  );
  assert.ok(
    packets.some((p) => p.protocol === 'HTTP'),
    'La requête HTTP doit être capturée.',
  );
  assert.ok(
    packets.some((p) => p.layers?.network?.ttl === '41'),
    'TTL personnalisé capturé',
  );
  assert.ok(
    packets.some((p) => p.protocol === 'UDP'),
    'Datagramme UDP réellement envoyé',
  );
  assert.ok(
    packets.some(
      (p) => p.layers?.application?.dnsQuery === 'web' && p.layers.application.dnsResponse === '1',
    ),
    'Réponse DNS décodée',
  );
  const failurePacket = packets.find((p) => p.layers?.application?.status === '404');
  assert.ok(failurePacket, 'Réponse HTTP 404 capturée');
  assert.ok(
    packetChecks(failurePacket).some((c) => c.message.includes('HTTP 404')),
    'Échec HTTP expliqué',
  );
  assert.ok(
    packets.some(
      (p) => p.sourceNode === 'client' && p.targetNode === 'web' && p.route.length === 2,
    ),
    'Un vrai paquet doit être associé aux deux liens du bridge.',
  );
  await capture.stop(t);
  await labAction(t, 'stop');
  assert.ok(Object.values((await runtime(t)).nodes).every((n) => n.state !== 'running'));
  await labAction(t, 'start');
  assert.ok(Object.values((await runtime(t)).nodes).every((n) => n.state === 'running'));
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        packets: packets.length,
        protocols: [...new Set(packets.map((p) => p.protocol))],
        checks: [
          'deploy',
          'runtime',
          'ping',
          'http',
          'dns',
          'custom-icmp-ttl-size',
          'http-404-diagnostic',
          'tcp-payload',
          'udp-datagram',
          'dns-response-fields',
          'capture-after-idle',
          'packet-route',
          'stop',
          'start',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await capture.stop(t);
  await labAction(t, 'remove');
  const remaining = await resources(t);
  assert.equal(remaining.containers.length, 0);
  assert.equal(remaining.networks.length, 0);
  console.log('Ressources de vérification supprimées.');
}
