import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { composeDocument } from '../shared/compose-project.mjs';
import {
  analyzeRedundancyNetwork,
  planLocalRedundancy,
  parseRedundancyPort,
  readLocalRedundancy,
  updateLocalRedundancyReplicas,
  LOCAL_REDUNDANCY_IMAGE,
  LOCAL_REDUNDANCY_MARKER,
} from '../shared/redundancy-network.mjs';

const basic = `# Keep this source comment
services:
  web:
    image: example/web:1.0
    ports: ['127.0.0.1:8080:80']
    environment:
      TOKEN: unchanged-secret
    labels:
      custom: keep
  database:
    image: postgres:17
    volumes: [db:/var/lib/postgresql/data]
volumes:
  db: {}
`;
const endpoint = {
  service: 'web',
  targetPort: 80,
  publishedPort: 8080,
  protocol: 'http',
  healthPath: '/ready',
};
const settings = (extra = {}) => ({
  serviceNames: ['web'],
  replicas: 2,
  confirmations: { statelessServices: ['web'] },
  endpoints: [endpoint],
  ...extra,
});
const codes = (result) => result.blockers.map((item) => item.code);
function blocked(source, options, code) {
  const result = planLocalRedundancy(source, options);
  assert.ok(codes(result).includes(code), JSON.stringify(result.blockers));
  assert.equal(result.source, source);
  assert.equal(result.summary.applicable, false);
  return result;
}

test('local redundancy keeps public IP/port, secrets, unrelated state and dependencies', () => {
  const source = basic.replace('    ports:', '    depends_on: [database]\n    ports:');
  const before = composeDocument(source).model;
  const plan = planLocalRedundancy(source, settings());
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.summary.applicable, true);
  assert.equal(plan.summary.proof, 'not-tested');
  assert.equal(plan.summary.measuredRtoMs, null);
  const after = composeDocument(plan.source).model;
  assert.deepEqual(after.services.database, before.services.database);
  assert.deepEqual(after.volumes, before.volumes);
  assert.deepEqual(after.services.web.environment, before.services.web.environment);
  assert.deepEqual(after.services.web.depends_on, ['database']);
  assert.deepEqual(after.services.web.ports, []);
  assert.equal(after.services.web.deploy.replicas, 2);
  assert.equal(after.services.web.restart, 'unless-stopped');
  assert.match(plan.source, /# Keep this source comment/);
  const proxy = after.services[plan.summary.proxyService];
  assert.equal(proxy.image, LOCAL_REDUNDANCY_IMAGE);
  assert.deepEqual(proxy.ports, [
    { target: 18080, published: '8080', protocol: 'tcp', host_ip: '127.0.0.1' },
  ]);
  assert.deepEqual(proxy.depends_on, { web: { condition: 'service_started' } });
  assert.ok(!proxy.container_name);
  assert.deepEqual(proxy.sysctls, { 'net.ipv4.ip_forward': '0' });
  assert.deepEqual(after.services.web.networks.default, null);
  assert.deepEqual(proxy.networks, {
    [plan.summary.entryNetworkName]: { gw_priority: 1 },
    [plan.summary.networkName]: {},
  });
  assert.ok(!JSON.stringify({ ...plan, source: undefined }).includes('unchanged-secret'));
  assert.ok(plan.warnings.some((item) => item.code === 'INTERNAL_DNS_DIRECT'));
  assert.ok(plan.warnings.some((item) => item.code === 'RESTART_SCOPE'));
});

test('public API enforces state checks and never lets confirmation bypass writable data', () => {
  blocked(basic, settings({ confirmations: {} }), 'STATE_UNCLASSIFIED');
  const source = basic.replace('    labels:', '    volumes: [appdata:/data]\n    labels:');
  assert.ok(planLocalRedundancy(source, settings()).blockers.length);
  assert.equal(planLocalRedundancy(source, settings()).source, source);
  const result = planLocalRedundancy(basic.replace('example/web:1.0', 'postgres:17'), settings());
  assert.ok(codes(result).includes('DATABASE_REPLICATION_REQUIRED'));
});

