import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFreshAiRedundancy, retiredAiReplicaContainers } from '../server/ai-redundancy-guard.mjs';

const marker = 'x-docker-tracer-ai-redundancy';
const base = () => ({
  record: { compose: {}, everDeployed: false },
  settings: { projectName: 'test', adopt: false },
  config: { [marker]: { version: 1 }, volumes: { data: { name: 'test_data' } } },
  actual: { containers: [], networks: [], volumes: [] },
  docker: {
    getVolume(name) {
      assert.equal(name, 'test_data');
      return {
        async inspect() {
          throw Object.assign(Error('missing'), { statusCode: 404 });
        },
      };
    },
  },
});
test('fresh AI preparation verifies actual volumes and does not create anything', async () => {
  await assertFreshAiRedundancy(base());
});
test('fresh AI preparation rejects existing resources, past deployment and adoption', async () => {
  for (const kind of ['containers', 'networks', 'volumes']) {
    const args = base();
    args.actual[kind].push({});
    await assert.rejects(assertFreshAiRedundancy(args), /installation neuve/);
  }
  const args = base();
  args.record.everDeployed = true;
  await assert.rejects(assertFreshAiRedundancy(args), /installation neuve/);
  args.record.everDeployed = false;
  args.settings.adopt = true;
  await assert.rejects(assertFreshAiRedundancy(args), /installation neuve/);
});
test('unlabelled existing volume and engine failures cannot become empty data', async () => {
  const args = base();
  args.docker.getVolume = () => ({
    async inspect() {
      return {};
    },
  });
  await assert.rejects(assertFreshAiRedundancy(args), /volume existe/);
  args.docker.getVolume = () => ({
    async inspect() {
      throw Error('engine stopped');
    },
  });
  await assert.rejects(assertFreshAiRedundancy(args), /Impossible de vérifier/);
});
test('already applied AI profile can evolve while first conversion cannot', async () => {
  const args = base();
  args.record.everDeployed = true;
  args.record.compose.lastApplied = { source: `services: {}\n${marker}: {version: 1}\n` };
  await assertFreshAiRedundancy(args);
});

test('reducing named AI replicas targets only generated secondary instances of this project', () => {
  const record = { compose: { projectName: 'owned', lastApplied: { source: `services: {}\n${marker}: {version: 1, services: [webui, webui-2, webui-3]}\n` } } };
  const container = (id, project, service) => ({ Id: id, Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service } } });
  const containers = [container('remove', 'owned', 'webui-3'), container('keep', 'owned', 'webui-2'), container('foreign', 'other', 'webui-3'), container('orphan', 'owned', 'user-extra'), container('primary', 'owned', 'webui')];
  assert.deepEqual(retiredAiReplicaContainers(record, { [marker]: {version: 1}, services: { webui: {}, 'webui-2': {} } }, { containers }).map((item) => item.Id), ['remove']);
});
