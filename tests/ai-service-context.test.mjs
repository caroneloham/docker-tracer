import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { detectAiServices, patchAiServiceSettings } from '../shared/ai-service-context.mjs';

const source = (services, extra = {}) => YAML.stringify({ ...extra, services });
const options = (service) =>
  Object.fromEntries(
    detectAiServices(source({ engine: service }))[0].options.map((item) => [item.key, item]),
  );

test('IA contextuelle : images exactes, moteurs renommés, plusieurs moteurs', () => {
  const found = detectAiServices(
    source({
      renamed: { image: 'docker.io/vllm/vllm-openai:v0.29.0@sha256:abcd' },
      other: { image: 'ollama/ollama:latest' },
      llama: { image: 'ghcr.io/ggml-org/llama.cpp:server-cuda' },
      local: { image: 'localai/localai:latest' },
      legacyLocal: { image: 'quay.io/go-skynet/local-ai:latest' },
      desktop: { image: 'lscr.io/linuxserver/lm-studio:latest' },
    }),
  );
  assert.deepEqual(
    found.map((item) => [item.name, item.type]),
    [
      ['renamed', 'vllm'],
      ['other', 'ollama'],
      ['llama', 'llamacpp'],
      ['local', 'localai'],
      ['legacyLocal', 'localai'],
      ['desktop', 'lmstudio'],
    ],
  );
  assert.ok(found.every((item) => item.modelInventoryKnown === false));
  assert.ok(found.at(-1).options.every((item) => !item.editable));
});

test('IA contextuelle : aucun faux positif de nom, métadonnées, proxy, endpoint ou image ressemblante', () => {
  assert.deepEqual(
    detectAiServices(
      source(
        {
          vllm: {
            image: 'postgres:17',
            environment: {
              OPENAI_BASE_URL: 'http://lmstudio:1234/v1',
              OLLAMA_HOST: 'http://ollama:11434',
            },
          },
          webui: { image: 'ghcr.io/open-webui/open-webui:ollama' },
          gateway: { image: 'ghcr.io/berriai/litellm:main-stable' },
          proxy: { image: 'caddy:2', labels: { 'ai.engine': 'vllm' } },
          fake: { image: 'evil.example/vllm/vllm-openai' },
          prefix: { image: 'vllm/vllm-openai-helper' },
          unverified: { image: 'lmstudio/llmster-preview' },
          variable: { image: '${AI_IMAGE}', command: ['--model', 'Qwen/Qwen3-8B'] },
          cli: { image: 'ghcr.io/ggml-org/llama.cpp:full' },
        },
        { 'x-docker-tracer-ai': { settings: { model: 'Qwen/Qwen3-8B' } } },
      ),
    ),
    [],
  );
  assert.deepEqual(detectAiServices({ 'x-docker-tracer-ai': { settings: {} }, services: {} }), []);
});

test('IA contextuelle : commandes de serveur reconnues sans supposer une image', () => {
  const services = {
    custom: {
      image: 'my/engine',
      command: ['vllm', 'serve', 'org/model', '--max-model-len', '8192'],
    },
    python: {
      image: 'custom/python',
      entrypoint: ['python3', '-m', 'vllm.entrypoints.openai.api_server'],
      command: ['--model', 'org/model'],
    },
    llama: { image: 'custom/llama', command: ['/app/llama-server', '-m', '/models/a.gguf'] },
    local: { image: 'custom/local', command: ['local-ai', 'run'] },
    studio: { image: 'custom/studio', command: ['lms', 'server', 'start', '--port', '1234'] },
    ollama: { image: 'custom/ollama', entrypoint: ['ollama'], command: ['serve'] },
  };
  const found = detectAiServices({ services });
  assert.equal(found.length, 6);
  assert.ok(found.every((item) => item.evidence === 'executable'));
  assert.equal(found[0].options.find((item) => item.key === 'model').value, 'org/model');
  assert.equal(found[4].options.find((item) => item.key === 'port').value, '1234');
  assert.deepEqual(
    detectAiServices({
      services: {
        log: { image: 'busybox', command: ['echo', 'vllm', 'serve'] },
        load: { image: 'ollama/ollama', command: ['pull', 'llama3'] },
        overridden: { image: 'vllm/vllm-openai', entrypoint: ['sleep', 'infinity'] },
        shell: { image: 'python:3', command: ['sh', '-c', 'echo vllm serve'] },
        status: { image: 'custom/studio', command: ['lms', 'server', 'status'] },
      },
    }),
    [],
  );
});