test('HAProxy config gates readiness and continuously discovers distinct replica IPs', () => {
  const plan = planLocalRedundancy(basic, settings());
  const model = composeDocument(plan.source).model;
  const config = model.configs[plan.summary.configName].content;
  assert.equal(config, plan.summary.haproxyConfig);
  assert.match(config, /nameserver embedded 127\.0\.0\.11:53/);
  assert.match(config, /hold obsolete 0s/);
  assert.match(
    config,
    /http-check connect\n\s+http-check send meth GET uri \/ready ver HTTP\/1.1 hdr Host tracer-ha-backend-1/,
  );
  assert.match(config, /http-check expect status 200-299/);
  assert.match(config, /inter 2s fall 3 rise 2 init-state fully-down/);
  assert.match(
    config,
    /server-template replica 1-2 tracer-ha-backend-1:80 check resolvers docker resolve-prefer ipv4 resolve-opts prevent-dup-ip init-addr none/,
  );
  assert.doesNotMatch(config, /allow-dup-ip|init-addr libc|option redispatch/);
  assert.match(config, /retries 0/);
  assert.match(
    config,
    /frontend tracer_readiness\n  bind 127\.0\.0\.1:19080\n  mode http\n  monitor-uri \/ready\n  monitor fail if \{ nbsrv\(pool_1\) lt 1 \}/,
  );
  assert.deepEqual(model.services[plan.summary.proxyService].healthcheck.test, [
    'CMD',
    'wget',
    '-q',
    '-O',
    '/dev/null',
    'http://127.0.0.1:19080/ready',
  ]);
  assert.ok(!model.services[plan.summary.proxyService].ports.some((port) => port.target === 19080));
  assert.ok(!model.configs[plan.summary.configName].file);
  assert.deepEqual(model.services[plan.summary.proxyService].configs, [
    { source: plan.summary.configName, target: '/usr/local/etc/haproxy/haproxy.cfg' },
  ]);
});

