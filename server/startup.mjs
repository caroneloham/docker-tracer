import { randomUUID } from 'node:crypto';
import { startupSchema, startupDescription } from '../shared/startup.mjs';
import { ensureToolImage, TOOL_IMAGE, execTool } from './engine-tools.mjs';
import { decodeDockerLog } from './streams.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const needsProbe = (n) => ['tcp', 'http'].includes(n.data.startup?.mode);
export async function prepareStartup(engine, nodes, notify = () => {}) {
  if (!nodes.some(needsProbe)) return;
  notify('Préparation de la sonde de démarrage…');
  // Download before stopping the old services.
  await ensureToolImage(engine);
}
export function startupCommand(input) {
  const s = startupSchema.parse(input);
  return s.mode === 'tcp'
    ? ['nc', '-z', '-w', '2', '127.0.0.1', String(s.port)]
    : [
        'curl',
        '-q',
        '--silent',
        '--show-error',
        '--noproxy',
        '*',
        '--connect-timeout',
        '1',
        '--max-time',
        '2',
        '--output',
        '/dev/null',
        '--write-out',
        '%{http_code}',
        'http://127.0.0.1:' + s.port + s.path,
      ];
}
export async function checkStartup(
  engine,
  topology,
  node,
  container,
  { now = Date.now, sleep = delay, exec = execTool } = {},
) {
  const settings = startupSchema.parse(node.data.startup);
  const result = {
    nodeId: node.id,
    label: node.data.label,
    containerId: container.id,
    mode: settings.mode,
    description: startupDescription(settings),
    startedAt: now(),
    attempts: 0,
    status: 'skipped',
    summary: 'Aucun contrôle demandé.',
    observations: [],
  };
  const observe = (value) => {
    result.observations = [...result.observations, { at: now(), ...value }].slice(-5);
  };
  let helper, healthySince;
  const deadline = now() + settings.timeoutSeconds * 1000;
  try {
    if (settings.mode !== 'none') {
      result.status = 'failed';
      while (now() < deadline) {
        const info = await container.inspect();
        result.attempts++;
        if (!info.State.Running || info.State.Restarting || info.State.Paused || info.State.Dead) {
          observe({
            state: info.State.Status,
            exitCode: info.State.ExitCode,
            restarting: !!info.State.Restarting,
          });
          result.summary =
            'Le processus ne reste pas en marche' +
            (info.State.ExitCode == null ? '.' : ' (code ' + info.State.ExitCode + ').');
          break;
        }
        let passed = false;
        if (settings.mode === 'running') {
          observe({
            state: info.State.Status,
            startedAt: info.State.StartedAt,
            restartCount: info.RestartCount || 0,
          });
          passed = true;
        } else if (settings.mode === 'health') {
          const health = info.State.Health;
          if (!health) {
            result.status = 'inconclusive';
            result.summary = 'Cette image ne fournit pas de contrôle de santé Docker actif.';
            break;
          }
          observe({
            state: health.Status,
            failingStreak: health.FailingStreak,
            output: String(health.Log?.at(-1)?.Output || '').slice(-1000),
          });
          passed = health.Status === 'healthy';
          result.summary = 'État de santé Docker : ' + health.Status + '.';
        } else {
          if (!helper) {
            helper = await engine.createContainer({
              Image: TOOL_IMAGE,
              name: 'dtr-startup-' + randomUUID(),
              Cmd: ['sleep', String(settings.timeoutSeconds + 30)],
              Labels: {
                'io.dockertracer.project': topology.id,
                'io.dockertracer.node': node.id,
                'io.dockertracer.role': 'startup',
              },
              HostConfig: {
                NetworkMode: 'container:' + container.id,
                AutoRemove: true,
                ReadonlyRootfs: true,
                CapDrop: ['ALL'],
                SecurityOpt: ['no-new-privileges'],
                Memory: 96 * 1024 ** 2,
                NanoCpus: 250000000,
                PidsLimit: 32,
              },
            });
            await helper.start();
          }
          const attempt = await exec(engine, helper, startupCommand(settings), 5000);
          if ([126, 127].includes(attempt.exitCode)) {
            result.status = 'inconclusive';
            result.summary = 'L’outil de vérification est indisponible dans la sonde.';
            observe({ output: attempt.output.slice(-1000), exitCode: attempt.exitCode });
            break;
          }
          const status = Number(attempt.stdout.trim());
          observe({
            exitCode: attempt.exitCode,
            ...(settings.mode === 'http'
              ? { httpStatus: status || null, expectedStatus: settings.expectedStatus }
              : {}),
            output: attempt.stderr.slice(-1000),
          });
          passed =
            attempt.exitCode === 0 &&
            (settings.mode === 'tcp' || status === settings.expectedStatus);
          result.summary =
            settings.mode === 'tcp'
              ? 'Le port TCP ' + settings.port + ' ne répond pas.'
              : status
                ? 'HTTP ' + status + ' reçu ; ' + settings.expectedStatus + ' attendu.'
                : 'Aucune réponse HTTP complète reçue.';
        }
        // Require successive successful observations over two seconds, with no restart.
        const generation = info.State.StartedAt + ':' + (info.RestartCount || 0);
        if (passed) {
          if (!healthySince || healthySince.generation !== generation)
            healthySince = { at: now(), generation };
          if (now() - healthySince.at >= 2000) {
            const final = await container.inspect();
            if (
              final.State.Running &&
              !final.State.Restarting &&
              (settings.mode !== 'health' || final.State.Health?.Status === 'healthy') &&
              final.State.StartedAt === info.State.StartedAt &&
              (final.RestartCount || 0) === (info.RestartCount || 0)
            ) {
              result.status = 'passed';
              result.summary = startupDescription(settings) + ' : vérification réussie.';
              break;
            }
            healthySince = null;
          }
        } else healthySince = null;
        await sleep(Math.min(750, Math.max(0, deadline - now())));
      }
      if (result.status === 'failed' && now() >= deadline)
        result.summary = 'Délai de ' + settings.timeoutSeconds + ' s dépassé. ' + result.summary;
    }
  } catch (e) {
    result.status = 'inconclusive';
    result.summary = 'Vérification interrompue : ' + e.message;
    // The application can exit between inspection and attaching the probe.
    // Attribute a failure only when a fresh Docker observation confirms that exit.
    try {
      const info = await container.inspect();
      if (!info.State.Running || info.State.Restarting || info.State.Dead) {
        result.status = 'failed';
        result.summary = 'Le processus ne reste pas en marche (code ' + info.State.ExitCode + ').';
        observe({ state: info.State.Status, exitCode: info.State.ExitCode, probeError: e.message });
      }
    } catch {}
  } finally {
    if (result.status === 'failed') {
      try {
        result.applicationLog = decodeDockerLog(
          await container.logs({
            stdout: true,
            stderr: true,
            tail: 20,
            timestamps: true,
          }),
        ).slice(-4000);
      } catch {}
    }
    if (helper) {
      try {
        await helper.remove({ force: true });
      } catch (e) {
        if (e.statusCode !== 404) {
          result.cleanupWarning = 'Sonde à nettoyer : ' + helper.id + ' — ' + e.message;
          result.status = 'inconclusive';
          result.summary = 'Le nettoyage de la sonde n’a pas pu être confirmé.';
        }
      }
    }
    result.finishedAt = now();
  }
  return result;
}
export async function verifyStartup(engine, topology, targets, notify = () => {}) {
  const results = [],
    queue = [...targets];
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let target; (target = queue.shift());) {
        if (target.node.data.startup?.mode !== 'none' && target.node.data.startup)
          notify('Vérification de ' + target.node.data.label + '…');
        results.push(await checkStartup(engine, topology, target.node, target.container));
      }
    }),
  );
  results.sort(
    (a, b) =>
      topology.nodes.findIndex((n) => n.id === a.nodeId) -
      topology.nodes.findIndex((n) => n.id === b.nodeId),
  );
  const failures = results.filter((r) => ['failed', 'inconclusive'].includes(r.status));
  if (failures.length)
    throw Object.assign(Error(failures.map((r) => r.label + ' : ' + r.summary).join(' ')), {
      startupChecks: results,
    });
  return results;
}
