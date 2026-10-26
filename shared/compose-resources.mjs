import { composeDocument, patchComposeObject } from './compose-project.mjs';
import { composeGpuState, memoryBytes, patchComposeResources } from './container-resources.mjs';

const GiB = 1024 ** 3;
const cpuMaximum = 256;
const memoryMaximumGiB = 1024;

export function declarativeCpu(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text))
    throw Error('CPU : indique un nombre décimal, par exemple 1,5 avec un point (1.5).');
  const cpus = Number(text);
  if (cpus < 0.01 || cpus > cpuMaximum)
    throw Error(
      `CPU : choisis entre 0,01 et ${cpuMaximum}. Cette borne protège la saisie ; elle ne décrit pas ton serveur.`,
    );
  return cpus;
}

export function declarativeMemoryBytes(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(text))
    throw Error('RAM : indique une quantité en Gio, par exemple 1.5.');
  const gib = Number(text);
  const bytes = Math.round(gib * GiB);
  if (bytes < 6 * 1024 ** 2 || gib > memoryMaximumGiB || !Number.isSafeInteger(bytes))
    throw Error(
      `RAM : choisis entre 0,006 et ${memoryMaximumGiB} Gio. Cette borne protège la saisie ; elle ne décrit pas ton serveur.`,
    );
  return bytes;
}

export function declarativeGpuIds(value) {
  const ids = (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (
    !ids.length ||
    ids.length > 16 ||
    ids.some((id) => !/^(?:\d{1,3}|GPU-[A-Za-z0-9-]{4,128})$/.test(id))
  )
    throw Error(
      'GPU : indique 1 à 16 indices numériques ou identifiants GPU-… séparés par des virgules.',
    );
  if (new Set(ids).size !== ids.length) throw Error('GPU : retire les identifiants en double.');
  return ids;
}

const nvidiaDevice = (device) =>
  device &&
  typeof device === 'object' &&
  (device.driver === 'nvidia' || (!device.driver && device.capabilities?.includes('gpu')));

// Modifies only declarations already present in the uploaded Compose. No Docker host is queried
// or invented, so these checks never claim that a configuration fits the visitor's hardware.
export function patchDeclarativeComposeResources(source, name, input) {
  const { model } = composeDocument(source);
  const service = model.services?.[name];
  if (!service) throw Error('Service absent du fichier Compose.');
  const deploy = structuredClone(service.deploy || {});
  let result = source;
  let deployChanged = false;
  const patch = (field, value) => {
    result = patchComposeObject(result, 'services', name, field, value);
  };
  for (const [key, field, deployField] of [
    ['cpus', 'cpus', 'cpus'],
    ['memory', 'mem_limit', 'memory'],
  ]) {
    const choice = input[key] || { mode: 'keep' };
    if (choice.mode === 'keep') continue;
    if (!['set', 'remove'].includes(choice.mode)) throw Error('Choix de ressources invalide.');
    const value =
      choice.mode === 'remove'
        ? undefined
        : key === 'cpus'
          ? declarativeCpu(choice.value)
          : declarativeMemoryBytes(choice.value);
    if (key === 'memory' && value !== undefined) {
      const swap = memoryBytes(service.memswap_limit);
      const reservation = memoryBytes(
        service.mem_reservation ?? deploy.resources?.reservations?.memory,
      );
      if (swap > 0 && value > swap)
        throw Error(
          'La limite RAM dépasse RAM + swap déclarés. Ajuste memswap_limit dans le Compose.',
        );
      if (reservation > value)
        throw Error(
          'La limite RAM est inférieure à la réservation déclarée. Ajuste la réservation dans le Compose.',
        );
    }
    patch(field, value);
    if (deploy.resources?.limits?.[deployField] !== undefined) {
      if (value === undefined) delete deploy.resources.limits[deployField];
      else deploy.resources.limits[deployField] = value;
      deployChanged = true;
    }
  }
  const gpu = input.gpu || { mode: 'keep' };
  if (gpu.mode !== 'keep') {
    const state = composeGpuState(service);
    if (!state.editable)
      throw Error('Plusieurs règles GPU existent. Modifie-les dans le Compose avancé.');
    if (!['all', 'none', 'selected'].includes(gpu.mode)) throw Error('Choix GPU invalide.');
    const old = state.location === 'gpus' ? service.gpus : deploy.resources?.reservations?.devices;
    const list = Array.isArray(old) ? old : [];
    const template = list.find(nvidiaDevice) || {};
    const devices = list.filter((device) => !nvidiaDevice(device));
    if (gpu.mode !== 'none') {
      const device = {
        ...template,
        driver: 'nvidia',
        capabilities: template.capabilities || ['gpu'],
      };
      delete device.count;
      delete device.device_ids;
      if (gpu.mode === 'all') device.count = 'all';
      else device.device_ids = declarativeGpuIds(gpu.ids);
      devices.push(device);
    }
    if (state.location === 'gpus') patch('gpus', devices.length ? devices : undefined);
    else {
      deploy.resources ||= {};
      deploy.resources.reservations ||= {};
      deploy.resources.reservations.devices = devices;
      deployChanged = true;
    }
  }
  if (deployChanged) patch('deploy', deploy);
  if (input.vllmFraction !== undefined)
    result = patchComposeResources(result, name, { vllmFraction: input.vllmFraction }, {});
  // Ensure edits remain parseable before returning them to the draft.
  composeDocument(result);
  return result;
}