test('resize an existing group updates all replicas and DNS slots without duplicating resources', () => {
  const initial = planLocalRedundancy(basic, settings());
  const before = composeDocument(initial.source).model;
  assert.equal(readLocalRedundancy(initial.source).replicas, 2);
  const updated = updateLocalRedundancyReplicas(initial.source, {
    replicas: 4,
    confirmations: { statelessServices: ['web'] },
  });
  assert.deepEqual(updated.blockers, []);
  assert.equal(updated.summary.updatedExisting, true);
  assert.equal(updated.summary.replicas, 4);
  const after = composeDocument(updated.source).model;
  assert.deepEqual(Object.keys(after.services), Object.keys(before.services));
  assert.deepEqual(after.networks, before.networks);
  assert.deepEqual(
    after.services[initial.summary.proxyService].ports,
    before.services[initial.summary.proxyService].ports,
  );
  assert.deepEqual(after.services.database, before.services.database);
  assert.equal(after.services.web.deploy.replicas, 4);
  assert.notEqual(
    after.services[initial.summary.proxyService].labels['io.docker-tracer.haproxy-config'],
    before.services[initial.summary.proxyService].labels['io.docker-tracer.haproxy-config'],
  );
  assert.equal(after[LOCAL_REDUNDANCY_MARKER].replicas, 4);
  assert.match(updated.summary.haproxyConfig, /server-template replica 1-4 /);
  assert.equal(readLocalRedundancy(updated.source).replicas, 4);
  assert.match(updated.source, /# Keep this source comment/);
});

test('existing proxy gains a stable public gateway without losing network options', () => {
  const initial = planLocalRedundancy(basic, settings());
  const model = composeDocument(initial.source).model;
  const metadata = model[LOCAL_REDUNDANCY_MARKER];
  const proxy = model.services[metadata.proxyService];
  proxy.networks = {
    [metadata.entryNetworkName]: { aliases: ['public-entry'] },
    [metadata.networkName]: { gw_priority: 2 },
  };
  const updated = updateLocalRedundancyReplicas(YAML.stringify(model), {
    replicas: 2,
    confirmations: { statelessServices: ['web'] },
  });
  assert.deepEqual(updated.blockers, []);
  const after = composeDocument(updated.source).model.services[metadata.proxyService];
  assert.deepEqual(after.networks[metadata.entryNetworkName], {
    aliases: ['public-entry'], gw_priority: 3,
  });
  assert.deepEqual(after.networks[metadata.networkName], { gw_priority: 2 });
  assert.equal(updated.summary.minimumComposeVersion, '2.33.1');
});

test('resize fails closed for new state, altered templates, invalid groups and changed scope', () => {
  const initial = planLocalRedundancy(basic, settings());
  for (const [source, options, expected] of [
    [initial.source, { replicas: 3 }, 'STATE_UNCLASSIFIED'],
    [
      initial.source,
      { replicas: 5, confirmations: { statelessServices: ['web'] } },
      'INVALID_REPLICA_COUNT',
    ],
    [
      initial.source,
      { replicas: 3, confirmations: { statelessServices: ['web'] }, serviceNames: ['database'] },
      'PREPARED_GROUP_SCOPE',
    ],
    [
      initial.source.replace('server-template replica 1-2 ', 'server-template other 1-2 '),
      { replicas: 3, confirmations: { statelessServices: ['web'] } },
      'PROXY_CONFIGURATION_CHANGED',
    ],
    [basic, { replicas: 3 }, 'PREPARATION_NOT_FOUND'],
  ]) {
    const result = updateLocalRedundancyReplicas(source, options);
    assert.ok(codes(result).includes(expected), JSON.stringify(result.blockers));
    assert.equal(result.source, source);
  }
  const model = composeDocument(initial.source).model;
  model.services.web.volumes = ['new-state:/data'];
  const source = YAML.stringify(model),
    result = updateLocalRedundancyReplicas(source, {
      replicas: 3,
      confirmations: { statelessServices: ['web'] },
    });
  assert.ok(result.blockers.length);
  assert.equal(result.source, source);
  assert.equal(readLocalRedundancy('not: [yaml'), null);
});

test('resize upgrades old groups to routing health and supports internal-only groups', () => {
  const initial = planLocalRedundancy(basic, settings());
  const model = composeDocument(initial.source).model;
  delete model.services[initial.summary.proxyService].healthcheck;
  model.configs[initial.summary.configName].content = model.configs[
    initial.summary.configName
  ].content.split('frontend tracer_readiness')[0];
  const result = updateLocalRedundancyReplicas(YAML.stringify(model), {
    replicas: 3,
    confirmations: { statelessServices: ['web'] },
  });
  assert.deepEqual(result.blockers, []);
  assert.match(result.summary.haproxyConfig, /frontend tracer_readiness/);
  assert.ok(
    composeDocument(result.source).model.services[initial.summary.proxyService].healthcheck,
  );
  const internalSource = basic.replace("    ports: ['127.0.0.1:8080:80']\n", '');
  const internal = planLocalRedundancy(internalSource, settings({ endpoints: [] }));
  const resized = updateLocalRedundancyReplicas(internal.source, {
    replicas: 3,
    confirmations: { statelessServices: ['web'] },
  });
  assert.deepEqual(resized.blockers, []);
  assert.equal(resized.summary.proxyService, null);
  assert.equal(composeDocument(resized.source).model.services.web.deploy.replicas, 3);
});

test('regenerating the same count stamps changed inline config and preserves foreign labels', () => {
  const initial = planLocalRedundancy(basic, settings());
  const model = composeDocument(initial.source).model;
  const proxy = model.services[initial.summary.proxyService];
  const before = proxy.labels['io.docker-tracer.haproxy-config'];
  proxy.labels.custom = 'keep';
  model.configs[initial.summary.configName].content = model.configs[
    initial.summary.configName
  ].content.replace('uri /ready ', 'uri /live ');
  const result = updateLocalRedundancyReplicas(YAML.stringify(model), {
    replicas: 2,
    confirmations: { statelessServices: ['web'] },
  });
  assert.deepEqual(result.blockers, []);
  const after = composeDocument(result.source).model.services[initial.summary.proxyService];
  assert.notEqual(after.labels['io.docker-tracer.haproxy-config'], before);
  assert.equal(after.labels.custom, 'keep');
  const repeated = updateLocalRedundancyReplicas(result.source, {
    replicas: 2,
    confirmations: { statelessServices: ['web'] },
  });
  assert.equal(
    composeDocument(repeated.source).model.services[initial.summary.proxyService].labels[
      'io.docker-tracer.haproxy-config'
    ],
    after.labels['io.docker-tracer.haproxy-config'],
  );
});

test('port inventory accepts fixed short and long IPv4/IPv6 bindings without guessing protocol', () => {
  assert.equal(parseRedundancyPort('8080:80').publishedPort, 8080);
  assert.equal(parseRedundancyPort('[::1]:8080:80').hostIp, '::1');
  assert.equal(
    parseRedundancyPort({ target: 443, published: '8443', host_ip: '127.0.0.2' }).targetPort,
    443,
  );
  for (const value of [
    80,
    '80',
    '${PUBLIC}:80',
    '8000-8002:80',
    '0:80',
    '65536:80',
    '999.2.3.4:8080:80',
    '[not::ip]:8080:80',
    { target: 80 },
  ])
    assert.equal(parseRedundancyPort(value), null, String(value));
  const result = analyzeRedundancyNetwork(basic, ['web']);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.endpoints[0].protocol, null);
  assert.equal(result.endpoints[0].healthPath, null);
  assert.equal(result.endpoints[0].transportProtocol, 'tcp');
});

