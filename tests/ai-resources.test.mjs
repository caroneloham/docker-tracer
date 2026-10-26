import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticAiResources } from '../shared/ai-resources.mjs';

const values = { gpuIds: ['GPU-a'], webRamGiB: 2, shmGiB: 3 };
const report = {
  cpus: 8,
  ramGiB: 15.2,
  hardware: { gpus: [{ uuid: 'GPU-a', index: '0', totalGiB: 15.9, freeGiB: 14.1 }] },
};
test('automatic allocation uses all Docker CPUs and available memory with reserves', () => {
  const result = automaticAiResources(report, values);
  assert.equal(result.inferenceCpus, 8);
  assert.equal(result.inferenceRamGiB, 11);
  assert.equal(result.gpuMemory, 0.82);
  assert.ok(result.gpuMemory * 15.9 <= 14.1 - 1);
  assert.ok(result.inferenceRamGiB + values.webRamGiB + 2 <= report.ramGiB);
  assert.equal(result.shmGiB, 3);
});
test('multiple GPUs use the most constrained available fraction', () => {
  const multi = {
    ...report,
    hardware: {
      gpus: [...report.hardware.gpus, { uuid: 'GPU-b', index: 1, totalGiB: 24, freeGiB: 8 }],
    },
  };
  const result = automaticAiResources(multi, { ...values, gpuIds: ['0', '1'] });
  assert.equal(result.gpuMemory, 0.28);
  assert.equal(result.vramGiB, 15.9);
});
test('missing, fully occupied or unknown GPU memory does not invent available resources', () => {
  for (const freeGiB of [null, undefined, 0, 2]) {
    const gpu = { ...report.hardware.gpus[0], freeGiB };
    assert.equal(automaticAiResources({ ...report, hardware: { gpus: [gpu] } }, values), null);
  }
  assert.equal(automaticAiResources(report, { ...values, gpuIds: ['GPU-missing'] }), null);
  assert.equal(automaticAiResources(report, { ...values, webRamGiB: 14 }), null);
});
test('large dedicated server still reserves system memory and GPU headroom', () => {
  const result = automaticAiResources(
    { cpus: 32, ramGiB: 128, hardware: { gpus: [{ uuid: 'GPU-a', totalGiB: 80, freeGiB: 80 }] } },
    { ...values, webRamGiB: 4 },
  );
  assert.equal(result.inferenceCpus, 32);
  assert.equal(result.inferenceRamGiB, 111);
  assert.equal(result.gpuMemory, 0.9);
});