test('IA contextuelle : les options exposées appartiennent au moteur détecté', () => {
  const ollama = options({
    image: 'ollama/ollama',
    environment: ['OLLAMA_NUM_PARALLEL=3', 'EXTRA=keep'],
  });
  assert.equal(ollama.numParallel.value, '3');
  assert.equal(ollama.numParallel.source, 'environment');
  assert.equal(ollama.gpuMemoryUtilization, undefined);
  assert.equal(ollama.model, undefined);
  const llama = options({
    image: 'ghcr.io/ggml-org/llama.cpp:server',
    command: ['-c', '4096'],
    environment: { LLAMA_ARG_MODEL: '/model.gguf' },
  });
  assert.equal(llama.contextSize.value, '4096');
  assert.equal(llama.model.value, '/model.gguf');
  assert.equal(llama.model.source, 'environment');
  const local = options({ image: 'localai/localai', environment: { THREADS: '6' } });
  assert.equal(local.threads.value, '6');
  assert.equal(local.threads.location.name, 'THREADS');
});

test('IA contextuelle : patch ciblé préserve arguments inconnus, autres services et objets Compose', () => {
  const original = source(
    {
      inference: {
        image: 'vllm/vllm-openai:v0.29.0',
        command: [
          '--model',
          'org/old',
          '--max-model-len=4096',
          '--custom-json',
          '{"x": 1}',
          '--tensor-parallel-size',
          '2',
        ],
        environment: { SECRET: '${SECRET}', OTHER: 'keep' },
        networks: { isolated: { aliases: ['engine'] } },
        deploy: {
          resources: {
            reservations: { devices: [{ driver: 'nvidia', count: 1, capabilities: ['gpu'] }] },
          },
        },
        'x-custom': { unknown: true },
      },
      web: { image: 'nginx', command: ['unrelated'], volumes: ['data:/data'] },
    },
    {
      networks: { isolated: { internal: true } },
      volumes: { data: {} },
      'x-docker-tracer-ai': { historical: 'preserved' },
    },
  );
  const patched = patchAiServiceSettings(original, 'inference', {
    model: 'org/new',
    maxModelLen: '8192',
    tensorParallelSize: '',
  });
  const before = YAML.parse(original),
    after = YAML.parse(patched);
  assert.deepEqual(after.services.inference.command, [
    '--model',
    'org/new',
    '--max-model-len=8192',
    '--custom-json',
    '{"x": 1}',
  ]);
  delete before.services.inference.command;
  delete after.services.inference.command;
  assert.deepEqual(after, before);
});

test('IA contextuelle : modèle positionnel et arguments entrypoint gardent leur forme', () => {
  const original = source({
    engine: {
      image: 'custom',
      entrypoint: ['vllm', 'serve', 'org/a', '--max-model-len=4096'],
      command: ['--dtype', 'half'],
    },
  });
  const after = YAML.parse(
    patchAiServiceSettings(original, 'engine', {
      model: 'org/b',
      maxModelLen: '8192',
      dtype: 'bfloat16',
    }),
  );
  assert.deepEqual(after.services.engine.entrypoint, [
    'vllm',
    'serve',
    'org/b',
    '--max-model-len=8192',
  ]);
  assert.deepEqual(after.services.engine.command, ['--dtype', 'bfloat16']);
  assert.throws(() => patchAiServiceSettings(original, 'engine', { model: '' }), /positionnel/);
});

