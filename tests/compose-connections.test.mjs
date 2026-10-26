import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeDocument,
  composeGraph,
  removeComposeObject,
  connectComposeNetwork,
} from '../shared/compose-project.mjs';
import {
  applyComposeConnection,
  composeConnectionTarget,
  composeConnectionChanges,
  connectionNetworkChoices,
  suggestedConnectionNetworkName,
} from '../shared/compose-connections.mjs';

const source = `# infrastructure existante
x-custom: {keep: true}
services:
  web:
    image: nginx:alpine
    labels: {keep: yes}
  api:
    image: alpine:3.23
    networks:
      private:
        aliases: [backend]
        priority: 42
        ipv4_address: 10.65.0.10
  observer:
    image: alpine:3.23
    network_mode: none
networks:
  private:
    driver: bridge
    ipam:
      config:
        - subnet: 10.65.0.0/24
          aux_addresses: {reserved: 10.65.0.50}
`;
const parse = (value) => composeDocument(value).model;

test('les réseaux réellement utilisés sont proposés avant les réseaux libres sans default inventé', () => {
  const model = {
    services: { web: { networks: ['front'] }, cache: { networks: ['back'] } },
    networks: { unused: {}, front: {}, back: {} },
  };
  const choices = connectionNetworkChoices(model, ['web', 'cache']);
  assert.deepEqual(
    choices.map((choice) => choice.name),
    ['front', 'back', 'unused'],
  );
  assert.deepEqual(choices[0].usedBy, ['web']);
  assert.equal(
    choices.some((choice) => choice.name === 'default'),
    false,
  );
  model.services.web.networks.push('back');
  assert.equal(connectionNetworkChoices(model, ['web', 'cache'])[0].name, 'back');
  assert.equal(connectionNetworkChoices(model, ['web', 'cache'])[0].common, true);
});

test('default reste disponible quand il est réellement utilisé et le nom de liaison est unique', () => {
  const model = {
    services: { web: {}, cache: { networks: ['private'] } },
    networks: { private: {}, 'web-cache': {}, 'web-cache-2': {} },
  };
  const choices = connectionNetworkChoices(model, ['web', 'cache']);
  assert.equal(choices[0].name, 'private');
  assert.equal(choices.find((choice) => choice.name === 'default').implicit, true);
  assert.equal(suggestedConnectionNetworkName(model, ['web', 'cache']), 'web-cache-3');
  const name = suggestedConnectionNetworkName(model, ['a'.repeat(70), 'cache']);
  assert.equal(name.length, 63);
  model.networks[name] = {};
  const next = suggestedConnectionNetworkName(model, ['a'.repeat(70), 'cache']);
  assert.equal(next.length, 63);
  assert.match(next, /-2$/);
});

test('le geste graphique accepte les deux directions et propose un réseau commun entre services', () => {
  assert.deepEqual(composeConnectionTarget(source, 'network:private', 'service:web'), {
    services: ['web'],
    network: 'private',
  });
  assert.deepEqual(composeConnectionTarget(source, 'service:web', 'service:api'), {
    services: ['web', 'api'],
    network: undefined,
  });
  assert.throws(() => composeConnectionTarget(source, 'service:web', 'service:web'), /différents/);
  assert.throws(
    () => composeConnectionTarget(source, 'network:default', 'network:private'),
    /routeur/,
  );
  assert.throws(() => composeConnectionTarget(source, 'host:local', 'host:ssh'), /service/);
  assert.throws(
    () => composeConnectionTarget(source, 'service:included', 'network:private'),
    /fichier principal/,
  );
  assert.throws(
    () => composeConnectionTarget(source, 'service:web', 'network:included'),
    /fichier principal/,
  );
});

