import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { buildAiCompose, defaultAiSettings, newAiSecrets } from '../shared/ai-infrastructure.mjs';

test('initial administrator password can be simple without weakening internal keys', () => {
  const variables = { ...newAiSecrets(), AI_ADMIN_PASSWORD: 'bonjour1' };
  const compose = buildAiCompose(defaultAiSettings(), variables, 'password-test');
  assert.equal(compose.variables.AI_ADMIN_PASSWORD, 'bonjour1');
  assert.equal(
    YAML.parse(compose.source).services.webui.environment.WEBUI_ADMIN_PASSWORD,
    '${AI_ADMIN_PASSWORD}',
  );
  assert.ok(!compose.source.includes('bonjour1'));
  for (const key of ['AI_DB_PASSWORD', 'AI_ENGINE_KEY', 'AI_WEBUI_SECRET']) {
    assert.throws(() =>
      buildAiCompose(defaultAiSettings(), { ...variables, [key]: 'bonjour1' }, 'password-test'),
    );
  }
  for (const password of ['', '1234567', 'bonjour\n1', 'bonjour\t1', 'x'.repeat(73)]) {
    assert.throws(
      () =>
        buildAiCompose(
          defaultAiSettings(),
          { ...variables, AI_ADMIN_PASSWORD: password },
          'password-test',
        ),
      /Mot de passe initial/,
    );
  }
});
