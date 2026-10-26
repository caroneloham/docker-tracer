import YAML from 'yaml';
import { composeDocument } from './compose-project.mjs';

// These are explicit Compose settings, never measurements or live model inventory.
// Keep option names aligned with the primary documentation linked per engine.
const flag = (key, label, flags, extra = {}) => ({ key, label, type: 'text', flags, ...extra });
const env = (key, label, names, extra = {}) => ({ key, label, type: 'text', env: names, ...extra });
export const AI_SERVICE_ENGINES = {
  vllm: {
    label: 'vLLM',
    documentation: 'https://docs.vllm.ai/en/stable/cli/serve/',
    note: 'Modèle et limites déclarés au démarrage. La mémoire disponible dépend du serveur.',
    options: [
      flag('model', 'Modèle ou dossier local', ['--model']),
      flag('servedModelName', 'Nom exposé par l’API', ['--served-model-name'], { multiple: true }),
      flag('maxModelLen', 'Contexte maximal', ['--max-model-len'], {
        hint: 'Valeur acceptée par cette version de vLLM, par exemple 8192 ou auto.',
      }),
      flag(
        'gpuMemoryUtilization',
        'Part de mémoire GPU',
        ['--gpu-memory-utilization', '--device-memory-utilization'],
        { type: 'number', min: 0, max: 1, step: 0.01 },
      ),
      flag('tensorParallelSize', 'Parallélisme tensoriel', ['--tensor-parallel-size', '-tp'], {
        type: 'number',
        min: 1,
        integer: true,
      }),
      flag('maxNumSeqs', 'Séquences simultanées', ['--max-num-seqs'], {
        type: 'number',
        min: 1,
        integer: true,
      }),
      flag('dtype', 'Précision des poids', ['--dtype'], {
        hint: 'Exemples selon la version : auto, half, bfloat16.',
      }),
      flag('quantization', 'Quantification', ['--quantization', '-q']),
      flag('revision', 'Révision du modèle', ['--revision']),
    ],
  },
  ollama: {
    label: 'Ollama',
    documentation: 'https://docs.ollama.com/faq',
    note: 'Les modèles installés et chargés ne sont pas décrits par le Compose. Ces limites s’appliquent au serveur Ollama.',
    options: [
      env('contextLength', 'Contexte par défaut', ['OLLAMA_CONTEXT_LENGTH'], {
        type: 'number',
        min: 1,
        integer: true,
      }),
      env('numParallel', 'Requêtes parallèles par modèle', ['OLLAMA_NUM_PARALLEL'], {
        type: 'number',
        min: 1,
        integer: true,
      }),
      env('maxLoadedModels', 'Modèles chargés simultanément', ['OLLAMA_MAX_LOADED_MODELS'], {
        type: 'number',
        min: 1,
        integer: true,
      }),
      env('maxQueue', 'Requêtes en attente', ['OLLAMA_MAX_QUEUE'], {
        type: 'number',
        min: 1,
        integer: true,
      }),
      env('keepAlive', 'Durée de maintien en mémoire', ['OLLAMA_KEEP_ALIVE'], {
        hint: 'Exemples : 5m, 0, -1. Les requêtes API peuvent remplacer cette valeur.',
      }),
      env('modelsPath', 'Dossier des modèles dans le conteneur', ['OLLAMA_MODELS']),
      env('host', 'Adresse d’écoute du serveur', ['OLLAMA_HOST']),
    ],
  },
  llamacpp: {
    label: 'llama.cpp',
    documentation: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
    note: 'Les options dépendent de la version de llama-server. Le chemin du modèle est interne au conteneur.',
    options: [
      flag('model', 'Fichier du modèle', ['--model', '-m'], { env: ['LLAMA_ARG_MODEL'] }),
      flag('contextSize', 'Taille du contexte', ['--ctx-size', '-c'], {
        env: ['LLAMA_ARG_CTX_SIZE'],
        type: 'number',
        min: 0,
        integer: true,
      }),
      flag('gpuLayers', 'Couches placées sur le GPU', ['--gpu-layers', '--n-gpu-layers', '-ngl'], {
        env: ['LLAMA_ARG_N_GPU_LAYERS'],
        hint: 'Nombre de couches, auto ou all selon la version.',
      }),
      flag('threads', 'Threads CPU', ['--threads', '-t'], {
        env: ['LLAMA_ARG_THREADS'],
        type: 'number',
        min: 1,
        integer: true,
      }),
      flag('parallel', 'Créneaux parallèles', ['--parallel', '-np'], {
        env: ['LLAMA_ARG_N_PARALLEL'],
        type: 'number',
        min: 1,
        integer: true,
      }),
      flag('batchSize', 'Taille maximale des lots', ['--batch-size', '-b'], {
        env: ['LLAMA_ARG_BATCH'],
        type: 'number',
        min: 1,
        integer: true,
      }),
    ],
  },
  localai: {
    label: 'LocalAI',
    documentation: 'https://localai.io/docs/reference/cli-reference/',
    note: 'Les fichiers de configuration des modèles peuvent remplacer ces valeurs globales. Leur contenu n’est pas lu ici.',
    options: [
      flag('modelsPath', 'Dossier des modèles', ['--models-path'], {
        env: ['LOCALAI_MODELS_PATH', 'MODELS_PATH'],
      }),
      flag('threads', 'Threads CPU par défaut', ['--threads', '-t'], {
        env: ['LOCALAI_THREADS', 'THREADS'],
        type: 'number',
        min: 1,
        integer: true,
      }),
      flag('contextSize', 'Contexte par défaut', ['--context-size'], {
        env: ['LOCALAI_CONTEXT_SIZE', 'CONTEXT_SIZE'],
        type: 'number',
        min: -1,
        integer: true,
      }),
      flag('address', 'Adresse d’écoute', ['--address'], { env: ['LOCALAI_ADDRESS', 'ADDRESS'] }),
    ],
  },
  lmstudio: {
    label: 'LM Studio',
    documentation: 'https://lmstudio.ai/docs/cli/serve/server-start',
    note: 'LM Studio fonctionne aussi hors Docker. Seul le service déclaré ici est identifié ; les modèles chargés restent inconnus.',
    options: [
      flag('port', 'Port du serveur lms', ['--port'], {
        type: 'number',
        min: 1,
        max: 65535,
        integer: true,
      }),
      flag('bind', 'Adresse d’écoute du serveur lms', ['--bind'], { env: ['LMS_SERVER_HOST'] }),
    ],
  },
};

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const baseName = (value) =>
  String(value || '')
    .replaceAll('\\', '/')
    .split('/')
    .at(-1);