test('multiple services and targets receive unique listeners with exact public bindings', () => {
  const source = YAML.stringify({
    services: {
      web: {
        image: 'example/web:1',
        ports: [
          '127.0.0.1:8080:80',
          { target: 443, published: '8443', host_ip: '::1', app_protocol: 'https', name: 'tls' },
        ],
      },
      api: { image: 'example/api:1', ports: ['127.0.0.2:8080:80'] },
    },
  });
  const plan = planLocalRedundancy(
    source,
    settings({
      serviceNames: ['web', 'api'],
      confirmations: { statelessServices: ['web', 'api'] },
      endpoints: [
        endpoint,
        { service: 'web', targetPort: 443, publishedPort: 8443, protocol: 'tcp' },
        { ...endpoint, service: 'api' },
      ],
    }),
  );
  assert.deepEqual(plan.blockers, []);
  const model = composeDocument(plan.source).model;
  const ports = model.services[plan.summary.proxyService].ports;
  assert.deepEqual(
    ports.map((port) => port.target),
    [18080, 18081, 18082],
  );
  assert.deepEqual(
    ports.map((port) => [port.host_ip, port.published]),
    [
      ['127.0.0.1', '8080'],
      ['::1', '8443'],
      ['127.0.0.2', '8080'],
    ],
  );
  assert.equal(ports[1].app_protocol, 'https');
  assert.equal(ports[1].name, 'tls');
  assert.match(plan.summary.haproxyConfig, /frontend entry_2\n\s+bind :18081\n\s+mode tcp/);
  assert.ok(plan.warnings.some((item) => item.code === 'TCP_HEALTH_ONLY'));
});

test('explicit TCP passthrough leaves TLS at the backend and never invents HTTP health', () => {
  const source = basic.replace('8080:80', '8443:443');
  const plan = planLocalRedundancy(
    source,
    settings({
      endpoints: [{ service: 'web', targetPort: 443, publishedPort: 8443, protocol: 'tcp' }],
    }),
  );
  assert.deepEqual(plan.blockers, []);
  assert.match(plan.summary.haproxyConfig, /option tcp-check/);
  assert.doesNotMatch(plan.summary.haproxyConfig, /http-check|ssl|crt /);
  blocked(
    source,
    settings({
      endpoints: [
        { service: 'web', targetPort: 443, publishedPort: 8443, protocol: 'tcp', healthPath: '/' },
      ],
    }),
    'TCP_HEALTH_MISMATCH',
  );
});