test('créer un réseau commun conserve les connexions précédentes et toutes les options inconnues', () => {
  const next = applyComposeConnection(source, {
    services: ['web', 'api'],
    network: 'liaison',
    create: true,
  });
  const model = parse(next);
  assert.equal(model.networks.liaison.driver, 'bridge');
  assert.deepEqual(Object.keys(model.services.web.networks), ['default', 'liaison']);
  assert.deepEqual(Object.keys(model.services.api.networks), ['private', 'liaison']);
  assert.deepEqual(
    model.services.api.networks.private,
    parse(source).services.api.networks.private,
  );
  assert.deepEqual(model.services.web.labels, parse(source).services.web.labels);
  assert.deepEqual(model['x-custom'], { keep: true });
  assert.match(next, /# infrastructure existante/);
  assert.equal(composeGraph(next).edges.length, 4);
  assert.deepEqual(composeConnectionChanges(source, next), [
    'Créer le réseau liaison',
    'Connecter web à liaison',
    'Connecter api à liaison',
  ]);
  assert.equal(connectionNetworkChoices(model, ['web', 'api'])[0].name, 'liaison');
});

test('modifier un câble conserve les options de connexion inconnues et les autres services', () => {
  const next = applyComposeConnection(source, {
    services: ['api'],
    network: 'private',
    settings: { api: { aliases: ['new-alias'], ipv4_address: '10.65.0.11' } },
  });
  assert.deepEqual(parse(next).services.api.networks.private, {
    aliases: ['new-alias'],
    priority: 42,
    ipv4_address: '10.65.0.11',
  });
  assert.deepEqual(parse(next).services.web, parse(source).services.web);
  assert.deepEqual(composeConnectionChanges(source, next), [
    'Modifier les options de api sur private',
  ]);
  const cleared = applyComposeConnection(next, {
    services: ['api'],
    network: 'private',
    settings: { api: { aliases: [], ipv4_address: '' } },
  });
  assert.deepEqual(parse(cleared).services.api.networks.private, { priority: 42 });
});

test('déconnecter le dernier câble isole vraiment le service puis reconnecter sort du mode none', () => {
  const disconnected = applyComposeConnection(source, {
    services: ['api'],
    network: 'private',
    disconnect: true,
  });
  assert.equal(parse(disconnected).services.api.network_mode, 'none');
  assert.equal(parse(disconnected).services.api.networks, undefined);
  assert.equal(
    composeGraph(disconnected).edges.some((edge) => edge.source === 'service:api'),
    false,
  );
  const reconnected = applyComposeConnection(disconnected, {
    services: ['api'],
    network: 'private',
  });
  assert.equal(parse(reconnected).services.api.network_mode, undefined);
  assert.deepEqual(parse(reconnected).services.api.networks, { private: null });
  assert.throws(
    () =>
      applyComposeConnection(source, { services: ['web'], network: 'private', disconnect: true }),
    /pas connecté/,
  );
});

test('déconnecter un câble conserve les autres réseaux sans réactiver default', () => {
  const connected = applyComposeConnection(source, { services: ['api'], network: 'default' });
  const next = applyComposeConnection(connected, {
    services: ['api'],
    network: 'default',
    disconnect: true,
  });
  assert.deepEqual(parse(next).services.api, parse(source).services.api);
});

test('modes spéciaux, héritage et réseaux host ne produisent pas de faux câbles', () => {
  for (const mode of ['host', 'service:web', 'container:existing']) {
    const special = source.replace('network_mode: none', `network_mode: ${mode}`);
    assert.throws(
      () => composeConnectionTarget(special, 'service:observer', 'network:private'),
      /Change ce mode/,
    );
    assert.throws(
      () => applyComposeConnection(special, { services: ['observer'], network: 'private' }),
      /Change ce mode/,
    );
  }
  const inherited = source.replace(
    'network_mode: none',
    'extends: {file: other.yml, service: shared}',
  );
  assert.throws(
    () => composeConnectionTarget(inherited, 'service:observer', 'network:private'),
    /hérite/,
  );
  const host = source + '  hostnet: {external: true, name: host}\n';
  assert.throws(
    () => composeConnectionTarget(host, 'service:web', 'network:hostnet'),
    /mode réseau/,
  );
  assert.equal(
    connectionNetworkChoices(parse(host), ['web']).some((item) => item.name === 'hostnet'),
    false,
  );
});

test('les IP fixes invalides, dupliquées et réservées sont bloquées avant le brouillon', () => {
  for (const address of [
    'no-ip',
    '10.65.1.20',
    '10.65.0.0',
    '10.65.0.255',
    '10.65.0.1',
    '10.65.0.50',
    '10.65.0.10',
  ])
    assert.throws(() =>
      applyComposeConnection(source, {
        services: ['web'],
        network: 'private',
        settings: { web: { ipv4_address: address } },
      }),
    );
  assert.throws(
    () =>
      applyComposeConnection(source, {
        services: ['web'],
        network: 'default',
        settings: { web: { ipv4_address: '10.66.0.20' } },
      }),
    /plage IPv4/,
  );
  assert.throws(
    () =>
      applyComposeConnection(source, {
        services: ['web', 'observer'],
        network: 'private',
        settings: { web: { ipv4_address: '10.65.0.20' }, observer: { ipv4_address: '10.65.0.20' } },
      }),
    /déjà utilisée/,
  );
  assert.throws(
    () =>
      applyComposeConnection(source, {
        services: ['web'],
        network: 'private',
        settings: { web: { ipv6_address: 'bad' } },
      }),
    /IPv6 invalide/,
  );
});

test('les ancres et interpolations importées restent intactes pour les services non modifiés', () => {
  const anchored =
    'services:\n  one: &base\n    image: alpine:3.23\n    networks:\n      private: {ipv4_address: "${STATIC_IP}", priority: 10}\n  two: *base\nnetworks:\n  private: {}\n';
  const next = applyComposeConnection(anchored, {
    services: ['one'],
    network: 'private',
    settings: { one: { aliases: ['one'], ipv4_address: '${STATIC_IP}' } },
  });
  assert.deepEqual(parse(next).services.two, parse(anchored).services.two);
  assert.equal(parse(next).services.one.networks.private.priority, 10);
  assert.equal(parse(next).services.one.networks.private.ipv4_address, '${STATIC_IP}');
});

test('une création invalide ne remplace aucun réseau existant et les connexions identiques sont sans changement', () => {
  for (const network of ['default', 'private', 'bad name'])
    assert.throws(() =>
      applyComposeConnection(source, { services: ['web', 'api'], network, create: true }),
    );
  const next = applyComposeConnection(source, { services: ['api'], network: 'private' });
  assert.deepEqual(composeConnectionChanges(source, next), []);
});

test('les réseaux vides signifient default dans la carte et chaque édition de connexion', () => {
  for (const empty of ['[]', '{}', 'null']) {
    const input = `services:\n  web:\n    image: alpine:3.23\n    networks: ${empty}\nnetworks:\n  default: {}\n  other: {}\n`;
    assert.equal(composeGraph(input).edges[0].target, 'network:default');
    const next = applyComposeConnection(input, { services: ['web'], network: 'other' });
    assert.deepEqual(parse(next).services.web.networks, { default: null, other: null });
    assert.deepEqual(
      parse(connectComposeNetwork(input, 'web', 'other', true)).services.web.networks,
      { default: null, other: null },
    );
    assert.throws(() => removeComposeObject(input, 'networks', 'default'), /utilise encore/);
    const isolated = applyComposeConnection(input, {
      services: ['web'],
      network: 'default',
      disconnect: true,
    });
    assert.equal(parse(isolated).services.web.network_mode, 'none');
  }
});

test('une propriété héritée ne devient pas un service Compose fantôme', () => {
  assert.throws(
    () => composeConnectionTarget(source, 'service:constructor', 'service:web'),
    /absent du fichier principal/,
  );
});