const variable = (value) => typeof value === 'string' && /\$\{|\$[A-Za-z_]/.test(value);
function tokens(value, field) {
  if (value == null) return [];
  if (Array.isArray(value))
    return value.map((value, index) => ({
      value: String(value),
      field,
      index,
      editable: typeof value === 'string',
    }));
  // Read a simple string only to identify an executable. Never reserialize shell syntax.
  if (typeof value !== 'string' || /[\n\r;&|<>`$\\]/.test(value)) return null;
  const parts = value.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g) || [];
  if (parts.join('').replace(/["']/g, '') !== value.replace(/\s|["']/g, '')) return null;
  return parts.map((part, index) => ({
    value: part.replace(/^(['"])(.*)\1$/, '$2'),
    field,
    index,
    editable: false,
  }));
}

function imageEngine(image) {
  if (typeof image !== 'string' || variable(image)) return null;
  const withoutDigest = image.toLowerCase().split('@')[0];
  const colon = withoutDigest.lastIndexOf(':');
  const hasTag = colon > withoutDigest.lastIndexOf('/');
  const tag = hasTag ? withoutDigest.slice(colon + 1) : '';
  const repo = (hasTag ? withoutDigest.slice(0, colon) : withoutDigest).replace(
    /^(?:docker\.io|index\.docker\.io)\//,
    '',
  );
  if (repo === 'vllm/vllm-openai') return 'vllm';
  if (repo === 'ollama/ollama') return 'ollama';
  if (['localai/localai', 'quay.io/go-skynet/local-ai'].includes(repo)) return 'localai';
  if (
    ['ghcr.io/ggml-org/llama.cpp', 'ghcr.io/ggerganov/llama.cpp'].includes(repo) &&
    /^server(?:-|$)/.test(tag)
  )
    return 'llamacpp';
  // Maintainer-provided desktop image, not an official LM Studio publisher image.
  if (repo === 'lscr.io/linuxserver/lm-studio') return 'lmstudio';
  return null;
}

function executableEngine(argv) {
  if (!argv?.length) return null;
  const values = argv.map((t) => t.value);
  const executable = baseName(values[0]);
  if (executable === 'vllm' && values[1] === 'serve')
    return { type: 'vllm', prefix: 2, positionalModel: true };
  if (
    /^python(?:3(?:\.\d+)?)?$/.test(executable) &&
    values[1] === '-m' &&
    values[2] === 'vllm.entrypoints.openai.api_server'
  )
    return { type: 'vllm', prefix: 3 };
  if (executable === 'ollama' && values[1] === 'serve') return { type: 'ollama', prefix: 2 };
  if (executable === 'llama-server') return { type: 'llamacpp', prefix: 1 };
  if (executable === 'local-ai' && (!values[1] || values[1] === 'run' || values[1].startsWith('-')))
    return { type: 'localai', prefix: values[1] === 'run' ? 2 : 1 };
  if (executable === 'lms' && values[1] === 'server' && values[2] === 'start')
    return { type: 'lmstudio', prefix: 3, lmsServer: true };
  if (executable === 'llmster') return { type: 'lmstudio', prefix: 1 };
  return null;
}

function serviceContext(service) {
  const entry = tokens(service.entrypoint, 'entrypoint');
  const command = tokens(service.command, 'command');
  const argv = entry && command ? [...entry, ...command] : null;
  const executable = executableEngine(argv);
  if (executable) return { ...executable, argv, evidence: 'executable' };
  const type = imageEngine(service.image);
  if (!type) return null;
  // An overridden executable does not prove that the image's inference server runs.
  if (service.entrypoint != null || !command) return null;
  const first = command[0]?.value;
  if (
    first &&
    !first.startsWith('-') &&
    !(type === 'ollama' && first === 'serve') &&
    !(type === 'localai' && first === 'run')
  )
    return null;
  return {
    type,
    argv: command,
    prefix: ['serve', 'run'].includes(first) ? 1 : 0,
    evidence: 'image',
    desktop: type === 'lmstudio',
  };
}

function environmentEntries(environment) {
  if (Array.isArray(environment))
    return environment.map((item, index) => {
      const equal = item.indexOf('=');
      return {
        name: equal < 0 ? item : item.slice(0, equal),
        value: equal < 0 ? null : item.slice(equal + 1),
        index,
      };
    });
  return Object.entries(environment || {}).map(([name, value]) => ({ name, value }));
}

function flagLocations(context, definition) {
  const result = [];
  for (let index = context.prefix; index < context.argv.length; index++) {
    const token = context.argv[index];
    if (token.value === '--') break;
    const equal = token.value.indexOf('=');
    const name = equal < 0 ? token.value : token.value.slice(0, equal);
    if (!definition.flags?.includes(name)) continue;
    const next = context.argv[index + 1];
    const inline = equal >= 0;
    const hasValue = inline || (next && (!next.value.startsWith('-') || /^-\d/.test(next.value)));
    const multiple =
      definition.multiple &&
      hasValue &&
      !inline &&
      context.argv[index + 2] &&
      !context.argv[index + 2].value.startsWith('-');
    result.push({
      field: token.field,
      index: token.index,
      flag: name,
      inline,
      value: inline ? token.value.slice(equal + 1) : hasValue ? next.value : null,
      length: inline ? 1 : hasValue ? 2 : 1,
      editable:
        token.editable &&
        hasValue &&
        !multiple &&
        (inline || (next.editable && token.field === next.field)),
      reason: multiple
        ? 'Cette option contient plusieurs valeurs. Modifie la configuration complète.'
        : !hasValue
          ? 'Argument sans valeur explicite.'
          : undefined,
    });
  }
  if (definition.key === 'model' && context.positionalModel) {
    const token = context.argv[context.prefix];
    if (token && !token.value.startsWith('-'))
      result.push({ ...token, length: 1, positional: true });
  }
  return result;
}

function describeOption(service, context, definition) {
  const locations = flagLocations(context, definition);
  const envEntries = environmentEntries(service.environment).filter((entry) =>
    definition.env?.includes(entry.name),
  );
  const argument = locations[0];
  const environment = envEntries[0];
  const ambiguous = locations.length > 1 || (!argument && envEntries.length > 1);
  const location =
    argument ||
    (environment
      ? { field: 'environment', ...environment, editable: environment.value !== null }
      : null);
  let source = location?.field || (definition.flags ? 'command' : 'environment');
  const value = location?.value ?? '';
  let reason = '';
  if (context.type === 'lmstudio' && !context.lmsServer)
    reason =
      'Le serveur lms n’est pas déclaré dans la commande. Configure le modèle dans LM Studio.';
  else if (ambiguous)
    reason =
      'Plusieurs déclarations existent pour cette option. Modifie la configuration complète.';
  else if (variable(value))
    reason =
      'Valeur provenant d’une variable Compose. Modifie cette variable ou la configuration complète.';
  else if (location && !location.editable)
    reason =
      location.reason || 'Commande texte ou valeur héritée. Modifie la configuration complète.';
  else if (
    !location &&
    definition.flags &&
    (typeof service.command === 'string' || typeof service.entrypoint === 'string')
  )
    reason = 'Commande texte conservée. Modifie la configuration complète.';
  else if (!location && definition.flags && context.argv.some((t) => t.value === '--'))
    reason = 'Séparateur d’arguments présent. Modifie la configuration complète.';
  return {
    ...definition,
    value,
    explicit: !!location,
    source,
    location,
    editable: !reason,
    reason,
  };
}

/** Detect existing main-file services from a Compose YAML string, draft, or model. */
export function detectAiServices(input) {
  let model = input;
  if (typeof input === 'string') model = composeDocument(input).model;
  else if (typeof input?.source === 'string') model = composeDocument(input.source).model;
  if (!object(model?.services)) return [];
  return Object.entries(model.services).flatMap(([name, service]) => {
    if (!object(service)) return [];
    const context = serviceContext(service);
    if (!context) return [];
    const engine = AI_SERVICE_ENGINES[context.type];
    return [
      {
        name,
        serviceName: name,
        type: context.type,
        label: engine.label,
        image: service.image || '',
        evidence: context.evidence,
        documentation: engine.documentation,
        note: engine.note,
        options: engine.options.map((definition) => describeOption(service, context, definition)),
        modelInventoryKnown: false,
      },
    ];
  });
}

function validateValue(option, value) {
  if (value === '' || value === null || value === undefined) return null;
  const text = String(value);
  if (text.length > 4096 || /[\u0000-\u001f\u007f]/.test(text))
    throw Error(`${option.label} : valeur invalide.`);
  if (option.type === 'number') {
    const number = Number(text);
    if (
      !Number.isFinite(number) ||
      (option.integer && !Number.isInteger(number)) ||
      (option.min !== undefined && number < option.min) ||
      (option.max !== undefined && number > option.max)
    )
      throw Error(`${option.label} : nombre hors limites.`);
  }
  if (text.startsWith('-') && option.flags && !/^-\d/.test(text))
    throw Error(`${option.label} : une valeur ne peut pas commencer par un nom d’option.`);
  return text;
}

function patchEnvironment(current, option, value) {
  const name = option.location?.name || option.env[0];
  if (Array.isArray(current)) {
    const result = [...current];
    const index = option.location?.index;
    if (index !== undefined) {
      if (value === null) result.splice(index, 1);
      else result[index] = `${name}=${value}`;
    } else if (value !== null) result.push(`${name}=${value}`);
    return result;
  }
  const result = { ...current };
  if (value === null) delete result[name];
  else result[name] = value;
  return result;
}

function setServiceField(source, name, field, value) {
  const { doc, model } = composeDocument(source);
  const node = doc.getIn(['services', name], true);
  let anchored = false;
  YAML.visit(node, (_key, child) => {
    if (
      YAML.isPair(child) &&
      String(child.key?.value || '').startsWith('x-docker-tracer-original-')
    )
      return YAML.visit.SKIP;
    if (child?.anchor) anchored = true;
  });
  if (anchored) {
    let extension = 'x-docker-tracer-original-' + name;
    while (Object.hasOwn(model.services[name], extension)) extension += '-saved';
    const replacement = doc.createNode(structuredClone(model.services[name]));
    replacement.items.unshift(doc.createPair(extension, node));
    doc.setIn(['services', name], replacement);
  } else if (!YAML.isMap(node))
    doc.setIn(['services', name], doc.createNode(structuredClone(model.services[name])));
  doc.setIn(['services', name, field], value);
  return doc.toString();
}

/** Patch only supplied option keys. Empty values remove an explicit override.
 * Returns Compose YAML; callers retain draft metadata, preview, then apply normally.
 * No image pulls, model downloads, HTTP probes, or runtime actions occur here.
 */
export function patchAiServiceSettings(source, serviceName, patch) {
  if (!object(patch)) throw Error('Les réglages IA doivent former un objet.');
  let next = source;
  // Re-read locations after each patch so removals cannot shift a later argv index.
  for (const [key, rawValue] of Object.entries(patch)) {
    const descriptor = detectAiServices(next).find((item) => item.name === serviceName);
    if (!descriptor) throw Error('Moteur IA absent du fichier Compose.');
    const option = descriptor.options.find((item) => item.key === key);
    if (!option) throw Error('Réglage non pris en charge par ce moteur IA : ' + key);
    if (!option.editable) throw Error(option.reason);
    const value = validateValue(option, rawValue);
    if (!option.explicit && value === null) continue;
    const service = composeDocument(next).model.services[serviceName];
    const field = option.source;
    let result;
    if (field === 'environment') result = patchEnvironment(service.environment, option, value);
    else {
      result = [...(service[field] || [])];
      const location = option.location;
      if (location?.positional && value === null)
        throw Error('Le modèle positionnel est requis par vllm serve.');
      if (location)
        result.splice(
          location.index,
          location.length,
          ...(value === null
            ? []
            : location.positional
              ? [value]
              : location.inline
                ? [`${location.flag}=${value}`]
                : [location.flag, value]),
        );
      else result.push(option.flags[0], value);
    }
    next = setServiceField(next, serviceName, field, result);
  }
  return next;
}
