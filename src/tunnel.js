// Puts the local server on a public https:// URL so the other side can reach it
// without port forwarding. Uses cloudflared's free quick tunnels.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export async function hasCloudflared() {
  try {
    await execFileAsync('cloudflared', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// A named tunnel routes a domain you own to this machine. Unlike a quick
// tunnel the address never changes, so the link you sent stays good forever.
// Ingress lives in cloudflared's own config, so all we do is run it.
export function startNamedTunnel(name, { timeoutMs = 45_000 } = {}) {
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', 'run', name], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let log = '';

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ url: null, named: name, stop: () => child.kill('SIGTERM'), process: child });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`cloudflared did not connect within ${Math.round(timeoutMs / 1000)}s\n${log}`));
    }, timeoutMs);

    const inspect = (chunk) => {
      const text = chunk.toString();
      log = (log + text).slice(-8000);
      // cloudflared logs one of these once an edge connection is established.
      if (/Registered tunnel connection|Connection [a-f0-9-]+ registered/i.test(text)) finish();
    };

    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited with code ${code}\n${log}`));
    });
  });
}

export function startTunnel(port, { timeoutMs = 45_000 } = {}) {
  const child = spawn(
    'cloudflared',
    ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let log = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`cloudflared did not produce a URL within ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const inspect = (chunk) => {
      const text = chunk.toString();
      log = (log + text).slice(-8000);
      const match = URL_PATTERN.exec(text);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          url: match[0],
          stop: () => child.kill('SIGTERM'),
          process: child,
        });
      }
    };

    // cloudflared prints the URL on stderr; watch both to be safe.
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited with code ${code}\n${log}`));
    });
  });
}

// Keep a tunnel up for as long as the room runs.
//
// Started at login, the internet is often a few seconds behind Windows; left
// running all day, a laptop sleeps, changes network, loses Wi-Fi for a minute.
// Any of those used to leave the room serving locally while the public address
// showed Cloudflare's error page until somebody noticed and restarted it. So:
// if it will not start, try again; if it stops, start it again; never give up
// while the room is running.
const RETRY_DELAYS_MS = [2000, 5000, 10_000, 20_000, 30_000];

export function superviseTunnel({
  start,
  onUp = () => {},
  onDown = () => {},
  onWaiting = () => {},
  delays = RETRY_DELAYS_MS,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let stopped = false;
  let current = null;
  let resolveFirst;
  const ready = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  (async () => {
    let failures = 0;
    while (!stopped) {
      let tunnel;
      try {
        tunnel = await start();
      } catch (error) {
        if (stopped) return;
        const delay = delays[Math.min(failures, delays.length - 1)];
        failures += 1;
        onWaiting(error, delay, failures);
        await wait(delay);
        continue;
      }

      if (stopped) {
        tunnel.stop();
        return;
      }
      failures = 0;
      current = tunnel;
      onUp(tunnel);
      resolveFirst(tunnel);

      const code = await new Promise((resolve) => tunnel.process.once('close', resolve));
      current = null;
      if (stopped) return;
      onDown(code);
      // A moment's pause, so a tunnel that dies the instant it starts does not
      // spin.
      await wait(delays[0]);
    }
  })();

  return {
    ready,
    get current() {
      return current;
    },
    stop() {
      stopped = true;
      current?.stop();
    },
  };
}

// cloudflared's failure is a page of timestamped log. One line of it is the
// reason; the rest is noise to somebody glancing at a window.
export function summariseTunnelError(error) {
  const text = String(error?.message ?? error ?? '');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const reason = lines.find((line) => /\bERR\b|error|failed|unable|cannot|could not/i.test(line)) ?? lines[0];
  if (!reason) return 'no reason given';
  // Drop the "2026-09-24T10:00:00Z ERR " prefix cloudflared puts on each line.
  return reason.replace(/^\S*\d{4}-\d{2}-\d{2}T\S+\s+(ERR|WRN|INF)\s+/, '').slice(0, 160);
}
