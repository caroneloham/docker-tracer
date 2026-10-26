import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { dockerSshEndpoint } from './docker-ssh.fixture.mjs';

// A Linux CLI next to the same real test daemon. The shared volume is mounted at its
// actual daemon path, so bind/config/secret resolution is tested without Desktop sharing.
export async function composeLinuxEndpoint(dir, engine) {
  const name = 'dtr-compose-linux-' + randomUUID();
  const volume = await (await engine.createVolume({ Name: name })).inspect();
  let container, ssh;
  try {
    container = await engine.createContainer({
      name,
      Image: 'docker:cli',
      Cmd: ['sleep', 'infinity'],
      HostConfig: {
        Binds: ['/var/run/docker.sock:/var/run/docker.sock', `${name}:${volume.Mountpoint}`],
      },
    });
    await container.start();
    const execute = async (script) => {
      const exec = await container.exec({
          Cmd: ['sh', '-c', script],
          AttachStdout: true,
          AttachStderr: true,
        }),
        stream = await exec.start({ hijack: true, stdin: false });
      const out = new PassThrough(),
        err = new PassThrough();
      let stdout = '',
        stderr = '';
      out.on('data', (b) => (stdout += b));
      err.on('data', (b) => (stderr += b));
      engine.modem.demuxStream(stream, out, err);
      await new Promise((r, j) => {
        stream.once('end', r);
        stream.once('error', j);
      });
      const result = await exec.inspect();
      return { stdout, stderr, code: result.ExitCode };
    };
    const run = async (script) => {
      const result = await execute(script);
      if (result.code !== 0)
        throw Error(result.stderr || result.stdout || 'Code Linux : ' + result.code);
      return result.stdout;
    };
    const shell = (channel) => {
      let script = '';
      channel.on('data', (b) => (script += b));
      channel.on('end', async () => {
        try {
          const result = await execute(script);
          channel.write(result.stdout);
          channel.stderr.write(result.stderr);
          channel.exit(result.code ?? 1);
          channel.end();
        } catch (e) {
          channel.stderr.write(e.message);
          channel.exit(1);
          channel.end();
        }
      });
    };
    ssh = await dockerSshEndpoint(dir, engine, shell);
    return {
      ...ssh,
      directory: volume.Mountpoint,
      run,
      close: async () => {
        await ssh.close();
        await container.remove({ force: true });
        await engine.getVolume(name).remove();
      },
    };
  } catch (e) {
    await ssh?.close();
    await container?.remove({ force: true });
    await engine.getVolume(name).remove();
    throw e;
  }
}
