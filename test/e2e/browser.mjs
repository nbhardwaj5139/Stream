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
const HOST_PASSCODE = 'HOSTE2';
const GUEST_PASSCODE = 'GUESTE2';

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

const server = await createServer({
  roots: [MEDIA_DIR],
  hostPasscode: HOST_PASSCODE,
  guestPasscode: GUEST_PASSCODE,
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving ${MEDIA_DIR} on ${base}\n`);

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    // Screen capture without a picker, a human to click it, or a real screen.
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen',
  ],
});

// Join the way a real person does: open the link, type the passcode.
async function openClient(passcode, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (error) => {
    failures += 1;
    console.log(` FAIL  ${name} threw: ${error.message}`);
  });

  await page.goto(base);
  await page.fill('#name', name);
  await page.fill('#passcode', passcode);
  await page.click('#submit');

  // Chat, not the library button: the library is host-only, and #video stays
  // hidden until somebody picks a film.
  await page.waitForSelector('#btn-panel', { state: 'visible', timeout: 10_000 });
  await page.waitForFunction(
    () => document.getElementById('sync-badge')?.dataset.state !== 'offline'
  );
  return page;
}

try {
  // --- the passcode door ---------------------------------------------------
  const stranger = await browser.newContext();
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(base);
  check('an uninvited visitor gets the passcode page', await strangerPage.isVisible('#join-form'));

  await strangerPage.fill('#passcode', 'WRONG1');
  await strangerPage.click('#submit');
  await strangerPage.waitForSelector('#error:not([hidden])', { timeout: 5000 }).catch(() => {});
  check('a wrong passcode is refused', await strangerPage.isVisible('#error'));
  check('a wrong passcode does not get in', await strangerPage.isVisible('#join-form'));
  await stranger.close();

  const host = await openClient(HOST_PASSCODE, 'Host');
  const guest = await openClient(GUEST_PASSCODE, 'Guest');
  check('the right passcode gets into the room', await guest.isVisible('#btn-panel'));

  // --- the library is the host's alone -------------------------------------
  check('the guest has no library button', !(await guest.isVisible('#btn-library')));
  check('the host does have one', await host.isVisible('#btn-library'));
  check(
    'the guest is told to wait rather than offered a browse button',
    !(await guest.isVisible('#placeholder-browse'))
  );

  await host.click('#btn-library');
  const titles = await host.$$eval('#library-list .title', (nodes) => nodes.map((n) => n.textContent));
  check('library lists the video file', titles.length >= 1, titles.join(', '));

  // --- the other side is told somebody is choosing -------------------------
  const chooserShown = await until(async () =>
    /is choosing/.test(await guest.textContent('#placeholder-title'))
  );
  check('the guest is told the host is choosing', chooserShown, await guest.textContent('#placeholder-title'));

  // --- host picks something -----------------------------------------------
  await host.click('#library-list button');
  const loaded = await until(async () => (await videoState(guest)).src !== null);
  check('the guest loads the file the host picked', loaded);
  check('the guest hit no media error', (await videoState(guest)).error === null);

  // A browser handed something it cannot decode must work its way down the
  // delivery chain rather than giving up on the film.
  const chain = await guest.evaluate(() => {
    const probe = document.createElement('video');
    const nativeHls = Boolean(probe.canPlayType('application/vnd.apple.mpegurl'));
    return { nativeHls };
  });
  check('the browser picks a delivery route', typeof chain.nativeHls === 'boolean');

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

  // --- pause stays paused --------------------------------------------------
  // A viewer recovering from a stall used to resume the film even though
  // someone had deliberately paused it.
  await guest.evaluate(() => {
    const video = document.getElementById('video');
    video.dispatchEvent(new Event('waiting'));
  });
  await wait(2600);
  const stillPaused = await videoState(host);
  check('a deliberate pause survives a buffering report', stillPaused.paused);

  // --- stopping ------------------------------------------------------------
  check('the host has a stop button while something is playing', await host.isVisible('#btn-stop'));
  check('the guest does not', !(await guest.isVisible('#btn-stop')));

  await host.click('#btn-stop');
  const cleared = await until(async () => await guest.isVisible('#placeholder'));
  check('stopping returns both sides to the empty room', cleared);
  // The host processes its own broadcast independently, so wait for it rather
  // than assuming it landed in the same instant as the guest's.
  const hidden = await until(async () => !(await host.isVisible('#btn-stop')));
  check('the stop button hides once nothing is playing', hidden);

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

  check('the host is told they are the host', (await host.textContent('#role-badge')) === 'Host');
  check('the guest is told they are a guest', (await guest.textContent('#role-badge')) === 'Guest');

  // --- installable, and the manifest actually parses -----------------------
  const manifest = await host.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return null;
    const response = await fetch(link.href);
    return { type: response.headers.get('content-type'), body: await response.json() };
  });
  check('the page offers a web manifest', manifest !== null);
  check('it is served as a manifest', /manifest\+json/.test(manifest?.type ?? ''), manifest?.type);
  check('it is installable standalone', manifest?.body?.display === 'standalone');
  check('it has icons', (manifest?.body?.icons?.length ?? 0) >= 2);

  const iconOk = await host.evaluate(async () => {
    const response = await fetch('/static/icon-180.png');
    return response.ok && (response.headers.get('content-type') ?? '').includes('png');
  });
  check('the home-screen icon loads', iconOk);
  check('there is a fullscreen control', await host.isVisible('#btn-fullscreen'));
  // Installed to a home screen there is no browser chrome, so the page carries
  // its own reload.
  check('there is a reload control', await host.isVisible('#btn-reload'));
  const reloaded = await host.evaluate(async () => {
    document.getElementById('btn-reload').click();
    return true;
  });
  check('reload is wired up', reloaded);
  await host.waitForSelector('#join-form', { state: 'visible', timeout: 10_000 });
  check('reloading lands back on the passcode screen', await host.isVisible('#join-form'));

  await host.fill('#passcode', HOST_PASSCODE);
  await host.click('#submit');
  await host.waitForSelector('#btn-panel', { state: 'visible', timeout: 10_000 });

  // --- the state is described in words -------------------------------------
  const guestIdle = await guest.textContent('#sync-badge');
  check('an idle room says so plainly', guestIdle === 'Nothing playing', guestIdle);

  await host.click('#btn-library');
  await host.click('#library-list button');
  await until(async () => (await videoState(guest)).src !== null);
  await host.evaluate(() => document.getElementById('video').play());
  const playing = await until(async () => (await host.textContent('#sync-badge')) === 'Playing');
  check('a playing room says "Playing"', playing, await host.textContent('#sync-badge'));

  await host.evaluate(() => document.getElementById('video').pause());
  const pausedWord = await until(async () => (await guest.textContent('#sync-badge')) === 'Paused');
  check('a paused room says "Paused" on the other side', pausedWord, await guest.textContent('#sync-badge'));

  const buttonLabel = await host.textContent('#btn-library');
  check('the library button says what it does now', /Change film/.test(buttonLabel), buttonLabel.trim());

  // --- screen sharing ------------------------------------------------------
  check('only the host is offered screen sharing', await host.isVisible('#btn-share'));
  check('the guest is not', !(await guest.isVisible('#btn-share')));

  await host.click('#btn-share');

  const inScreenMode = await until(
    async () => (await guest.textContent('#sync-badge')) === 'Watching their screen',
    { timeout: 15_000 }
  );
  check('the guest is switched to the shared screen', inScreenMode, await guest.textContent('#sync-badge'));

  // The real test: a live track actually arriving over WebRTC.
  const received = await until(async () => {
    const state = await guest.evaluate(() => {
      const video = document.getElementById('video');
      const stream = video.srcObject;
      return {
        tracks: stream ? stream.getVideoTracks().length : 0,
        live: stream ? stream.getVideoTracks().every((t) => t.readyState === 'live') : false,
        width: video.videoWidth,
      };
    });
    return state.tracks > 0 && state.live && state.width > 0;
  }, { timeout: 25_000 });

  const detail = await guest.evaluate(() => {
    const video = document.getElementById('video');
    return `${video.videoWidth}x${video.videoHeight}`;
  });
  check('the host\u2019s screen reaches the guest over WebRTC', received, detail);

  const hostBadge = await host.textContent('#sync-badge');
  check('the host is told they are sharing', hostBadge === 'Sharing your screen', hostBadge);

  await host.click('#btn-share');
  const backToFiles = await until(
    async () => (await guest.textContent('#sync-badge')) !== 'Watching their screen',
    { timeout: 15_000 }
  );
  check('stopping the share returns the room to files', backToFiles);

  // --- the session survives a reload ---------------------------------------
  await guest.reload();
  await guest.waitForSelector('#join-form', { state: 'visible', timeout: 10_000 });
  check('a reload asks for the passcode again', await guest.isVisible('#join-form'));
  check('and the room is not shown behind it', !(await guest.isVisible('#btn-panel')));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(failures === 0 ? '\nall end-to-end checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
