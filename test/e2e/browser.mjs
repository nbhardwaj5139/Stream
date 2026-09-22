// End-to-end check: two real browsers, two links, one movie, staying in sync.
//
// Not part of `npm test` because it needs Playwright and a video file:
//   npm install --no-save playwright
//   node test/e2e/browser.mjs /path/to/a/folder/with/one/video
import { chromium } from 'playwright';
import path from 'node:path';
import { createServer } from '../../src/server.js';

const MEDIA_DIR = process.argv[2] ?? path.join(process.cwd(), 'test', 'fixtures');
const EXECUTABLE = process.env.CHROMIUM_PATH || undefined;
const HOST_KEY = '1'.repeat(32);
const GUEST_KEY = '2'.repeat(32);

let failures = 0;
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, { timeout = 10_000, interval = 150 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await wait(interval);
  }
  return false;
}

const videoState = (page) =>
  page.evaluate(() => {
    const video = document.getElementById('video');
    return {
      paused: video.paused,
      time: video.currentTime,
      readyState: video.readyState,
      src: video.getAttribute('src'),
      rate: video.playbackRate,
      error: video.error?.code ?? null,
    };
  });

const server = await createServer({ roots: [MEDIA_DIR], hostKey: HOST_KEY, guestKey: GUEST_KEY });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving ${MEDIA_DIR} on ${base}\n`);

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

async function openClient(key, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept(name));
  page.on('pageerror', (error) => {
    failures += 1;
    console.log(` FAIL  ${name} threw: ${error.message}`);
  });
  await page.goto(`${base}/?k=${key}`);
  await page.waitForFunction(() => document.getElementById('sync-badge')?.textContent !== 'reconnecting');
  return page;
}

try {
  const host = await openClient(HOST_KEY, 'Host');
  const guest = await openClient(GUEST_KEY, 'Guest');

  // --- the library both sides see -----------------------------------------
  await host.click('#btn-library');
  const titles = await host.$$eval('#library-list .title', (nodes) => nodes.map((n) => n.textContent));
  check('library lists the video file', titles.length >= 1, titles.join(', '));

  // --- host picks something -----------------------------------------------
  await host.click('#library-list button');
  const loaded = await until(async () => (await videoState(guest)).src !== null);
  check('the guest loads the file the host picked', loaded);
  check('the guest hit no media error', (await videoState(guest)).error === null);

  const ready = await until(async () => (await videoState(guest)).readyState >= 2, { timeout: 15_000 });
  check('the guest has decodable video', ready, `readyState ${(await videoState(guest)).readyState}`);

  // --- play ---------------------------------------------------------------
  await host.evaluate(() => document.getElementById('video').play());
  const bothPlaying = await until(async () => {
    const [h, g] = await Promise.all([videoState(host), videoState(guest)]);
    return !h.paused && !g.paused;
  });
  check('pressing play on one side starts the other', bothPlaying);

  await wait(3000);
  const [h1, g1] = await Promise.all([videoState(host), videoState(guest)]);
  check('both sides advanced past the start', h1.time > 1 && g1.time > 1, `host ${h1.time.toFixed(2)}s, guest ${g1.time.toFixed(2)}s`);
  check(
    'the two sides are within a second of each other',
    Math.abs(h1.time - g1.time) < 1,
    `drift ${Math.abs(h1.time - g1.time).toFixed(3)}s`
  );

  // --- seeking ------------------------------------------------------------
  await host.evaluate(() => { document.getElementById('video').currentTime = 12; });
  const followed = await until(async () => (await videoState(guest)).time > 11);
  const [h2, g2] = await Promise.all([videoState(host), videoState(guest)]);
  check('a seek on one side moves the other', followed, `host ${h2.time.toFixed(2)}s, guest ${g2.time.toFixed(2)}s`);

  // --- pause from the other side ------------------------------------------
  await guest.evaluate(() => document.getElementById('video').pause());
  const bothPaused = await until(async () => {
    const [h, g] = await Promise.all([videoState(host), videoState(guest)]);
    return h.paused && g.paused;
  });
  check('either side can pause for both', bothPaused);

  const before = (await videoState(host)).time;
  await wait(1500);
  check('paused means paused', Math.abs((await videoState(host)).time - before) < 0.3);

  // --- chat ---------------------------------------------------------------
  await guest.click('#btn-panel');
  await guest.fill('#chat-input', 'this is the good bit');
  await guest.click('#composer button');
  await host.click('#btn-panel');
  const arrived = await host.waitForFunction(
    () => document.getElementById('chat')?.textContent?.includes('this is the good bit'),
    { timeout: 5000 }
  ).then(() => true).catch(() => false);
  check('chat reaches the other side', arrived);

  // --- presence -----------------------------------------------------------
  const presence = await host.$eval('#presence', (node) => node.textContent);
  check('both viewers show in presence', /Host/.test(presence) && /Guest/.test(presence), presence);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(failures === 0 ? '\nall end-to-end checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
