import { composeDocument, patchComposeObject } from './compose-project.mjs';

export const GiB = 1024 ** 3;
export function cpuSetCount(value) {
  if (!value) return null;
  const cpus = new Set();
  for (const item of value.split(',')) {
    if (!/^\d+(?:-\d+)?$/.test(item)) return null;
    const [start, end = start] = item.split('-').map(Number);
    if (end < start || end > 65535) return null;
    for (let cpu = start; cpu <= end; cpu++) cpus.add(cpu);
  }
  return cpus.size || null;
}
export function memoryBytes(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const match = String(value ?? '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)(?:i?b)?$/i);
  return match
    ? Number(match[1]) * 1024 ** (match[2] ? 'kmgt'.indexOf(match[2].toLowerCase()) + 1 : 0)
    : null;
}
export function validateAllocation(input, host) {
  const result = {};
  for (const key of ['cpus', 'memoryBytes']) {
    if (input[key] === undefined) continue;
    const value = input[key],
      max = key === 'cpus' ? host.cpus : host.memoryBytes;
    if (!Number.isFinite(max) || max <= 0)
      throw Error('Capacité du serveur indisponible. Actualise le matériel.');
    if (!Number.isFinite(value) || value <= 0 || value > max)
      throw Error(
        key === 'cpus'
          ? `Choisis entre 0,01 et ${max} CPU.`
          : 'La mémoire doit rester dans la capacité Docker.',
      );
    if (key === 'cpus' && value < 0.01) throw Error('Minimum : 0,01 CPU.');
    if (key === 'memoryBytes' && (!Number.isSafeInteger(value) || value < 6 * 1024 ** 2))
      throw Error('Minimum mémoire : 6 Mio.');
    result[key] = value;
  }
  return result;
}
const nvidiaDevice = (device) =>
  device &&
  typeof device === 'object' &&
  (device.driver === 'nvidia' || (!device.driver && device.capabilities?.includes('gpu')));
export function composeGpuState(service) {
  const location = service.gpus !== undefined ? 'gpus' : 'deploy';
  const devices =
    location === 'gpus' ? service.gpus : service.deploy?.resources?.reservations?.devices;
  if (
    service.gpus !== undefined &&
    service.deploy?.resources?.reservations?.devices?.some?.(nvidiaDevice)
  )
    return { location, mode: 'current', ids: [], editable: false };
  if (devices === 'all') return { location, mode: 'all', ids: [], editable: true };
  if (devices !== undefined && !Array.isArray(devices))
    return { location, mode: 'current', ids: [], editable: false };
  const matching = (devices || []).filter(nvidiaDevice);
  const ids = matching.flatMap((d) => d.device_ids || []);
  return {
    location,
    ids,
    editable: matching.length <= 1,
    mode: !matching.length
      ? 'none'
      : ids.length
        ? 'selected'
        : matching[0].count === undefined || matching[0].count === 'all'
          ? 'all'
          : 'current',
  };
}
export function vllmFraction(service) {
  if (!/vllm/i.test(service.image || '')) return null;
  if (!Array.isArray(service.command)) return { editable: false };
  const args = service.command || [],
    values = [];
  args.forEach((arg, index) => {
    if (arg === '--gpu-memory-utilization') values.push(args[index + 1]);
    else if (String(arg).startsWith('--gpu-memory-utilization='))
      values.push(String(arg).split('=')[1]);
  });
  return {
    editable: values.length <= 1 && (!values.length || Number.isFinite(Number(values[0]))),
    value: values.length ? Number(values[0]) : 0.9,
  };
}
export function patchComposeResources(source, name, input, host) {
  const { model } = composeDocument(source),
    service = model.services?.[name];
  if (!service) throw Error('Service absent du fichier Compose.');
  const allocation = validateAllocation(input, host),
    deploy = structuredClone(service.deploy || {});
  let result = source,
    deployChanged = false;
  const patch = (key, value) => {
    result = patchComposeObject(result, 'services', name, key, value);
  };
  for (const [key, field, deployField] of [
    ['cpus', 'cpus', 'cpus'],
    ['memoryBytes', 'mem_limit', 'memory'],
  ]) {
    if (allocation[key] === undefined) continue;
    if (key === 'memoryBytes') {
      const swap = memoryBytes(service.memswap_limit),
        reservation = memoryBytes(
          service.mem_reservation ?? deploy.resources?.reservations?.memory,
        );
      if (swap > 0 && allocation[key] > swap)
        throw Error(
          'La limite RAM dépasse RAM + swap. Ajuste memswap_limit dans la configuration avancée.',
        );
      if (reservation > allocation[key])
        throw Error(
          'La limite RAM est inférieure à la réservation existante. Ajuste la réservation avant de continuer.',
        );
    }
    patch(field, allocation[key]);
    if (deploy.resources?.limits?.[deployField] !== undefined) {
      deploy.resources.limits[deployField] = allocation[key];
      deployChanged = true;
    }
  }
  if (input.gpu && input.gpu.mode !== 'keep') {
    const state = composeGpuState(service);
    if (!state.editable)
      throw Error('Plusieurs règles GPU existent. Modifie-les dans les options avancées.');
    if (!['all', 'none', 'selected'].includes(input.gpu.mode)) throw Error('Choix GPU invalide.');
    const ids = [...new Set(input.gpu.ids || [])];
    if (input.gpu.mode === 'selected') {
      const allowed = new Set([
        ...(host.gpus || []).flatMap((gpu) => [gpu.uuid, gpu.index]),
        ...state.ids,
      ]);
      if (!ids.length || ids.some((id) => typeof id !== 'string' || !allowed.has(id)))
        throw Error('Choisis au moins une carte détectée.');
    }
    if (input.gpu.mode === 'all' && !(host.gpus || []).length)
      throw Error('Aucune carte détectée. Actualise le matériel.');
    const oldDevices =
      state.location === 'gpus' ? service.gpus : deploy.resources?.reservations?.devices;
    const list = Array.isArray(oldDevices) ? oldDevices : [],
      template = list.find(nvidiaDevice) || {};
    const device = {
      ...template,
      driver: 'nvidia',
      capabilities: template.capabilities || ['gpu'],
    };
    delete device.count;
    delete device.device_ids;
    if (input.gpu.mode === 'all') device.count = 'all';
    if (input.gpu.mode === 'selected') device.device_ids = ids;
    const devices = list.filter((item) => !nvidiaDevice(item));
    if (input.gpu.mode !== 'none') devices.push(device);
    if (state.location === 'gpus') patch('gpus', devices.length ? devices : undefined);
    else {
      deploy.resources ||= {};
      deploy.resources.reservations ||= {};
      deploy.resources.reservations.devices = devices;
      deployChanged = true;
    }
  }
  if (deployChanged) patch('deploy', deploy);
  if (input.vllmFraction !== undefined) {
    const state = vllmFraction(service),
      fraction = input.vllmFraction;
    if (!state?.editable || !Number.isFinite(fraction) || fraction <= 0 || fraction >= 1)
      throw Error('La part mémoire vLLM doit être comprise entre 1 et 99 %.');
    const args = [...(service.command || [])],
      index = args.findIndex((arg) => String(arg).split('=')[0] === '--gpu-memory-utilization');
    if (index < 0) args.push('--gpu-memory-utilization', String(fraction));
    else if (args[index].includes('=')) args[index] = '--gpu-memory-utilization=' + fraction;
    else args[index + 1] = String(fraction);
    patch('command', args);
  }
  return result;
}
