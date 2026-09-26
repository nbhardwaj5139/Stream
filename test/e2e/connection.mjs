// End-to-end check that both sides are told what the connection is doing.
//
// The host is assumed to be looking at the film, not this page, so the page is
// made to believe it does not have focus, and the notifications it raises are
// recorded. The viewer is checked by what its screen says.
//
//   npm install --no-save playwright
//   node test/e2e/connection.mjs
import { chromium } from 'playwright';
import { createServer } from '../../src/server.js';

const EXECUTABLE = process.env.CHROMIUM_PATH || undefined;
const HOST_PASSCODE = 'HOSTC1';
const GUEST_PASSCODE = 'GUESTC';

let failures = 0;
function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

const server = await createServer({ hostPasscode: HOST_PASSCODE, guestPasscode: GUEST_PASSCODE });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving on ${base}\n`);

// Every peer connection a page makes, so a test can cut one the way a network
// would; and every notification it raises.
function instrument() {
  const Real = window.RTCPeerConnection;
  window.__peers = [];
  window.RTCPeerConnection = function (...args) {
    const peer = new Real(...args);
    window.__peers.push(peer);
    return peer;
  };
  window.RTCPeerConnection.prototype = Real.prototype;

  window.__notes = [];
  window.Notification = class {
    static permission = 'granted';
    static requestPermission() { return Promise.resolve('granted'); }
    constructor(title, options = {}) { window.__notes.push(`${title} | ${options.body ?? ''}`); }
  };
  // The film is full screen in another program.
  document.hasFocus = () => false;
}

const launch = () =>
  chromium.launch({
    executablePath: EXECUTABLE,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--no-sandbox',
    ],
  });

async function join(browser, passcode, name) {
  const page = await browser.newPage();
  await page.addInitScript(instrument);
  page.on('pageerror', (error) => {
    failures += 1;
    console.log(`  FAIL  ${name} threw: ${error.message}`);
  });
  await page.goto(base);
  await page.fill('#name', name);
  await page.fill('#passcode', passcode);
  await page.click('#submit');
  await page.waitForSelector('#app:not([hidden])', { timeout: 15_000 });
  return page;
}

const notes = (page) => page.evaluate(() => window.__notes);
const overlay = (page) =>
  page.evaluate(() => (document.querySelector('#overlay').hidden ? '' : document.querySelector('#overlay-text').textContent));

async function waitFor(what, predicate, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

const hostBrowser = await launch();
const guestBrowser = await launch();

try {
  const host = await join(hostBrowser, HOST_PASSCODE, 'Sam');
  const guest = await join(guestBrowser, GUEST_PASSCODE, 'Alex');

  console.log('arriving');
  const joined = await waitFor('joined', async () => (await notes(host)).find((n) => n.startsWith('Alex joined')), 8000);
  check('the host is told when somebody joins', joined, joined);

  await host.click('#btn-share');
  await guest.waitForFunction(() => document.querySelector('#video')?.srcObject, { timeout: 30_000 });
  const watching = await waitFor('watching', async () => (await notes(host)).find((n) => n.startsWith('Alex is watching')), 10_000);
  check('and when the picture reaches them', watching, watching);

  console.log('\nthe viewer\'s picture drops');
  // Cut the viewer's end: the host's side sees its connection fail.
  await guest.evaluate(() => window.__peers.forEach((peer) => peer.close()));
  const dropped = await waitFor('dropped', async () => (await notes(host)).find((n) => n.startsWith("Alex's picture dropped")), 20_000);
  check('the host is told to pause', dropped, dropped);
  const titled = await host.title();
  check('and the tab title says so, for the taskbar', /dropped/.test(titled), titled);
  const back = await waitFor('back', async () => (await notes(host)).find((n) => n.startsWith('Alex is back')), 30_000);
  check('and told again when it is back', back, back);

  console.log('\nthe host\'s picture drops');
  // Cut the host's end: the viewer's side sees its connection go.
  await host.evaluate(() => window.__peers.forEach((peer) => peer.close()));
  const lost = await waitFor('lost', async () => /Connection lost/.test(await overlay(guest)) && (await overlay(guest)), 15_000);
  check('the viewer is told it is reconnecting', lost, lost);
  const badge = await guest.textContent('#sync-badge');
  check('and the badge agrees', /Reconnecting/.test(badge), badge);
  const recovered = await waitFor('recovered', async () => !/Connection lost|Still trying/.test(await overlay(guest)), 30_000);
  check('and the message goes once the picture is back', recovered);

  console.log('\nthe host\'s connection to the site blinks');
  const hostId = server.room.sharerId;
  for (const client of server.wss.clients) {
    if (client.data.viewerId === hostId) client.socket.destroy();
  }
  // A blink shorter than the notice delay should show the viewer nothing.
  let flashed = false;
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    if (/Lost contact/.test(await overlay(guest))) flashed = true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  check('a one-second blink shows the viewer nothing', !flashed);
  check('and the share was taken back', server.room.sharerId && server.room.sharerId !== hostId);

  console.log('\nthe host goes away for real');
  await hostBrowser.close();
  const away = await waitFor('away', async () => /Lost contact with Sam/.test(await overlay(guest)) && (await overlay(guest)), 10_000);
  check('the viewer is told they lost contact', away, away);

  console.log('\nthe viewer leaves');
  // A fresh host to be told about it.
  const secondHost = await launch();
  const host2 = await join(secondHost, HOST_PASSCODE, 'Sam');
  await host2.waitForTimeout(1500);
  await guestBrowser.close();
  const left = await waitFor('left', async () => (await notes(host2)).find((n) => n.startsWith('Alex left')), 20_000);
  check('the host is told when somebody leaves', left, left);
  await secondHost.close();
} finally {
  await hostBrowser.close().catch(() => {});
  await guestBrowser.close().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
}

console.log(failures ? `\n${failures} failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
