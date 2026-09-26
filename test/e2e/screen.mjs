// End-to-end check of the screen share, and of its recovery when a viewer
// loses the picture. Two real browsers, one real peer connection.
//
// Not part of `npm test` because it needs Playwright and a real Chromium:
//   npm install --no-save playwright
//   npx playwright install chromium
//   node test/e2e/screen.mjs
//
// The unit tests cover the decisions; this covers the wiring — a DOM id that
// moved, a handler that never runs, a negotiation a browser refuses. None of
// which a stub can tell you about.
import { chromium } from 'playwright';
import { createServer } from '../../src/server.js';

const EXECUTABLE = process.env.CHROMIUM_PATH || undefined;
const HOST_PASSCODE = 'HOSTS1';
const GUEST_PASSCODE = 'GUESTS';

let failures = 0;

async function until(predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const server = await createServer({
  hostPasscode: HOST_PASSCODE,
  guestPasscode: GUEST_PASSCODE,
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving on ${base}\n`);

const launch = () =>
  chromium.launch({
    executablePath: EXECUTABLE,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      // Screen capture without a picker, a human to click it, or a real screen.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--no-sandbox',
    ],
  });

async function join(browser, passcode, who) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => {
    failures += 1;
    console.log(`  FAIL  ${who} threw: ${error.message}`);
  });
  await page.goto(base);
  await page.fill('#passcode', passcode);
  await page.click('#submit');
  await page.waitForSelector('#app:not([hidden])', { timeout: 15_000 });
  return page;
}

const hostBrowser = await launch();
const guestBrowser = await launch();

try {
  const host = await join(hostBrowser, HOST_PASSCODE, 'host');
  const guest = await join(guestBrowser, GUEST_PASSCODE, 'guest');

  await host.click('#btn-share');
  const arrived = await guest
    .waitForFunction(() => document.querySelector('#video')?.srcObject != null, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check('the share reaches the other browser', arrived);
  if (!arrived) throw new Error('no picture, so there is nothing further to check');

  // Headless Chromium blocks audible autoplay, so the badge reads "Muted"
  // here. Frames actually arriving is the thing worth asserting.
  const playing = await guest.evaluate(async () => {
    const video = document.querySelector('#video');
    const first = video.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return { advanced: video.currentTime > first, width: video.videoWidth };
  });
  check('and is decoded, not just received', playing.advanced && playing.width > 0, `${playing.width}px wide`);

  await host.waitForFunction(() => !document.querySelector('#link-stats')?.hidden, { timeout: 20_000 });
  await host.waitForTimeout(3000);
  const stats = await host.textContent('#link-text');
  check('the host can see what it is sending', /kbps|Mbps/.test(stats ?? ''), stats?.trim());

  // The recovery path: take the viewer's picture away without touching the
  // host, which is what a peer that goes away without saying so looks like.
  // Nothing on the host's side notices, so the viewer has to ask.
  await guest.evaluate(() => { document.querySelector('#video').srcObject = null; });
  console.log('  ..    viewer picture dropped; host untouched');

  const recovered = await guest
    .waitForFunction(() => document.querySelector('#video')?.srcObject != null, { timeout: 40_000 })
    .then(() => true)
    .catch(() => false);
  check('the viewer gets it back without anyone intervening', recovered);

  if (recovered) {
    await host.waitForTimeout(4000);
    const after = await host.textContent('#link-text');
    check('and the recovered connection carries data', /kbps|Mbps/.test(after ?? ''), after?.trim());
  }

  // The host's own connection to the site blinks — a Wi-Fi hiccup, the tunnel
  // reconnecting. The capture and the picture are separate from it, so nobody
  // should have to press Share again: the host's browser reclaims the share.
  const hostId = server.room.sharerId;
  for (const client of server.wss.clients) {
    if (client.data.viewerId === hostId) client.socket.destroy();
  }
  console.log("  ..    host's connection to the site cut; nobody touches anything");

  const reclaimed = await until(() => server.room.sharerId && server.room.sharerId !== hostId, 20_000);
  check('the host takes the share back by itself', reclaimed);

  const pictureBack = await guest
    .waitForFunction(() => {
      const video = document.querySelector('#video');
      return video?.srcObject && video.videoWidth > 0 && !video.hidden;
    }, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check('and the picture is back on the other side', pictureBack);

  if (pictureBack) {
    const moving = await guest.evaluate(async () => {
      const video = document.querySelector('#video');
      const first = video.currentTime;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return video.currentTime > first;
    });
    check('and moving', moving);
  }
  const stillSharing = await host.textContent('#btn-share');
  check('the host never had to press Share again', /Stop sharing/.test(stillSharing ?? ''), stillSharing?.trim());
} finally {
  await hostBrowser.close();
  await guestBrowser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
