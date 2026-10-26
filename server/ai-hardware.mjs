import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, statfs } from 'node:fs/promises';

const run = promisify(execFile);
const gib = (bytes) => Math.floor((Number(bytes) / 1024 ** 3) * 10) / 10;
const number = (text) => (/^\d+(?:\.\d+)?$/.test(text?.trim()) ? Number(text) : null);
export function parseNvidiaInventory(csv) {
  if (!csv.trim() || /No devices were found/i.test(csv)) return [];
  return csv
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const cells = (line.match(/(?:"(?:[^"]|"")*"|[^,])+(?=,|$)/g) || []).map((s) =>
        s.trim().replace(/^"|"$/g, '').replaceAll('""', '"'),
      );
      const [index, uuid, name, total, free, utilization, driver] = cells;
      if (
        cells.length !== 7 ||
        !/^\d+$/.test(index) ||
        !/^GPU-[a-f\d-]+$/i.test(uuid) ||
        !number(total)
      )
        throw Error('Réponse NVIDIA illisible.');
      return {
        index,
        uuid,
        name,
        driver,
        totalGiB: gib(number(total) * 1024 ** 2),
        freeGiB: number(free) === null ? null : gib(number(free) * 1024 ** 2),
        utilization: number(utilization),
      };
    });
}

// Only mounted local data filesystems, never pseudo filesystems or network shares.
export function parseLocalMounts(text) {
  const decode = (s) => s.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
  return [
    ...new Map(
      text
        .trim()
        .split('\n')
        .flatMap((line) => {
          const [before, after] = line.split(' - ');
          if (!after) return [];
          const fields = before.split(' '),
            [type, source] = after.split(' ');
          const target = decode(fields[4] || '');
          if (
            !fields[5]?.split(',').includes('rw') ||
            !['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'ntfs3', 'fuseblk'].includes(type)
          )
            return [];
          if (!target.startsWith('/') || /^\/(?:boot|snap|proc|sys|dev)(?:\/|$)/.test(target))
            return [];
          return [[target, { path: target, device: decode(source), filesystem: type }]];
        }),
    ).values(),
  ].slice(0, 32);
}

export async function discoverAiHardware(info, context = {}, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  const hostname = dependencies.hostname || os.hostname();
  const read = dependencies.readFile || readFile;
  const execute = dependencies.exec || run;
  const diskStats = dependencies.statfs || statfs;
  const unavailable = (reason) => ({ status: 'unavailable', reason, gpus: [], disks: [] });
  if (context.kind !== 'local' || !context.socketPath)
    return unavailable(
      'Ouvre Docker Tracer sur le serveur pour détecter ses composants. La configuration manuelle reste disponible pour une cible SSH.',
    );
  const desktop =
    platform === 'win32' &&
    /pipe/i.test(context.socketPath) &&
    /docker desktop/i.test(info.OperatingSystem || '');
  let inContainer = false;
  if (platform === 'linux') {
    inContainer = await read('/.dockerenv').then(
      () => true,
      () => false,
    );
    if (!inContainer)
      inContainer = await read('/run/.containerenv').then(
        () => true,
        () => false,
      );
  }
  if (
    !desktop &&
    !(
      platform === 'linux' &&
      !inContainer &&
      info.Name === hostname &&
      context.socketPath.startsWith('/')
    )
  )
    return unavailable(
      'Le matériel du serveur Docker ne peut pas être relié avec certitude à cette machine. Aucune ressource locale n’est attribuée à cette cible.',
    );
  const nativeCpus = dependencies.cpus ? dependencies.cpus() : os.cpus();
  const result = {
    status: 'detected',
    scope: desktop ? 'windows-desktop' : 'linux-host',
    hostname,
    cpuModel: nativeCpus[0]?.model || 'Processeur',
    logicalCpus: nativeCpus.length,
    totalRamGiB: gib((dependencies.totalmem || os.totalmem)()),
    freeRamGiB: gib((dependencies.freemem || os.freemem)()),
    gpus: [],
    disks: [],
    gpuStatus: 'unavailable',
    storageMessage: desktop
      ? 'Docker Desktop stocke les volumes dans son disque virtuel Linux. Le choix d’un disque physique est disponible quand Docker Tracer tourne directement sur Ubuntu.'
      : 'Les modèles peuvent être placés sur un disque monté du serveur. Les autres données restent dans les volumes Docker du projet.',
  };
  await Promise.all([
    (async () => {
      try {
        const { stdout } = await execute(
          'nvidia-smi',
          [
            '--query-gpu=index,uuid,name,memory.total,memory.free,utilization.gpu,driver_version',
            '--format=csv,noheader,nounits',
          ],
          { timeout: 7000, maxBuffer: 128 * 1024, windowsHide: true, encoding: 'utf8' },
        );
        result.gpus = parseNvidiaInventory(stdout);
        result.gpuStatus = result.gpus.length ? 'detected' : 'none';
        result.gpuMessage = result.gpus.length
          ? 'Cartes lues depuis le pilote NVIDIA. Leur accès depuis un conteneur reste à valider au déploiement.'
          : 'Aucune carte NVIDIA annoncée par le pilote.';
      } catch {
        result.gpuMessage =
          'Lecture NVIDIA indisponible. Vérifie le pilote et nvidia-smi sur ce serveur, ou prépare une configuration manuelle.';
      }
    })(),
    (async () => {
      if (desktop) return;
      try {
        const mounts = parseLocalMounts(await read('/proc/self/mountinfo', 'utf8'));
        result.disks = (
          await Promise.all(
            mounts.map(async (mount) => {
              try {
                const s = await diskStats(mount.path);
                return {
                  ...mount,
                  totalGiB: gib(s.blocks * s.bsize),
                  freeGiB: gib(s.bavail * s.bsize),
                };
              } catch {
                return null;
              }
            }),
          )
        ).filter(Boolean);
      } catch {
        result.storageMessage =
          'Lecture des disques montés indisponible. Le stockage Docker par défaut reste utilisable.';
      }
    })(),
  ]);
  return result;
}
