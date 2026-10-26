import os from 'node:os';
import path from 'node:path';
import { readFile, realpath, stat, statfs } from 'node:fs/promises';
import { z } from 'zod';
import {
  aiSizing,
  aiComposeModel,
  AI_EXTENSION,
  readAiSettings,
} from '../shared/ai-infrastructure.mjs';
import { detectAiServices } from '../shared/ai-service-context.mjs';
import { composeDocument, composeSettings } from '../shared/compose-project.mjs';

export const AI_MINIMUM_DISK_FREE_GIB = 10;
const GIB = 1024 ** 3;
const missing = (error) => ['ENOENT', 'ENOTDIR'].includes(error?.code);
const unavailable = (reason) => ({ status: 'unavailable', reason });

// Read-only checks on the server running Docker Tracer. Never query a container's
// apparent filesystem size: Docker Desktop's virtual capacity is not host free space.
export async function discoverAiStorage(engine, info, context = {}, dependencies = {}) {
  const platform = dependencies.platform || process.platform,
    hostname = dependencies.hostname || os.hostname(),
    env = dependencies.env || process.env,
    read = dependencies.readFile || readFile,
    inspect = dependencies.stat || stat,
    resolve = dependencies.realpath || realpath,
    diskStats = dependencies.statfs || statfs,
    modem = engine?.modem || {},
    socketPath = context.socketPath || modem.socketPath;
  if (
    (context.kind && context.kind !== 'local') ||
    modem.host ||
    modem.protocol === 'ssh' ||
    modem.sshOptions?.host ||
    typeof socketPath !== 'string' ||
    info.OSType !== 'linux'
  )
    return unavailable(
      'Le disque physique du moteur distant ou non identifié ne peut pas être mesuré depuis cette machine.',
    );

  async function exists(file, type) {
    try {
      return (await inspect(file))[type]();
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }
  try {
    let scope, dockerStoragePath, measuredPath;
    if (
      platform === 'win32' &&
      /^\/\/\.\/pipe\/(?:dockerDesktopLinuxEngine|docker_engine)$/i.test(
        socketPath.replaceAll('\\', '/'),
      ) &&
      /docker desktop/i.test(info.OperatingSystem || '')
    ) {
      const win = path.win32;
      if (!env.APPDATA || !env.LOCALAPPDATA)
        return unavailable(
          'Les dossiers de données locaux de Docker Desktop ne sont pas identifiables.',
        );
      let settings = {};
      for (const filename of ['settings-store.json', 'settings.json']) {
        try {
          settings = JSON.parse(await read(win.join(env.APPDATA, 'Docker', filename), 'utf8'));
          if (!settings || typeof settings !== 'object' || Array.isArray(settings))
            throw Error('Invalid Docker Desktop settings');
          break;
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      const configuredFolder = settings.dataFolder;
      if (configuredFolder !== undefined && typeof configuredFolder !== 'string')
        return unavailable('L’emplacement du disque Docker Desktop ne peut pas être interprété.');
      const folder = configuredFolder || win.join(env.LOCALAPPDATA, 'Docker', 'wsl');
      if (!/^[a-z]:[\\/]/i.test(folder))
        return unavailable(
          'L’emplacement du disque Docker Desktop n’est pas un chemin local absolu vérifié.',
        );
      const candidates = /\.vhdx$/i.test(folder)
          ? [folder]
          : [
              win.join(folder, 'disk', 'docker_data.vhdx'),
              win.join(folder, 'data', 'docker_data.vhdx'),
              win.join(folder, 'data', 'ext4.vhdx'),
              win.join(folder, 'docker_data.vhdx'),
              win.join(folder, 'wsl', 'disk', 'docker_data.vhdx'),
              win.join(folder, 'wsl', 'data', 'docker_data.vhdx'),
              win.join(folder, 'wsl', 'data', 'ext4.vhdx'),
            ],
        found = new Set();
      for (const candidate of candidates)
        if (await exists(candidate, 'isFile')) found.add(await resolve(candidate));
      if (found.size !== 1)
        return unavailable(
          found.size
            ? 'Plusieurs disques Docker Desktop existent ; leur disque physique actif ne peut pas être identifié avec certitude.'
            : 'Le disque de données Docker Desktop est introuvable à son emplacement configuré.',
        );
      [dockerStoragePath] = found;
      if (!/^[a-z]:[\\/]/i.test(dockerStoragePath))
        return unavailable(
          'Le disque de données Docker Desktop ne correspond pas à un stockage local vérifié.',
        );
      measuredPath = win.dirname(dockerStoragePath);
      scope = 'windows-desktop-host';
    } else if (
      platform === 'linux' &&
      info.Name === hostname &&
      !/docker desktop/i.test(info.OperatingSystem || '') &&
      path.posix.isAbsolute(socketPath) &&
      typeof info.DockerRootDir === 'string' &&
      path.posix.isAbsolute(info.DockerRootDir)
    ) {
      for (const marker of ['/.dockerenv', '/run/.containerenv']) {
        try {
          await read(marker);
          return unavailable(
            'Docker Tracer fonctionne dans un conteneur ; le disque physique de l’hôte ne peut pas être vérifié.',
          );
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
      if (
        !(await exists(socketPath, 'isSocket')) ||
        !(await exists(info.DockerRootDir, 'isDirectory'))
      )
        return unavailable(
          'Le socket local ou le dossier de données Docker ne peut pas être vérifié.',
        );
      dockerStoragePath = await resolve(info.DockerRootDir);
      measuredPath = dockerStoragePath;
      scope = 'linux-host';
    } else {
      return unavailable(
        'Le moteur Docker ne peut pas être relié avec certitude au disque physique de cette machine.',
      );
    }
    const fs = await diskStats(measuredPath, { bigint: true }),
      availableBytes = Number(fs.bavail) * Number(fs.bsize),
      totalBytes = Number(fs.blocks) * Number(fs.bsize);
    if (
      !Number.isFinite(availableBytes) ||
      !Number.isFinite(totalBytes) ||
      availableBytes < 0 ||
      totalBytes <= 0 ||
      availableBytes > totalBytes
    )
      return unavailable('La mesure de l’espace disque physique est indisponible.');
    return {
      status: 'detected',
      scope,
      path: measuredPath,
      dockerStoragePath,
      availableGiB: Math.floor((availableBytes / GIB) * 10) / 10,
      totalGiB: Math.floor((totalBytes / GIB) * 10) / 10,
      minimumFreeGiB: AI_MINIMUM_DISK_FREE_GIB,
      sufficient: availableBytes >= AI_MINIMUM_DISK_FREE_GIB * GIB,
      message:
        'Réserve minimale sur le disque physique Docker. La taille complète des images et du modèle peut nécessiter davantage d’espace.',
    };
  } catch {
    return unavailable(
      'La mesure du disque physique Docker a échoué ; aucune capacité de disque virtuel n’est utilisée à sa place.',
    );
  }
}

const imageAllowanceGiB = new Map([
  ['vllm/vllm-openai:v0.29.0', 32],
  ['ghcr.io/open-webui/open-webui:v0.11.1', 8],
  ['postgres:17-alpine', 0.5],
  ['caddy:2.10.2-alpine', 0.2],
]);

// Local image inventory only. These rounded allowances apply to the pinned
// images shipped with this release, not arbitrary tags or registry metadata.
export function estimateAiStorageRequirements(
  settings,
  cachedImages,
  imageReferences,
  { modelActive = true, modelEstimateKnown = true } = {},
) {
  const cached = new Set(
      (cachedImages || []).flatMap((image) => [
        ...(image.RepoTags || []),
        ...(image.RepoDigests || []),
      ]),
    ),
    references = [
      ...new Set(
        imageReferences || [
          settings.images.vllm,
          settings.images.webui,
          settings.images.caddy,
          ...(settings.database?.mode === 'external' ? [] : [settings.images.postgres]),
        ],
      ),
    ],
    missingImages = references.filter((reference) => !cached.has(reference)),
    unknownImages = missingImages.filter((reference) => !imageAllowanceGiB.has(reference)),
    imagesGiB = missingImages.reduce(
      (total, reference) => total + (imageAllowanceGiB.get(reference) || 0),
      0,
    ),
    modelGiB = !modelActive ? 0 : modelEstimateKnown ? aiSizing(settings).weightsGiB : null,
    customModelStorage = modelActive && modelEstimateKnown && !!settings.modelStorageRoot,
    modelStorage = {
      status: !modelActive
        ? 'not-required'
        : !modelEstimateKnown
          ? 'unknown'
          : customModelStorage
            ? 'unverified'
            : 'docker-volume',
      path: customModelStorage ? settings.modelStorageRoot : null,
      requiredGiB: modelGiB,
      message:
        !modelEstimateKnown && modelActive
          ? 'Le moteur ou son stockage a été modifié. La taille et l’emplacement des modèles restent à vérifier ; les anciens réglages ne servent plus d’estimation.'
          : customModelStorage
            ? 'Le dossier des modèles n’est pas mesuré. Il peut se trouver sur le même disque que Docker ou sur un autre disque ; la place totale n’est pas confirmée.'
            : modelActive
              ? 'Les poids sont comptés sur le disque des volumes Docker ; leur présence en cache n’est pas vérifiée.'
              : 'Le service d’inférence n’est pas actif dans les profils choisis.',
    };
  return {
    requiredGiB: Math.ceil((AI_MINIMUM_DISK_FREE_GIB + imagesGiB + modelGiB) * 10) / 10,
    dockerRequiredGiB:
      Math.ceil((AI_MINIMUM_DISK_FREE_GIB + imagesGiB + (customModelStorage ? 0 : modelGiB)) * 10) /
      10,
    reserveGiB: AI_MINIMUM_DISK_FREE_GIB,
    imagesGiB: Math.round(imagesGiB * 10) / 10,
    modelGiB,
    modelCacheVerified: false,
    modelStorage,
    imageCacheChecked: Array.isArray(cachedImages),
    complete:
      Array.isArray(cachedImages) &&
      unknownImages.length === 0 &&
      !customModelStorage &&
      (!modelActive || modelEstimateKnown),
    missingImages,
    unknownImages,
    message:
      'Place à prévoir : images connues absentes, poids du modèle (cache non vérifié) et réserve. Les fichiers temporaires et les images personnalisées peuvent demander davantage.',
  };
}

const profileName = z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  profilesSchema = z.array(profileName).max(50),
  previewInputSchema = z
    .object({
      source: composeSettings.shape.source,
      profiles: profilesSchema.default([]),
    })
    .strict();

// No Compose CLI, interpolation, included files or build contexts are executed.
// The same active-service selection feeds preview and deployment validation.
export function prepareAiStoragePreview(input) {
  const { source, profiles } = previewInputSchema.parse(input),
    settings = readAiSettings(source);
  if (!settings) throw Error('Cette configuration ne contient pas de profil d’infrastructure IA.');
  const { model } = composeDocument(source),
    selected = new Set(profiles),
    active = Object.entries(model.services || {}).filter(([name, service]) => {
      const parsed = profilesSchema.safeParse(service.profiles ?? []);
      if (!parsed.success) throw Error(`Service ${name} : profils Compose invalides.`);
      return !parsed.data.length || parsed.data.some((profile) => selected.has(profile));
    }),
    incompleteReasons = [];
  if (model.include || active.some(([, service]) => service.extends))
    incompleteReasons.push(
      'Les fichiers Compose inclus ou hérités ne sont pas résolus par cette prévisualisation.',
    );
  if (active.some(([, service]) => service.build))
    incompleteReasons.push(
      'Un service actif construit une image ; son contexte, ses images de base et son espace de compilation ne sont pas estimés.',
    );
  if (active.some(([, service]) => /\$/.test(service.image || '')))
    incompleteReasons.push(
      'Une référence d’image contient une variable non résolue ; aucun environnement ou fichier de secrets n’est lu.',
    );
  if (
    active.some(([, service]) => {
      const image = service.image || '';
      return (
        image &&
        !image.includes('@') &&
        (!image.split('/').at(-1).includes(':') || image.endsWith(':latest'))
      );
    })
  )
    incompleteReasons.push(
      'Une image utilise latest ou aucun tag explicite ; sa mise à jour éventuelle reste à estimer même si elle est en cache.',
    );
  if (active.some(([, service]) => service.pull_policy === 'always'))
    incompleteReasons.push(
      'Un service impose un nouveau téléchargement ; sa mise à jour éventuelle reste à estimer.',
    );
  const engines = detectAiServices({ services: Object.fromEntries(active) }),
    modelBind = model.services?.inference?.volumes?.find(
      (mount) =>
        typeof mount === 'object' &&
        mount.type === 'bind' &&
        mount.target === '/root/.cache/huggingface',
    ),
    rootPrefix = settings.modelStorageRoot?.replace(/\/+$/, '') + '/docker-tracer/',
    storageProject =
      typeof modelBind?.source === 'string' && modelBind.source.startsWith(rootPrefix)
        ? modelBind.source
            .slice(rootPrefix.length)
            .match(/^([a-z0-9][a-z0-9_-]{0,62})\/models$/)?.[1]
        : null,
    generated = aiComposeModel(settings, storageProject || 'storage-check', {
      legacyModelCatalog: !model[AI_EXTENSION]?.modelCatalogVersion,
    }),
    inference = model.services?.inference,
    expected = generated.services.inference,
    modelEstimateKnown =
      engines.length === 1 &&
      engines[0].name === 'inference' &&
      ['image', 'command', 'entrypoint', 'environment', 'volumes'].every(
        (field) => JSON.stringify(inference?.[field]) === JSON.stringify(expected[field]),
      );
  return {
    settings,
    modelActive: engines.length > 0 || active.some(([name]) => name === 'inference'),
    modelEstimateKnown,
    profiles,
    images: active.map(([, service]) => service.image || '<image construite localement>'),
    activeServices: active.map(([name]) => name),
    incompleteReasons,
  };
}

export async function readAiStoragePreview(
  plan,
  engine,
  context = {},
  { storageDependencies, info } = {},
) {
  const [infoResult, imagesResult] = await Promise.allSettled([
      Promise.resolve().then(() => info || engine.info()),
      Promise.resolve().then(() => engine.listImages({ all: true })),
    ]),
    cachedImages =
      imagesResult.status === 'fulfilled' && Array.isArray(imagesResult.value)
        ? imagesResult.value
        : null,
    storage =
      infoResult.status === 'fulfilled'
        ? await discoverAiStorage(engine, infoResult.value, context, storageDependencies)
        : unavailable(
            'Le moteur Docker ne répond pas ; son espace disque physique ne peut pas être mesuré.',
          ),
    estimate = estimateAiStorageRequirements(plan.settings, cachedImages, plan.images, {
      modelActive: plan.modelActive,
      modelEstimateKnown: plan.modelEstimateKnown,
    });
  estimate.incompleteReasons = [
    ...plan.incompleteReasons,
    ...(!estimate.imageCacheChecked
      ? ['L’inventaire des images déjà présentes est indisponible.']
      : []),
    ...(estimate.unknownImages.length
      ? ['La taille des images personnalisées absentes n’est pas estimée.']
      : []),
    ...(['unverified', 'unknown'].includes(estimate.modelStorage.status)
      ? [estimate.modelStorage.message]
      : []),
  ];
  if (estimate.incompleteReasons.length) estimate.complete = false;
  return {
    checkedAt: new Date().toISOString(),
    storage,
    estimate,
    status:
      storage.status === 'detected' && storage.availableGiB < estimate.dockerRequiredGiB
        ? 'insufficient'
        : storage.status === 'detected' && estimate.complete
          ? 'ready'
          : 'unknown',
  };
}

export function assertAiStorageReserve(storage, estimate) {
  const requiredGiB =
      estimate?.dockerRequiredGiB ?? estimate?.requiredGiB ?? AI_MINIMUM_DISK_FREE_GIB,
    separateModels = estimate?.modelStorage?.status === 'unverified';
  if (storage.status === 'detected' && storage.availableGiB < requiredGiB)
    throw Error(
      `Espace disque insuffisant : ${storage.availableGiB} Gio libres sur le disque physique Docker (${storage.path}). Libère de l’espace ou déplace les données Docker vers un autre disque avant de déployer. Place à prévoir sur ce disque : ${requiredGiB} Gio${estimate ? ` (${estimate.imagesGiB} Gio d’images absentes, ${separateModels ? '' : estimate.modelGiB == null ? 'poids du modèle inconnus, ' : `${estimate.modelGiB} Gio de poids du modèle, `}${AI_MINIMUM_DISK_FREE_GIB} Gio de réserve ; cache modèle non vérifié)` : ` de réserve minimale`}.${separateModels ? ` Prévois aussi ${estimate.modelGiB} Gio de poids dans ${estimate.modelStorage.path}, dont l’espace n’est pas mesuré.` : ''}${estimate && !estimate.complete ? ' Estimation incomplète : une partie du stockage ou des images reste à vérifier.' : ''} Les fichiers temporaires peuvent nécessiter davantage.`,
    );
}
