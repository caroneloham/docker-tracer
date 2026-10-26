import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_MODEL_PRESETS,
  findAiModel,
  aiModelVllmArgs,
  aiModelWeightGiB,
} from '../shared/ai-models.mjs';

test('IA : le catalogue distingue cinq Qwen et cinq Mistral avec vision explicite', () => {
  assert.equal(new Set(AI_MODEL_PRESETS.map((model) => model.model)).size, 10);
  for (const family of ['Qwen', 'Mistral']) {
    const models = AI_MODEL_PRESETS.filter((model) => model.family === family);
    assert.equal(models.length, 5);
    assert.ok(models.some((model) => model.vision === true));
    assert.ok(models.some((model) => model.vision === false));
  }
  assert.equal(findAiModel('Qwen/Qwen3-8B').vision, false);
  assert.equal(findAiModel('Qwen/Qwen3-VL-2B-Instruct').vision, true);
  assert.equal(findAiModel('mistralai/Mistral-7B-Instruct-v0.3').vision, false);
});

test('IA : les poids FP8 incluent les composants BF16 et ne sont pas comptés deux fois', () => {
  const model = 'mistralai/Ministral-3-8B-Instruct-2512';
  const estimated = aiModelWeightGiB(model, 8.8);
  assert.ok(estimated > 9.7 && estimated < 9.8);
  assert.equal(findAiModel(model).precision, 'FP8');
  assert.ok(estimated > (8.8 * 1e9) / 1024 ** 3);
  assert.ok(estimated < (8.8 * 1e9 * 2) / 1024 ** 3);
  assert.ok(aiModelWeightGiB('Qwen/Qwen3-VL-4B-Instruct', 4) > 8.2);
});

test('IA : le format Mistral est appliqué uniquement aux références connues', () => {
  for (const preset of AI_MODEL_PRESETS.filter((model) => model.family === 'Mistral')) {
    assert.deepEqual(aiModelVllmArgs(preset.model), [
      '--tokenizer-mode',
      'mistral',
      '--config-format',
      'mistral',
      '--load-format',
      'mistral',
    ]);
    assert.equal(preset.toolParser, 'mistral');
  }
  assert.deepEqual(aiModelVllmArgs('Qwen/Qwen3-4B'), []);
  assert.deepEqual(aiModelVllmArgs('mistralai/Mon-modele-personnalise'), []);
  assert.equal(findAiModel('mistralai/Mon-modele-personnalise'), undefined);
  assert.equal(aiModelWeightGiB('client/custom', 3), (3 * 1e9 * 2) / 1024 ** 3);
});

test('IA : un appelant ne peut pas modifier les arguments du catalogue partagé', () => {
  const model = 'mistralai/Ministral-3-3B-Instruct-2512';
  aiModelVllmArgs(model).push('--trust-remote-code');
  assert.equal(aiModelVllmArgs(model).includes('--trust-remote-code'), false);
  assert.ok(AI_MODEL_PRESETS.every((preset) => Object.isFrozen(preset)));
});
