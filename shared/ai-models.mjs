const GiB = 1024 ** 3;
const mistralArgs = [
  '--tokenizer-mode',
  'mistral',
  '--config-format',
  'mistral',
  '--load-format',
  'mistral',
];

// Author checkpoints and vLLM 0.29.0 support checked on 2026-09-19.
// Bytes describe one checkpoint format, never the sum of duplicate HF/Mistral files.
// They exclude the KV cache, vision activations and execution buffers. See AI-MODELS.md.
const presets = [
  {
    model: 'Qwen/Qwen3-0.6B',
    family: 'Qwen',
    label: 'Qwen3 · 0.6B',
    description: 'Essai rapide et conversations simples',
    parametersB: 0.6,
    checkpointBytes: 1503300328,
    precision: 'BF16',
    vision: false,
    toolParser: 'hermes',
    verifiedRevision: 'c1899de289a04d12100db370d81485cdf75e47ca',
  },
  {
    model: 'Qwen/Qwen3-4B',
    family: 'Qwen',
    label: 'Qwen3 · 4B',
    description: 'Assistant texte compact',
    parametersB: 4,
    checkpointBytes: 8044982000,
    precision: 'BF16',
    vision: false,
    toolParser: 'hermes',
    verifiedRevision: '1cfa9a7208912126459214e8b04321603b3df60c',
  },
  {
    model: 'Qwen/Qwen3-8B',
    family: 'Qwen',
    label: 'Qwen3 · 8B',
    description: 'Assistant texte polyvalent',
    parametersB: 8,
    checkpointBytes: 16381516776,
    precision: 'BF16',
    vision: false,
    toolParser: 'hermes',
    verifiedRevision: 'b968826d9c46dd6066d109eabc6255188de91218',
  },
  {
    model: 'Qwen/Qwen3-VL-2B-Instruct',
    family: 'Qwen',
    label: 'Qwen3 VL · 2B',
    description: 'Texte et images avec un petit modèle',
    parametersB: 2,
    checkpointBytes: 4255140312,
    precision: 'BF16',
    vision: true,
    toolParser: 'hermes',
    verifiedRevision: '89644892e4d85e24eaac8bacfd4f463576704203',
  },
  {
    model: 'Qwen/Qwen3-VL-4B-Instruct',
    family: 'Qwen',
    label: 'Qwen3 VL · 4B',
    description: 'Analyse d’images et conversation',
    parametersB: 4,
    checkpointBytes: 8875719344,
    precision: 'BF16',
    vision: true,
    toolParser: 'hermes',
    verifiedRevision: 'ebb281ec70b05090aa6165b016eac8ec08e71b17',
  },
  {
    model: 'mistralai/Ministral-3-3B-Instruct-2512',
    family: 'Mistral',
    label: 'Ministral 3 · 3B',
    description: 'Texte et images, format compact FP8',
    parametersB: 3.8,
    checkpointBytes: 4672089108,
    precision: 'FP8',
    vision: true,
    toolParser: 'mistral',
    vllmArgs: mistralArgs,
    verifiedRevision: 'b35d4dfe56c142746f54dbd64f579faab2744308',
  },
  {
    model: 'mistralai/Ministral-3-8B-Instruct-2512',
    family: 'Mistral',
    label: 'Ministral 3 · 8B',
    description: 'Assistant visuel polyvalent en FP8',
    parametersB: 8.8,
    checkpointBytes: 10420633176,
    precision: 'FP8',
    vision: true,
    toolParser: 'mistral',
    vllmArgs: mistralArgs,
    verifiedRevision: '5b26027e7b19eeb4b7352e1fed3926375dd2cb4d',
  },
  {
    model: 'mistralai/Ministral-3-14B-Instruct-2512',
    family: 'Mistral',
    label: 'Ministral 3 · 14B',
    description: 'Texte et images pour un GPU plus grand',
    parametersB: 13.9,
    checkpointBytes: 15726706472,
    precision: 'FP8',
    vision: true,
    toolParser: 'mistral',
    vllmArgs: mistralArgs,
    verifiedRevision: '29439f81c2be264d8d393273f99e7db9c0961120',
  },
  {
    model: 'mistralai/Mistral-7B-Instruct-v0.3',
    family: 'Mistral',
    label: 'Mistral · 7B',
    description: 'Conversation et outils, texte uniquement',
    parametersB: 7,
    checkpointBytes: 14496078512,
    precision: 'BF16',
    vision: false,
    toolParser: 'mistral',
    vllmArgs: mistralArgs,
    verifiedRevision: 'c170c708c41dac9275d15a8fff4eca08d52bab71',
  },
  {
    model: 'mistralai/Mistral-Small-3.2-24B-Instruct-2506',
    family: 'Mistral',
    label: 'Mistral Small 3.2 · 24B',
    description: 'Texte et images pour un serveur à grande VRAM',
    parametersB: 24,
    checkpointBytes: 48022792280,
    precision: 'BF16',
    vision: true,
    toolParser: 'mistral',
    vllmArgs: mistralArgs,
    verifiedRevision: '95a6d26c4bfb886c58daf9d3f7332c857cb27b43',
  },
];

export const AI_MODEL_PRESETS = Object.freeze(
  presets.map((preset) =>
    Object.freeze({
      ...preset,
      id: preset.model,
      weightGiB: Math.round((preset.checkpointBytes / GiB) * 10) / 10,
      sourceUrl: `https://huggingface.co/${preset.model}`,
      vllmArgs: Object.freeze([...(preset.vllmArgs || [])]),
    }),
  ),
);

const byModel = new Map(AI_MODEL_PRESETS.map((preset) => [preset.model, preset]));

export function findAiModel(model) {
  return byModel.get(model);
}

export function aiModelVllmArgs(model) {
  return [...(findAiModel(model)?.vllmArgs || [])];
}

export function aiModelWeightGiB(model, parametersB) {
  const preset = findAiModel(model);
  return preset ? preset.checkpointBytes / GiB : (parametersB * 1e9 * 2) / GiB;
}
