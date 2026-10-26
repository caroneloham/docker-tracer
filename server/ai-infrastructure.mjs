import { createPrivateKey, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import tar from 'tar-stream';
import { readAiSettings, validateAiSecrets } from '../shared/ai-infrastructure.mjs';
import { composeDocument } from '../shared/compose-project.mjs';
import { memoryBytes } from '../shared/container-resources.mjs';
import { discoverAiHardware } from './ai-hardware.mjs';
import {
  discoverAiStorage,
  assertAiStorageReserve,
  prepareAiStoragePreview,
  readAiStoragePreview,
} from './ai-storage.mjs';

export async function readAiRootCertificate(container) {
  const source = await container.getArchive({ path: '/data/caddy/pki/authorities/local/root.crt' });
  const timer = setTimeout(
    () => source.destroy(Error('Lecture du certificat interrompue : délai dépassé.')),
    10000,
  );
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      total += chunk.length;
      if (total > 128 * 1024) throw Error('Archive du certificat trop volumineuse.');
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
    source.destroy();
  }
  const pem = await new Promise((resolve, reject) => {
    const extract = tar.extract();
    let content;
    extract.on('entry', (header, stream, next) => {
      if (
        header.type !== 'file' ||
        header.name !== 'root.crt' ||
        header.size > 24000 ||
        content !== undefined
      ) {
        extract.destroy(Error('Contenu du certificat inattendu.'));
        stream.resume();
        return;
      }
      const parts = [];
      stream.on('data', (c) => parts.push(c));
      stream.on('error', reject);
      stream.on('end', () => {
        content = Buffer.concat(parts).toString('utf8');
        next();
      });
    });
    extract.on('error', reject);
    extract.on('finish', () =>
      content ? resolve(content) : reject(Error('Certificat introuvable.')),
    );
    extract.end(Buffer.concat(chunks));
  });
  if (!new X509Certificate(pem).ca)
    throw Error('Le fichier ne contient pas une autorité de certification.');
  return pem;
}

export async function aiHostReport(engine, context) {
  const info = await engine.info();
  const hardware = await discoverAiHardware(info, context);
  const storage = await discoverAiStorage(engine, info, context);
  const containers = await engine.listContainers();
  return {
    checkedAt: new Date().toISOString(),
    os: info.OSType,
    operatingSystem: info.OperatingSystem,
    architecture: info.Architecture,
    cpus: info.NCPU,
    ramGiB: Math.round((info.MemTotal / 1024 ** 3) * 10) / 10,
    nvidiaRuntime: !!info.Runtimes?.nvidia,
    gpu: 'unverified',
    hardware,
    storage,
    occupiedTcpPorts: [
      ...new Set(
        containers.flatMap((c) =>
          (c.Ports || []).filter((p) => p.Type === 'tcp' && p.PublicPort).map((p) => p.PublicPort),
        ),
      ),
    ].sort((a, b) => a - b),
    message: hardware.gpuMessage || hardware.reason,
  };
}

export async function validateAiDeployment(
  compose,
  engine,
  { storageDependencies, resolvedConfig } = {},
) {
  const settings = readAiSettings(compose.source);
  if (!settings) return;
  const variables = validateAiSecrets(compose.variables, settings);
  if (settings.tls === 'provided') {
    let cert, key;
    try {
      cert = new X509Certificate(variables.AI_TLS_CERT);
      key = createPrivateKey(variables.AI_TLS_KEY);
    } catch {
      throw Error('Le certificat ou la clé privée PEM ne peut pas être lu.');
    }
    if (!cert.checkPrivateKey(key))
      throw Error('Le certificat et la clé privée ne correspondent pas.');
    if (Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo))
      throw Error('Le certificat n’est pas encore valide ou a expiré.');
    if (!(isIP(settings.domain) ? cert.checkIP(settings.domain) : cert.checkHost(settings.domain)))
      throw Error('Le certificat ne couvre pas le nom ou l’adresse d’accès choisi.');
  }
  const info = await engine.info();
  if (info.OSType !== 'linux')
    throw Error('Cette infrastructure IA nécessite un moteur Docker Linux.');
  const plan = prepareAiStoragePreview({ source: compose.source, profiles: compose.profiles }),
    disk = await readAiStoragePreview(plan, engine, {}, { storageDependencies, info });
  assertAiStorageReserve(disk.storage, disk.estimate);
  const model = resolvedConfig || composeDocument(compose.source).model,
    active = Object.entries(model.services || {}).filter(
      ([, service]) =>
        !service.profiles?.length || service.profiles.some((p) => compose.profiles?.includes(p)),
    );
  // Limits are shared ceilings, not reserved allocations. Read current Compose,
  // never the old generator metadata, after edits made from the maintenance UI.
  for (const [name, service] of active) {
    const cpus = Number(service.cpus ?? service.deploy?.resources?.limits?.cpus),
      memory = memoryBytes(service.mem_limit ?? service.deploy?.resources?.limits?.memory);
    if (Number.isFinite(cpus) && cpus > info.NCPU)
      throw Error(`${name} : le moteur Docker dispose de ${info.NCPU} CPU.`);
    if (memory != null && memory > info.MemTotal)
      throw Error(`${name} : la limite RAM dépasse la mémoire disponible pour Docker.`);
  }
  const bindings = active.flatMap(([, service]) =>
    (service.ports || []).flatMap((port) => {
      if (port && typeof port === 'object')
        return [
          {
            port: Number(port.published),
            ip: port.host_ip || '0.0.0.0',
            protocol: port.protocol || 'tcp',
          },
        ];
      const match = String(port).match(/^(?:(\[[^\]]+\]|[^:]+):)?(\d+):(\d+)(?:\/(tcp|udp))?$/);
      return match
        ? [
            {
              port: Number(match[2]),
              ip: match[1]?.replace(/^\[|\]$/g, '') || '0.0.0.0',
              protocol: match[4] || 'tcp',
            },
          ]
        : [];
    }),
  );
  const containers = await engine.listContainers({ all: true });
  const occupied = containers
    .filter((c) => c.Labels?.['com.docker.compose.project'] !== compose.projectName)
    .flatMap((c) =>
      (c.Ports || []).filter((p) =>
        bindings.some(
          (binding) =>
            binding.protocol === p.Type &&
            binding.port === p.PublicPort &&
            (!p.IP ||
              ['0.0.0.0', '::'].includes(p.IP) ||
              ['0.0.0.0', '::'].includes(binding.ip) ||
              p.IP === binding.ip),
        ),
      ),
    );
  if (occupied.length)
    throw Error(
      `Port déjà publié par un autre conteneur : ${[...new Set(occupied.map((p) => p.PublicPort))].join(', ')}. Modifie les ports du service.`,
    );
}
