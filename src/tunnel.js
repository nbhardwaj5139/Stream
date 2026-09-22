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
