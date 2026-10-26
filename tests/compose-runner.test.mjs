import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { composeEnvironment, createComposeRunner } from '../server/compose-runner.mjs';

const source = `services:
  app:
    image: example/app:1
  optional:
    image: example/large:1
    profiles: [optional]
`;

test('Compose : les profils ambiants sont neutralisés et ne peuvent pas devenir des variables applicatives', () => {
  const original = process.env.COMPOSE_PROFILES;
  process.env.COMPOSE_PROFILES = 'optional';
  try {
    const env = composeEnvironment({ APP_VALUE: 'retained' });
    assert.equal(Object.hasOwn(env, 'COMPOSE_PROFILES'), true);
    assert.equal(env.COMPOSE_PROFILES, '');
    assert.equal(env.APP_VALUE, 'retained');
    assert.throws(() => composeEnvironment({ COMPOSE_PROFILES: 'optional' }), /réservée/);
  } finally {
    if (original === undefined) delete process.env.COMPOSE_PROFILES;
    else process.env.COMPOSE_PROFILES = original;
  }
});

test('Compose local : .env reste utilisable, seuls les profils choisis sont transmis au lancement', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dtr-compose-profiles-')),
    calls = [],
    spawnMock = t.mock.method(childProcess, 'spawn', (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      queueMicrotask(() => {
        child.stdout.end('{}');
        child.stderr.end();
        child.exitCode = 0;
        child.emit('close', 0);
      });
      return child;
    });
  syncBuiltinESMExports();
  const runner = createComposeRunner({
    dataDir: dir,
    hosts: { client: async () => ({ modem: { getSocketPath: async () => '/test-only.sock' } }) },
  });
  try {
    const envPath = path.join(dir, '.env');
    await writeFile(envPath, 'COMPOSE_PROFILES=optional\nAPP_FROM_DOTENV=retained\n');
    for (const profiles of [[], ['chosen', 'second']]) {
      await runner.withProject(
        { source, projectName: 'profile-test', directory: dir, useDotEnv: true, profiles },
        'local',
        ({ run }) => run(['config', '--format', 'json']),
      );
      const { command, args, options } = calls.at(-1);
      assert.equal(command, 'docker');
      assert.equal(options.shell, false);
      assert.equal(args[args.indexOf('--env-file') + 1], envPath);
      // Compose gives process environment precedence over .env, including an empty value.
      assert.equal(Object.hasOwn(options.env, 'COMPOSE_PROFILES'), true);
      assert.equal(options.env.COMPOSE_PROFILES, '');
      const selected = args.flatMap((arg, index) => (arg === '--profile' ? [args[index + 1]] : []));
      assert.deepEqual(selected, profiles);
    }
    assert.equal(
      await readFile(envPath, 'utf8'),
      'COMPOSE_PROFILES=optional\nAPP_FROM_DOTENV=retained\n',
    );
  } finally {
    spawnMock.mock.restore();
    syncBuiltinESMExports();
    await runner.shutdown();
    if (
      path.dirname(dir) !== os.tmpdir() ||
      !path.basename(dir).startsWith('dtr-compose-profiles-')
    )
      throw Error('Unexpected fixture path');
    await rm(dir, { recursive: true, force: true });
  }
});

test('Compose SSH : la commande isolée neutralise les profils .env et conserve les choix explicites', async (t) => {
  const scripts = [];
  class FakeSshClient extends EventEmitter {
    connect() {
      queueMicrotask(() => this.emit('ready'));
    }
    exec(command, callback) {
      assert.equal(command, 'sh -s');
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.end = (script) => {
        scripts.push(script);
        queueMicrotask(() => stream.emit('close', 0));
      };
      callback(null, stream);
    }
    destroy() {}
  }
  t.mock.method(ssh2, 'Client', function () {
    return new FakeSshClient();
  });
  const runner = createComposeRunner({
    dataDir: os.tmpdir(),
    hosts: { sshOptions: async () => ({ host: 'never-connected.invalid' }) },
  });
  try {
    for (const profiles of [[], ['chosen', 'second']]) {
      await runner.withProject(
        {
          source,
          projectName: 'profile-test',
          directory: '/srv/profile-test',
          useDotEnv: true,
          profiles,
          variables: { APP_VALUE: 'retained' },
        },
        'test-host',
        ({ run, settings }) => {
          assert.equal(Object.hasOwn(settings.variables, 'COMPOSE_PROFILES'), false);
          return run(['config', '--format', 'json']);
        },
      );
      const script = scripts.at(-1);
      assert.match(script, /env -i PATH=/);
      assert.match(script, /'COMPOSE_PROFILES='/);
      assert.match(script, /'APP_VALUE=retained'/);
      assert.match(script, /--env-file "\$directory\/\.env"/);
      const selected = [...script.matchAll(/'--profile' '([^']+)'/g)].map((match) => match[1]);
      assert.deepEqual(selected, profiles);
    }
  } finally {
    await runner.shutdown();
  }
});
