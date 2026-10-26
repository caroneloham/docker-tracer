import test from 'node:test';
import assert from 'node:assert/strict';
import { probeSchema, probeCommand } from '../shared/probes.mjs';
import { packetChecks } from '../shared/packet-checks.mjs';
import { validateEquipmentTemplate, loadEquipmentTemplates } from '../shared/templates.mjs';
import { newNode } from '../shared/model.mjs';
import { parsePacket, tsharkFields } from '../server/packets.mjs';
const base = { source: 'client', target: 'web', protocol: 'ICMP' };
test('PDU : paramètres ICMP personnalisés et limites avant exécution', () => {
  const cmd = probeCommand({ ...base, count: 2, size: 100, ttl: 41 }, '172.23.0.3', 'web');
  assert.deepEqual(cmd, [
    'ping',
    '-c',
    '2',
    '-W',
    '1',
    '-w',
    '12',
    '-s',
    '100',
    '-t',
    '41',
    '172.23.0.3',
  ]);
  for (const invalid of [{ count: 11 }, { size: 1500 }, { ttl: 0 }, { port: 0 }, { source: 'web' }])
    assert.equal(probeSchema.safeParse({ ...base, ...invalid }).success, false);
});
test('PDU : HTTP et DNS transmettent des arguments validés', () => {
  const cmd = probeCommand(
    {
      ...base,
      protocol: 'HTTP',
      method: 'POST',
      port: 8080,
      path: '/test?q=1',
      payload: 'hello',
      headers: 'X-Lab: test',
    },
    '172.23.0.3',
    'web',
  );
  assert.ok(cmd.includes('--post-data'));
  assert.ok(cmd.includes('hello'));
  assert.ok(cmd.includes('X-Lab: test'));
  assert.equal(cmd.at(-1), 'http://172.23.0.3:8080/test?q=1');
  assert.equal(
    probeSchema.safeParse({ ...base, headers: 'X: ok\r\nInjected: bad' }).success,
    false,
  );
  assert.equal(probeSchema.safeParse({ ...base, protocol: 'DNS', query: '-debug' }).success, false);
  assert.deepEqual(probeCommand({ ...base, protocol: 'DNS' }, '172.23.0.3', 'web'), [
    'nslookup',
    'web',
  ]);
});
test('PDU : les données TCP et UDP ne deviennent jamais du code shell', () => {
  assert.equal(probeSchema.safeParse({ ...base, protocol: 'UDP', payload: '' }).success, false);
  const payload = '$(touch /tmp/must-not-exist); `id`\nPING\r\n';
  for (const protocol of ['TCP', 'UDP']) {
    const cmd = probeCommand({ ...base, protocol, payload, port: 6379 }, '172.24.0.3', 'redis');
    assert.equal(cmd[4], payload);
    assert.ok(!cmd[2].includes(payload));
    assert.equal(cmd[5], '172.24.0.3');
    assert.equal(cmd[6], '6379');
  }
});
test('enveloppes : couches réelles décodées et diagnostic HTTP / TCP', () => {
  const values = {
    'frame.time_epoch': '1788711000.1',
    'ip.src': '172.23.0.2',
    'ip.dst': '172.23.0.3',
    'eth.src': 'aa:bb:cc:dd:ee:ff',
    'eth.dst': '01:02:03:04:05:06',
    'frame.len': '198',
    'frame.protocols': 'eth:ip:tcp:http',
    'tcp.srcport': '42000',
    'tcp.dstport': '80',
    '_ws.col.Info': 'HTTP/1.1 404 Not Found',
    'ip.ttl': '41',
    'tcp.flags': '0x0004',
    'http.response.code': '404',
  };
  const p = parsePacket(
    tsharkFields.map((f) => values[f] || '').join('\t'),
    'client',
    new Map(),
    1,
  );
  assert.equal(p.layers.network.ttl, '41');
  assert.equal(p.layers.ethernet.source, 'aa:bb:cc:dd:ee:ff');
  assert.equal(p.layers.application.status, '404');
  const checks = packetChecks({ ...p, route: [{ id: 'link' }] });
  assert.ok(checks.some((c) => c.message.includes('TCP RST') && c.level === 'alert'));
  assert.ok(checks.some((c) => c.message.includes('HTTP 404')));
  for (const [decoded, normalized] of [
    ['True', '1'],
    ['False', '0'],
    ['1', '1'],
    ['0', '0'],
  ]) {
    const dns = { ...values, 'dns.flags.response': decoded };
    assert.equal(
      parsePacket(tsharkFields.map((f) => dns[f] || '').join('\t'), 'client', new Map(), 2).layers
        .application.dnsResponse,
      normalized,
    );
  }
});
test('modèles : configuration valide, copies indépendantes et refus des ports dupliqués', () => {
  const data = newNode('custom', 'template', { x: 0, y: 0 }).data;
  const model = validateEquipmentTemplate({
    id: 'custom-test',
    title: 'Mon serveur',
    data: { ...data, env: 'PORT=3000', ports: [{ host: 8080, container: 80 }] },
  });
  assert.equal(model.data.env, 'PORT=3000');
  assert.equal(model.data.ports[0].host, 8080);
  const copy = structuredClone(model.data);
  copy.image = 'redis:7-alpine';
  assert.notEqual(model.data.image, copy.image);
  assert.throws(() =>
    validateEquipmentTemplate({
      id: 'x',
      title: 'Bad',
      data: {
        ...data,
        ports: [
          { host: 8080, container: 80 },
          { host: 8080, container: 81 },
        ],
      },
    }),
  );
  assert.throws(() =>
    validateEquipmentTemplate({ id: 'x', title: 'Bad', data: { ...data, image: 'bad image' } }),
  );
  assert.equal(loadEquipmentTemplates({ getItem: () => JSON.stringify([model]) }).length, 1);
});
