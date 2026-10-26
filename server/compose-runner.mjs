import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { composeSettings, composeDocument } from '../shared/compose-project.mjs';
import { composeTransport } from './compose-transport.mjs';
import { runRemoteCompose } from './compose-remote.mjs';

export function composeEnvironment(variables = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|DOCKER_CONFIG)$/i.test(
        key,
      )
    )
      env[key] = value;
  for (const [key, value] of Object.entries(variables)) {
    if (
      /^(DOCKER_|COMPOSE_|PATH$|HOME$|USERPROFILE$|SYSTEMROOT$|WINDIR$|APPDATA$|LOCALAPPDATA$|LD_|DYLD_|NODE_OPTIONS$)/i.test(
        key,
      )
    )
      throw Error(
        `La variable ${key} est réservée au lancement de Docker. Choisis un nom applicatif.`,
      );
    env[key] = value;
  }
  // An explicit empty value overrides COMPOSE_PROFILES in a chosen .env file.
  // Only the profiles selected in this project's settings may activate services.
  return {
    ...env,
    COMPOSE_PROFILES: '',
    COMPOSE_MENU: 'false',
    COMPOSE_ANSI: 'never',
    COMPOSE_PROGRESS: 'plain',
  };
}
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid || child.dtrStopping)
    return;
  child.dtrStopping = true;
  if (process.platform === 'win32')
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }
      }, 5000);
      force.unref();
      child.once('close', () => clearTimeout(force));
    } catch {}
  }
}
export function createComposeRunner({ dataDir, hosts }) {
  const root = path.resolve(dataDir, 'compose-jobs'),
    active = new Set(),
    remoteActive = new Set();
  return {
    async withProject(input, hostId, fn) {
      const settings = composeSettings.parse(input);
      composeDocument(settings.source);
      composeEnvironment(settings.variables);
      if (hostId !== 'local') {
        const options = await hosts.sshOptions(hostId),
          remoteSettings = {
            ...settings,
            variables: { ...settings.variables, COMPOSE_PROFILES: '' },
          };
        return fn({
          run: (args, opts) => runRemoteCompose(options, remoteSettings, args, remoteActive, opts),
          settings,
          directory: settings.directory,
        });
      }
      await mkdir(root, { recursive: true, mode: 0o700 });
      const dir = await mkdtemp(path.join(root, 'job-'));
      let transport;
      try {
        const directory = settings.directory || path.join(root, 'context');
        if (!path.isAbsolute(directory))
          throw Error('Le dossier du projet doit être un chemin absolu sur ce PC.');
        if (!settings.directory) await mkdir(directory, { recursive: true, mode: 0o700 });
        if (!(await stat(directory)).isDirectory()) throw Error('Dossier Compose introuvable.');
        const source = path.join(dir, 'compose.yaml'),
          empty = path.join(dir, 'empty.env');
        await writeFile(source, settings.source, { mode: 0o600 });
        await writeFile(empty, '', { mode: 0o600 });
        const env = composeEnvironment(settings.variables);
        const envFile = settings.useDotEnv ? path.join(directory, '.env') : empty;
        transport = await composeTransport(hosts, hostId);
        const prefix = [
          '--host',
          transport.host,
          'compose',
          '--ansi',
          'never',
          '--progress',
          'plain',
          '--parallel',
          '4',
          '--project-directory',
          directory,
          '--project-name',
          settings.projectName,
          '--env-file',
          envFile,
          '--file',
          source,
          ...settings.profiles.flatMap((p) => ['--profile', p]),
        ];
        const run = (args, { timeout = 15 * 60 * 1000, notify = () => {}, json = false } = {}) =>
          new Promise((resolve, reject) => {
            const child = spawn('docker', [...prefix, ...args], {
              cwd: directory,
              env,
              windowsHide: true,
              shell: false,
              detached: process.platform !== 'win32',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            active.add(child);
            let stdout = '',
              stderr = '',
              tooLarge = false,
              timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              stop(child);
            }, timeout);
            child.stdout.on('data', (b) => {
              stdout += b.toString();
              if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) {
                tooLarge = true;
                stop(child);
              }
              if (!json) notify(b.toString());
            });
            child.stderr.on('data', (b) => {
              stderr = (stderr + b.toString()).slice(-64000);
              if (!json) notify(b.toString());
            });
            child.once('error', (e) => {
              clearTimeout(timer);
              active.delete(child);
              reject(
                Error(
                  e.code === 'ENOENT'
                    ? 'Docker CLI et Compose doivent être installés sur ce PC.'
                    : e.message,
                ),
              );
            });
            child.once('close', (code) => {
              clearTimeout(timer);
              active.delete(child);
              if (timedOut || tooLarge || code !== 0)
                return reject(
                  Object.assign(
                    Error(
                      timedOut
                        ? 'Délai Compose dépassé. Vérifie l’état réel avant de réessayer.'
                        : tooLarge
                          ? 'Sortie Compose trop volumineuse.'
                          : stderr.trim() || stdout.trim() || `Compose s’est arrêté (${code}).`,
                    ),
                    { output: (stdout + '\n' + stderr).slice(-64000), inconclusive: timedOut },
                  ),
                );
              resolve({ stdout, stderr, code });
            });
          });
        return await fn({ run, settings, directory });
      } finally {
        await transport?.close();
        if (path.dirname(dir) !== root || !path.basename(dir).startsWith('job-'))
          throw Error('Unexpected Compose working directory');
        await rm(dir, { recursive: true, force: true });
      }
    },
    async shutdown() {
      const remotes = [...remoteActive];
      for (const job of remotes) job.stop();
      await Promise.all(remotes.map((job) => job.done));
      const jobs = [...active];
      for (const child of jobs) stop(child);
      await Promise.all(
        jobs.map((child) =>
          child.exitCode !== null ? undefined : new Promise((r) => child.once('close', r)),
        ),
      );
    },
  };
}