test('unresolved and UDP ports are blocked without modifying the source', () => {
  blocked(basic.replace('127.0.0.1:8080:80', '${PORT}:80'), settings(), 'PORT_UNRESOLVED');
  blocked(basic.replace('127.0.0.1:8080:80', '8080:80/udp'), settings(), 'UDP_UNSUPPORTED');
  blocked(basic, settings({ endpoints: [] }), 'ENDPOINT_CONFIGURATION_REQUIRED');
  blocked(
    basic,
    settings({ endpoints: [{ ...endpoint, publishedPort: 9999 }] }),
    'ENDPOINT_CONFIGURATION_REQUIRED',
  );
  blocked(basic, settings({ endpoints: [endpoint, endpoint] }), 'ENDPOINT_CONFIGURATION_REQUIRED');
});

test('all source publications require their own explicit protocol decision', () => {
  const source = basic.replace(
    "['127.0.0.1:8080:80']",
    "['127.0.0.1:8080:80', '127.0.0.1:9000:9000']",
  );
  blocked(source, settings(), 'ENDPOINT_CONFIGURATION_REQUIRED');
  blocked(basic, settings({ endpoints: [{ ...endpoint, protocol: null }] }), 'PROTOCOL_REQUIRED');
  blocked(
    basic,
    settings({ endpoints: [{ ...endpoint, healthPath: undefined }] }),
    'INVALID_HEALTH_PATH',
  );
});

test('health configuration cannot inject HAProxy directives or Compose interpolation', () => {
  for (const healthPath of [
    '/\nbackend evil',
    '/ x',
    '/${SECRET}',
    '/"bad"',
    '/#comment',
    '/\\x',
    '/%[env(SECRET)]',
    'http://elsewhere/',
  ])
    blocked(basic, settings({ endpoints: [{ ...endpoint, healthPath }] }), 'INVALID_HEALTH_PATH');
  for (const healthHost of [
    'example\nbackend evil',
    '${SECRET}',
    'site example',
    'example#comment',
  ])
    blocked(basic, settings({ endpoints: [{ ...endpoint, healthHost }] }), 'INVALID_HEALTH_HOST');
  const safe = planLocalRedundancy(
    basic,
    settings({
      endpoints: [
        { ...endpoint, healthPath: '/ready?name=a%20b&full=1', healthHost: 'app.example:8080' },
      ],
    }),
  );
  assert.deepEqual(safe.blockers, []);
  assert.match(safe.summary.haproxyConfig, /hdr Host app\.example:8080/);
});

test('container_name and existing scale are adapted while names and depends_on survive', () => {
  const source = basic.replace(
    '    ports:',
    '    container_name: web-fixed\n    scale: 1\n    deploy:\n      resources:\n        limits:\n          memory: 128M\n    ports:',
  );
  const plan = planLocalRedundancy(source, settings());
  assert.deepEqual(plan.blockers, []);
  const web = composeDocument(plan.source).model.services.web;
  assert.ok(!Object.hasOwn(web, 'container_name'));
  assert.equal(web.scale, 2);
  assert.equal(web.deploy.resources.limits.memory, '128M');
  assert.ok(plan.warnings.some((item) => item.code === 'CONTAINER_NAME_REMOVED'));
});

