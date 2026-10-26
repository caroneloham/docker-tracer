// Browser fixture only. No Docker client, subprocess, image or network connection.
import { Duplex, Readable } from 'node:stream';
import path from 'node:path';
import tar from 'tar-stream';

export function createWorkbenchDockerFixture({
  id = 'a'.repeat(64),
  name = 'maintenance-demo-web',
  hostId = 'local',
} = {}) {
  const files = new Map([
    [
      '/etc/app.conf',
      Buffer.from('# Configuration fictive pour les tests navigateur\nport=8080\n'),
    ],
    [
      '/etc/nginx/nginx.conf',
      Buffer.from('# Configuration fictive\nevents {}\nhttp { server { listen 8080; } }\n'),
    ],
  ]);
  const dirs = new Set(['/', '/etc', '/etc/nginx']);
  const streams = new Set();
  const container = {
    async inspect() {
      return {
        Id: id,
        Name: '/' + name,
        State: { Running: true, Paused: false },
        Config: { Labels: {} },
      };
    },
    async infoArchive({ path: target }) {
      const info =
        target === '/bin/sh'
          ? { name: 'sh', mode: 0o755, size: 1 }
          : files.has(target)
            ? { name: path.posix.basename(target), mode: 0o644, size: files.get(target).length }
            : dirs.has(target)
              ? { name: path.posix.basename(target), mode: 0x80000000 + 0o755, size: 0 }
              : null;
      if (!info)
        throw Object.assign(Error('Fichier absent du scénario de test.'), { statusCode: 404 });
      return {
        headers: {
          'x-docker-container-path-stat': Buffer.from(JSON.stringify(info)).toString('base64'),
        },
        resume() {},
      };
    },
    async getArchive({ path: target }) {
      const data = files.get(target);
      if (!data)
        throw Object.assign(Error('Fichier absent du scénario de test.'), { statusCode: 404 });
      const pack = tar.pack();
      pack.entry(
        {
          name: path.posix.basename(target),
          size: data.length,
          type: 'file',
          uid: 1000,
          gid: 1000,
          mode: 0o644,
        },
        data,
      );
      pack.finalize();
      return pack;
    },
    async putArchive(buffer, { path: target }) {
      const extract = tar.extract();
      const done = new Promise((resolve, reject) => {
        extract.on('entry', (header, stream, next) => {
          const data = [];
          stream.on('data', (chunk) => data.push(chunk));
          stream.on('end', () => {
            files.set(path.posix.join(target, header.name), Buffer.concat(data));
            next();
          });
          stream.on('error', reject);
        });
        extract.on('finish', resolve);
        extract.on('error', reject);
      });
      if (Buffer.isBuffer(buffer)) extract.end(buffer);
      else buffer.pipe(extract);
      await done;
    },
    async exec(settings) {
      let terminalSize = { cols: 120, rows: 30 };
      let active = false;
      return {
        async start() {
          if (!settings.Tty) {
            const target = settings.Cmd.at(-1),
              entries = [];
            for (const dir of dirs)
              if (dir !== target && path.posix.dirname(dir) === target)
                entries.push('directory\0' + path.posix.basename(dir) + '\0');
            for (const filename of files.keys())
              if (path.posix.dirname(filename) === target)
                entries.push('file\0' + path.posix.basename(filename) + '\0');
            return Readable.from([Buffer.from(entries.join(''))]);
          }
          let cwd = '/',
            input = [],
            cursor = 0,
            escape = '',
            historyIndex = 0,
            waiting = false,
            fullscreen = false;
          const history = [];
          const prompt = () => `\x1b[36mfixture:${cwd}\x1b[0m $ `;
          const redraw = () => {
            stream.push('\r\x1b[2K' + prompt() + input.join(''));
            if (cursor < input.length) stream.push(`\x1b[${input.length - cursor}D`);
          };
          const replaceInput = (value) => {
            input = [...value];
            cursor = input.length;
            redraw();
          };
          const execute = () => {
            const line = input.join('').trim();
            stream.push('\r\n');
            if (line) {
              history.push(line);
              if (history.length > 50) history.shift();
            }
            historyIndex = history.length;
            input = [];
            cursor = 0;
            if (line === 'exit') {
              active = false;
              stream.push('Session fictive fermée.\r\n');
              stream.push(null);
              return;
            }
            if (line.startsWith('cd ')) {
              const next = path.posix.resolve(cwd, line.slice(3).trim());
              if (dirs.has(next)) cwd = next;
              else stream.push('Dossier absent du scénario synthétique.\r\n');
            } else if (line === 'pwd') stream.push(cwd + '\r\n');
            else if (line === 'stty size')
              stream.push(`${terminalSize.rows} ${terminalSize.cols}\r\n`);
            else if (line === 'echo $TERM') stream.push('xterm-256color\r\n');
            else if (line.startsWith('echo ')) stream.push(line.slice(5) + '\r\n');
            else if (line === 'help')
              stream.push(
                'SIMULATION : pwd, cd, echo, stty size, ansi, clear, demo, sleep 30, exit. Tab complète les chemins, flèches haut/bas rappellent les commandes.\r\n',
              );
            else if (line === 'ansi')
              stream.push(
                '\x1b[31mRouge\x1b[0m · \x1b[32mVert\x1b[0m · \x1b[1mGras\x1b[0m · élève 🐳\r\n',
              );
            else if (line === 'clear') stream.push('\x1b[2J\x1b[H');
            else if (line === 'demo') {
              fullscreen = true;
              stream.push(
                '\x1b[?1049h\x1b[2J\x1b[H\x1b[1;36mÉCRAN ALTERNATIF SIMULÉ\x1b[0m\r\nAucun processus exécuté. Appuie sur q pour revenir au shell.\r\n',
              );
              return;
            } else if (/^sleep(?:\s|$)/.test(line)) {
              waiting = true;
              stream.push('[Attente simulée : Ctrl+C pour interrompre.]\r\n');
              return;
            } else if (line)
              stream.push(
                '[Simulation navigateur : commande reçue, aucun processus réel exécuté.]\r\n',
              );
            redraw();
          };
          const sequence = (value) => {
            if (value === '\x1b[A') {
              historyIndex = Math.max(0, historyIndex - 1);
              replaceInput(history[historyIndex] || '');
            } else if (value === '\x1b[B') {
              historyIndex = Math.min(history.length, historyIndex + 1);
              replaceInput(history[historyIndex] || '');
            } else if (value === '\x1b[D') {
              cursor = Math.max(0, cursor - 1);
              redraw();
            } else if (value === '\x1b[C') {
              cursor = Math.min(input.length, cursor + 1);
              redraw();
            } else if (['\x1b[H', '\x1bOH'].includes(value)) {
              cursor = 0;
              redraw();
            } else if (['\x1b[F', '\x1bOF'].includes(value)) {
              cursor = input.length;
              redraw();
            } else if (value === '\x1b[3~') {
              input.splice(cursor, 1);
              redraw();
            }
          };
          const type = (character) => {
            if (!active) return;
            if (fullscreen) {
              if (character === 'q' || character === '\x03') {
                fullscreen = false;
                stream.push('\x1b[?1049l');
                redraw();
              }
              return;
            }
            if (character === '\x03') {
              waiting = false;
              escape = '';
              input = [];
              cursor = 0;
              stream.push('^C\r\n');
              redraw();
              return;
            }
            if (waiting) return;
            if (escape) {
              escape += character;
              if (escape.length > 16 || (escape.length > 2 && /[A-Za-z~]$/.test(escape))) {
                sequence(escape);
                escape = '';
              }
              return;
            }
            if (character === '\x1b') {
              escape = character;
              return;
            }
            if (character === '\r' || character === '\n') {
              execute();
              return;
            }
            if (character === '\x7f' || character === '\b') {
              if (cursor > 0) input.splice(--cursor, 1);
              redraw();
              return;
            }
            if (character === '\x04') {
              if (!input.length) {
                active = false;
                stream.push('\r\nSession fictive fermée.\r\n');
                stream.push(null);
              }
              return;
            }
            if (character === '\x01') {
              cursor = 0;
              redraw();
              return;
            }
            if (character === '\x05') {
              cursor = input.length;
              redraw();
              return;
            }
            if (character === '\t') {
              const before = input.slice(0, cursor).join(''),
                word = before.split(/\s/).at(-1);
              const candidates = [...dirs, ...files.keys()].filter(
                (item) => item !== '/' && item.startsWith(word),
              );
              if (candidates.length === 1) {
                const completion = candidates[0] + (dirs.has(candidates[0]) ? '/' : ' ');
                const suffix = [...completion.slice(word.length)];
                input.splice(cursor, 0, ...suffix);
                cursor += suffix.length;
                redraw();
              } else {
                stream.push('\x07');
              }
              return;
            }
            if (character >= ' ') {
              input.splice(cursor++, 0, character);
              redraw();
            }
          };
          const stream = new Duplex({
            read() {},
            write(chunk, _encoding, callback) {
              for (const character of chunk.toString()) type(character);
              callback();
            },
          });
          active = true;
          streams.add(stream);
          stream.on('close', () => {
            active = false;
            streams.delete(stream);
          });
          queueMicrotask(() => {
            stream.push(
              '\x1b[33mSESSION SIMULÉE · aucun Docker ni processus réel.\x1b[0m\r\nTape help pour le scénario de test.\r\n',
            );
            redraw();
          });
          return stream;
        },
        async inspect() {
          return { Running: active, ExitCode: active ? null : 0 };
        },
        async resize({ w, h }) {
          terminalSize = { cols: w, rows: h };
        },
      };
    },
  };
  const docker = {
    getContainer(target) {
      if (target !== id)
        throw Object.assign(Error('Conteneur absent du scénario de test.'), { statusCode: 404 });
      return container;
    },
    modem: {
      demuxStream(stream, stdout) {
        stream.pipe(stdout);
      },
    },
  };
  const hosts = {
    profile(target) {
      if (target !== hostId)
        throw Object.assign(Error('Hôte absent du scénario de test.'), { statusCode: 404 });
      return { id: hostId };
    },
    async client(target) {
      this.profile(target);
      return docker;
    },
  };
  return {
    docker,
    hosts,
    container,
    files,
    id,
    name,
    dispose() {
      for (const stream of streams) stream.destroy();
    },
  };
}