test('IA contextuelle : environnement liste ou objet conservé, variable inconnue intacte', () => {
  for (const environment of [
    ['INHERITED', 'OLLAMA_NUM_PARALLEL=2', 'UNRELATED=a=b'],
    { OLLAMA_NUM_PARALLEL: 2, UNRELATED: '${TOKEN}' },
  ]) {
    const original = source({ engine: { image: 'ollama/ollama', environment } });
    const after = YAML.parse(
      patchAiServiceSettings(original, 'engine', { numParallel: '4', contextLength: '8192' }),
    ).services.engine.environment;
    if (Array.isArray(environment))
      assert.deepEqual(after, [
        'INHERITED',
        'OLLAMA_NUM_PARALLEL=4',
        'UNRELATED=a=b',
        'OLLAMA_CONTEXT_LENGTH=8192',
      ]);
    else
      assert.deepEqual(after, {
        OLLAMA_NUM_PARALLEL: '4',
        UNRELATED: '${TOKEN}',
        OLLAMA_CONTEXT_LENGTH: '8192',
      });
  }
  const local = source({
    engine: { image: 'localai/localai', environment: ['THREADS=6', 'KEEP=1'] },
  });
  assert.deepEqual(
    YAML.parse(patchAiServiceSettings(local, 'engine', { threads: '8' })).services.engine
      .environment,
    ['THREADS=8', 'KEEP=1'],
  );
});

test('IA contextuelle : commandes texte et interpolations ne sont jamais réécrites graphiquement', () => {
  const stringCommand = source({
    engine: { image: 'vllm/vllm-openai', command: '--model org/model --max-model-len 4096' },
  });
  assert.equal(
    detectAiServices(stringCommand)[0].options.find((item) => item.key === 'model').value,
    'org/model',
  );
  assert.throws(
    () => patchAiServiceSettings(stringCommand, 'engine', { model: 'org/new' }),
    /texte/,
  );
  assert.throws(() => patchAiServiceSettings(stringCommand, 'engine', { dtype: 'half' }), /texte/);
  const interpolated = source({
    engine: { image: 'ollama/ollama', environment: { OLLAMA_NUM_PARALLEL: '${PARALLEL:-1}' } },
  });
  assert.throws(
    () => patchAiServiceSettings(interpolated, 'engine', { numParallel: '2' }),
    /variable Compose/,
  );
  const duplicates = source({
    engine: { image: 'vllm/vllm-openai', command: ['--model', 'a', '--model=b'] },
  });
  assert.throws(() => patchAiServiceSettings(duplicates, 'engine', { model: 'c' }), /Plusieurs/);
  const multi = source({
    engine: { image: 'vllm/vllm-openai', command: ['--served-model-name', 'a', 'b'] },
  });
  assert.throws(
    () => patchAiServiceSettings(multi, 'engine', { servedModelName: 'c' }),
    /plusieurs valeurs/,
  );
});

test('IA contextuelle : patch refuse services absents, options étrangères et valeurs invalides', () => {
  const original = source({ engine: { image: 'ollama/ollama' } });
  assert.throws(() => patchAiServiceSettings(original, 'removed', { numParallel: 2 }), /absent/);
  assert.throws(
    () => patchAiServiceSettings(original, 'engine', { model: 'a' }),
    /non pris en charge/,
  );
  assert.throws(
    () => patchAiServiceSettings(original, 'engine', { numParallel: -3 }),
    /hors limites/,
  );
  assert.throws(
    () => patchAiServiceSettings(original, 'engine', { numParallel: 1.2 }),
    /hors limites/,
  );
  assert.throws(
    () => patchAiServiceSettings(original, 'engine', { keepAlive: 'x\ny' }),
    /invalide/,
  );
});

test('IA contextuelle : modification d’une ancre ne change pas un autre service', () => {
  const original = `services:\n  first: &engine\n    image: vllm/vllm-openai\n    command: &args [--model, org/a, --max-model-len, '4096']\n    x-extra: preserve\n  alias: *engine\n  other:\n    image: vllm/vllm-openai\n    command: *args\n`;
  const after = YAML.parse(patchAiServiceSettings(original, 'first', { model: 'org/b' }));
  assert.equal(after.services.first.command[1], 'org/b');
  assert.equal(after.services.alias.command[1], 'org/a');
  assert.equal(after.services.other.command[1], 'org/a');
  assert.equal(after.services.first['x-extra'], 'preserve');
  const aliasPatch = YAML.parse(patchAiServiceSettings(original, 'alias', { model: 'org/c' }));
  assert.equal(aliasPatch.services.first.command[1], 'org/a');
  assert.equal(aliasPatch.services.alias.command[1], 'org/c');
});