test('anchor owners, merge-inherited container names and foreign aliases are preserved safely', () => {
  const source = `# anchor comment
x-base: &base
  image: example/web:1
  container_name: original
  ports: ['127.0.0.1:8080:80']
services:
  web:
    <<: *base
    environment: &env
      A: original
  other:
    image: example/other:1
    environment: *env
`;
  const before = composeDocument(source).model;
  const plan = planLocalRedundancy(source, settings());
  assert.deepEqual(plan.blockers, []);
  const after = composeDocument(plan.source).model;
  assert.ok(!after.services.web.container_name);
  assert.deepEqual(after.services.other, before.services.other);
  assert.deepEqual(after['x-base'], before['x-base']);
  assert.match(plan.source, /# anchor comment/);
  assert.deepEqual(after.services.web.ports, []);
});

test('service-level aliases are detached without changing the anchor owner', () => {
  const source = `x-base: &base
  image: example/web:1
  ports: ['127.0.0.1:8080:80']
services:
  web: *base
`;
  const plan = planLocalRedundancy(source, settings());
  assert.deepEqual(plan.blockers, []);
  const model = composeDocument(plan.source).model;
  assert.deepEqual(model['x-base'].ports, ['127.0.0.1:8080:80']);
  assert.deepEqual(model.services.web.ports, []);
});

test('scaling blockers cover special networking, profiles, source resolution and container references', () => {
  for (const [field, code] of [
    ['network_mode: host', 'NETWORK_MODE_UNSUPPORTED'],
    ['hostname: fixed', 'FIXED_IDENTITY'],
    ['profiles: [optional]', 'PROFILE_UNSUPPORTED'],
    ['build: .', 'SOURCE_RESOLUTION_REQUIRED'],
    ['extends: {service: base}', 'SOURCE_RESOLUTION_REQUIRED'],
    ['deploy: {mode: global}', 'DEPLOY_MODE_UNSUPPORTED'],
    ['deploy: {restart_policy: {condition: any}}', 'RESTART_POLICY_CONFLICT'],
    ['networks: {default: {ipv4_address: 172.20.0.2}}', 'FIXED_BACKEND_ADDRESS'],
  ])
    blocked(basic.replace('    ports:', `    ${field}\n    ports:`), settings(), code);
  blocked(`include: [other.yaml]\n${basic}`, settings(), 'INCLUDED_SOURCE_UNSUPPORTED');
  blocked(
    basic.replace('    volumes: [db:/var/lib/postgresql/data]', '    network_mode: service:web'),
    settings(),
    'SINGLE_CONTAINER_REFERENCE',
  );
  blocked(
    basic.replace('    volumes: [db:/var/lib/postgresql/data]', '    links: [web]'),
    settings(),
    'SINGLE_CONTAINER_REFERENCE',
  );
});

test('implicit network publication policies never silently widen host access', () => {
  const source =
    basic.replace('127.0.0.1:8080:80', '8080:80') +
    `networks:
  default:
    driver_opts:
      com.docker.network.bridge.host_binding_ipv4: 127.0.0.1
`;
  blocked(source, settings(), 'IMPLICIT_HOST_BINDING');
  const external =
    basic.replace('127.0.0.1:8080:80', '8080:80') + 'networks:\n  default:\n    external: true\n';
  blocked(external, settings(), 'IMPLICIT_HOST_BINDING');
});

test('duplicate public bindings and ambiguous caller input are rejected', () => {
  blocked(
    basic.replace(
      '    image: postgres:17',
      "    image: postgres:17\n    ports: ['0.0.0.0:8080:90']",
    ),
    settings(),
    'PUBLIC_PORT_CONFLICT',
  );
  blocked(basic, settings({ serviceNames: ['web', 'web'] }), 'INVALID_SELECTION');
  blocked(basic, settings({ serviceNames: ['web\nbackend evil'] }), 'INVALID_SELECTION');
  for (const replicas of [1, 5, 2.5, '2', NaN])
    blocked(basic, settings({ replicas }), 'INVALID_REPLICA_COUNT');
  blocked('not: [yaml', settings(), 'INVALID_COMPOSE');
});

test('generated resource names avoid collisions and a second click cannot duplicate the proxy', () => {
  const source =
    basic +
    'networks:\n  tracer-ha-backends: {}\nconfigs:\n  tracer-ha-config:\n    content: untouched\n';
  const plan = planLocalRedundancy(source, settings());
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.summary.networkName, 'tracer-ha-backends-2');
  assert.equal(plan.summary.configName, 'tracer-ha-config-2');
  const model = composeDocument(plan.source).model;
  assert.equal(model[LOCAL_REDUNDANCY_MARKER].version, 1);
  assert.equal(model.configs['tracer-ha-config'].content, 'untouched');
  blocked(plan.source, settings(), 'ALREADY_PREPARED');
});

test('internal-only services scale without creating an empty proxy, network or config', () => {
  const source = basic.replace("    ports: ['127.0.0.1:8080:80']\n", '');
  const plan = planLocalRedundancy(source, settings({ endpoints: [], replicas: 3 }));
  assert.deepEqual(plan.blockers, []);
  const model = composeDocument(plan.source).model;
  assert.deepEqual(Object.keys(model.services), ['web', 'database']);
  assert.equal(model.services.web.deploy.replicas, 3);
  assert.equal(model.services.web.restart, 'unless-stopped');
  assert.equal(model.services.web.networks, undefined);
  assert.equal(model.configs, undefined);
  assert.equal(model.networks, undefined);
  assert.equal(plan.summary.proxyService, null);
  assert.equal(plan.summary.haproxyConfig, null);
  assert.equal(plan.summary.image, null);
  assert.ok(plan.warnings.some((warning) => warning.code === 'INTERNAL_ONLY_SERVICE'));
  assert.equal(
    planLocalRedundancy(source, settings({ endpoints: undefined })).summary.applicable,
    true,
  );
});

test('mixed selection scales internal services while the proxy only depends on public services', () => {
  const source =
    basic.replace(
      '  database:',
      '  worker:\n    image: example/worker:1\n    networks: [private]\n  database:',
    ) + 'networks:\n  private: {}\n';
  const plan = planLocalRedundancy(
    source,
    settings({
      serviceNames: ['web', 'worker'],
      replicas: 4,
      confirmations: { statelessServices: ['web', 'worker'] },
    }),
  );
  assert.deepEqual(plan.blockers, []);
  const model = composeDocument(plan.source).model;
  assert.equal(model.services.web.deploy.replicas, 4);
  assert.equal(model.services.worker.deploy.replicas, 4);
  assert.deepEqual(model.services.worker.networks, ['private']);
  assert.deepEqual(Object.keys(model.services[plan.summary.proxyService].depends_on), ['web']);
  assert.match(plan.summary.haproxyConfig, /server-template replica 1-4 /);
  assert.equal(plan.summary.replicas, 4);
});

test('different services retain network isolation with one added bridge per public service', () => {
  const source = YAML.stringify({
    services: {
      web: {
        image: 'example/web:1',
        ports: ['127.0.0.1:8080:80'],
        networks: { first: { aliases: ['private-web'] } },
      },
      api: { image: 'example/api:1', ports: ['127.0.0.1:8081:80'], networks: ['second'] },
    },
    networks: { first: { internal: true }, second: { internal: true } },
  });
  const plan = planLocalRedundancy(
    source,
    settings({
      serviceNames: ['web', 'api'],
      confirmations: { statelessServices: ['web', 'api'] },
      endpoints: [endpoint, { ...endpoint, service: 'api', publishedPort: 8081 }],
    }),
  );
  assert.deepEqual(plan.blockers, []);
  const model = composeDocument(plan.source).model;
  const webNetworks = Object.keys(model.services.web.networks),
    apiNetworks = Object.keys(model.services.api.networks);
  assert.deepEqual(
    webNetworks.filter((name) => apiNetworks.includes(name)),
    [],
  );
  assert.deepEqual(model.services.web.networks.first.aliases, ['private-web']);
  assert.deepEqual(model.networks.first, { internal: true });
  assert.deepEqual(model.networks.second, { internal: true });
  assert.equal(plan.summary.networkNames.length, 2);
  assert.deepEqual(model.services[plan.summary.proxyService].networks, {
    [plan.summary.entryNetworkName]: { gw_priority: 1 },
    ...Object.fromEntries(plan.summary.networkNames.map((name) => [name, {}])),
  });
  for (const network of plan.summary.networkNames)
    assert.equal(model.networks[network].internal, true);
  assert.equal(model.networks[plan.summary.entryNetworkName].internal, undefined);
  assert.ok(!webNetworks.includes(plan.summary.entryNetworkName));
  assert.ok(!apiNetworks.includes(plan.summary.entryNetworkName));
  assert.equal(plan.summary.networkName, plan.summary.networkNames[0]);
  assert.deepEqual(model.services[plan.summary.proxyService].logging, {
    driver: 'local',
    options: { 'max-size': '10m', 'max-file': '3' },
  });
});
