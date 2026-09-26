// Client: joins the room, and either shares this screen or shows the one that
// is being shared.
import { DEFAULT_ICE_SERVERS, ScreenShare } from './screen.js';
import { ConnectionProbe, describeProbeResult } from './probe.js';
import { describeSelfTest, selfTest } from './selftest.js';
import { StatsSampler, describeStats, statsVerdict } from './stats.js';
import { WakeLock } from './wakelock.js';

const el = (id) => document.getElementById(id);
const dom = {
  app: el('app'),
  video: el('video'),
  placeholder: el('placeholder'),
  placeholderTitle: el('placeholder-title'),
  placeholderText: el('placeholder-text'),
  placeholderHint: el('placeholder-hint'),
  overlay: el('overlay'),
  overlayText: el('overlay-text'),
  roleBadge: el('role-badge'),
  nowShowing: el('now-showing'),
  syncBadge: el('sync-badge'),
  btnSound: el('btn-sound'),
  soundLabel: el('sound-label'),
  screen: document.querySelector('.screen'),
  btnFullscreen: el('btn-fullscreen'),
  btnReload: el('btn-reload'),
  btnExit: el('btn-exit'),
  btnShare: el('btn-share'),
  btnPanel: el('btn-panel'),
  panelLabel: el('panel-label'),
  btnPanelClose: el('btn-panel-close'),
  btnLeave: el('btn-leave'),
  btnTest: el('btn-test'),
  linkStats: el('link-stats'),
  linkText: el('link-text'),
  presence: el('presence'),
  chat: el('chat'),
  composer: el('composer'),
  chatInput: el('chat-input'),
  toast: el('toast'),
  gate: el('gate'),
  joinForm: el('join-form'),
  joinName: el('name'),
  joinPasscode: el('passcode'),
  joinSubmit: el('submit'),
  joinError: el('error'),
};

const state = {
  me: null,
  role: 'guest',
  room: null,
  viewers: [],
  capabilities: {},
  probeIceServers: [],
  socket: null,
  connected: false,
  needsGesture: false,
  entered: false,
  // Set when this browser reconnects while still holding a capture: the room
  // forgot the share when the old connection went, so claim it back and offer
  // the picture to everyone again as soon as we know who is here.
  reclaimShare: false,
};

// ------------------------------------------------------------------ misc --

let toastTimer = null;
function toast(text, ms = 3600) {
  dom.toast.textContent = text;
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, ms);
}

const showOverlay = (text, { sound = false } = {}) => {
  dom.overlayText.replaceChildren();
  if (sound) {
    const pill = document.createElement('span');
    pill.className = 'tap-for-sound';
    pill.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
    pill.append(document.createTextNode(text));
    dom.overlayText.append(pill);
  } else {
    dom.overlayText.textContent = text;
  }
  dom.overlay.hidden = false;
};
const hideOverlay = () => { dom.overlay.hidden = true; };

const isScreenMode = () => Boolean(state.room?.sharerId);
const others = () => state.viewers.filter((viewer) => viewer.id !== state.me?.id);
const nameOf = (id) => state.viewers.find((viewer) => viewer.id === id)?.name ?? 'the other side';

function listNames(viewers, verb) {
  if (viewers.length === 0) return '';
  const names = viewers.map((viewer) => viewer.name).join(' and ');
  return `${names} ${viewers.length === 1 ? verb[0] : verb[1]}`;
}

// --------------------------------------------------------------- network --

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

let reconnectDelay = 500;

function connect() {
  const url = new URL('/ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  const socket = new WebSocket(url);
  state.socket = socket;

  socket.addEventListener('open', () => {
    state.connected = true;
    reconnectDelay = 500;
    updateSyncBadge();
    const name = localStorage.getItem('stream:name');
    if (name) send({ type: 'hello', name });
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(message);
  });

  socket.addEventListener('close', async () => {
    state.connected = false;
    updateSyncBadge();
    // A session that went away cannot be fixed by retrying; ask again.
    if (await sessionExpired()) {
      if (screenShare.sharing) screenShare.stop();
      showGate('You were signed out. Enter the passcode again.');
      return;
    }
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  });

  socket.addEventListener('error', () => socket.close());
}

async function sessionExpired() {
  try {
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    return response.status === 401;
  } catch {
    return false;
  }
}

function handleMessage(message) {
  switch (message.type) {
    case 'welcome':
      state.me = message.you;
      state.role = message.you.role;
      state.capabilities = message.capabilities ?? {};
      screenShare.setIceServers(state.capabilities.iceServers ?? []);
      // The same servers the share itself would use — a test down a different
      // path is not a test of anything.
      state.probeIceServers = [...DEFAULT_ICE_SERVERS, ...(state.capabilities.iceServers ?? [])];
      probe.setIceServers(state.probeIceServers);
      if (state.capabilities.shareHeight) screenShare.setShareHeight(state.capabilities.shareHeight);
      // Both sides use the same link, so say plainly which passcode got you in.
      dom.roleBadge.textContent = state.role === 'host' ? 'Host' : 'Guest';
      dom.roleBadge.dataset.role = state.role;
      dom.roleBadge.hidden = false;
      dom.chat.replaceChildren();
      for (const entry of message.chat ?? []) appendChat(entry, { quiet: true });

      // Back after a dropped connection with the capture still running: the
      // picture may never have stopped, and nobody should have to press Share
      // again because the site's connection blinked.
      if (screenShare.sharing) {
        state.reclaimShare = true;
        send({ type: 'share', on: true });
      }
      applyState(message.state);
      break;

    case 'state':
      applyState(message);
      break;

    case 'presence': {
      const known = new Set(state.viewers.map((viewer) => viewer.id));
      state.viewers = message.viewers ?? [];
      const here = new Set(state.viewers.map((viewer) => viewer.id));
      if (screenShare.sharing) {
        for (const viewer of others()) {
          // Somebody who joins mid-share needs their own offer — and after a
          // reclaim, so does everybody.
          if (state.reclaimShare || !known.has(viewer.id)) screenShare.offerTo(viewer.id);
        }
        state.reclaimShare = false;
      }
      // Somebody who left is not coming back under the same id, so stop
      // reconnecting to them — otherwise a closed tab is retried all evening.
      for (const id of known) if (!here.has(id)) screenShare.forget(id);
      renderPresence();
      break;
    }

    case 'signal':
      if (message.data?.kind === 'probe') {
        probe.handleSignal(message).catch(() => {});
      } else {
        screenShare.handleSignal(message).catch(() => {
          showOverlay('Could not connect to their screen.');
        });
      }
      break;

    case 'chat':
      appendChat(message.entry);
      break;

    case 'error':
      toast(message.error);
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------- picture --

async function playVideo() {
  try {
    dom.video.muted = false;
    await dom.video.play();
    state.needsGesture = false;
    hideOverlay();
    return;
  } catch {
    /* blocked for having sound; try again without it */
  }

  // Start the picture muted rather than showing nothing, then ask for the one
  // tap that lets the sound in. A silent film beats a black rectangle.
  try {
    dom.video.muted = true;
    await dom.video.play();
    state.needsGesture = true;
    showOverlay('Tap anywhere for sound', { sound: true });
  } catch {
    state.needsGesture = true;
    showOverlay('Tap anywhere to start watching');
  }
}

function applyState(room) {
  const wasShowing = isScreenMode();
  state.room = room;

  if (isScreenMode()) {
    if (screenShare.sharing) {
      renderSharingCard();
    } else if (!wasShowing) {
      // A share has just begun. Clear anything left from a previous one and
      // wait for the offer, which follows within a second.
      dom.video.srcObject = null;
      dom.placeholder.hidden = true;
      dom.video.hidden = false;
      showOverlay('Connecting to their screen…');
    }
  } else {
    // The room says nobody is sharing. A capture this browser still holds is
    // kept: this is the moment a dropped connection is reclaiming it, and the
    // room hears so the instant our "share" message arrives.
    if (wasShowing && !screenShare.sharing) {
      screenShare.closeAll();
      dom.video.srcObject = null;
      dom.video.muted = false;
      state.needsGesture = false;
      hideOverlay();
    }
    if (!screenShare.sharing) renderWaiting();
  }

  renderTitle();
  renderPermissions();
  renderSound();
  updateSyncBadge();
}

// Says what is happening in words, because a status code means nothing to
// somebody who just opened a link on an iPad.
function updateSyncBadge() {
  const badge = dom.syncBadge;

  if (!state.connected) {
    badge.textContent = 'Reconnecting…';
    badge.dataset.state = 'offline';
    return;
  }
  if (screenShare.sharing) {
    badge.textContent = 'Sharing your screen';
    badge.dataset.state = 'ok';
    return;
  }
  if (isScreenMode()) {
    if (dom.video.muted && !dom.video.paused) {
      badge.textContent = 'Muted — tap for sound';
      badge.dataset.state = 'drifting';
      return;
    }
    badge.textContent = dom.video.srcObject ? 'Watching their screen' : 'Connecting…';
    badge.dataset.state = dom.video.srcObject ? 'ok' : 'drifting';
    return;
  }
  badge.textContent = 'Waiting to start';
  badge.dataset.state = 'idle';
}

// ---------------------------------------------------------------- render --

// What the host sees while sharing: not their own screen back again.
function renderSharingCard() {
  dom.video.hidden = true;
  dom.placeholder.hidden = false;
  hideOverlay();

  dom.placeholderTitle.textContent = 'You are sharing this screen';
  dom.placeholderText.textContent =
    'Play the film however you like — everything on this monitor goes across.';
  dom.placeholderHint.textContent =
    listNames(others(), ['is watching.', 'are watching.']) || 'Nobody has joined yet.';
}

// Before anything is shared. The host is told what to press; the guest is
// told that nothing is needed from them.
function renderWaiting() {
  dom.video.hidden = true;
  dom.placeholder.hidden = false;

  if (state.role === 'host') {
    dom.placeholderTitle.textContent = 'Ready when you are';
    dom.placeholderText.textContent =
      'Press Share screen, pick Entire Screen, and tick Share system audio.';
    dom.placeholderHint.textContent =
      listNames(others(), ['is here.', 'are here.']) || 'Nobody else has joined yet.';
    return;
  }

  const host = state.viewers.find((viewer) => viewer.role === 'host' && viewer.id !== state.me?.id);
  dom.placeholderTitle.textContent = 'Waiting for the film to start';
  dom.placeholderText.textContent = host
    ? `${host.name} is here. Their screen will appear by itself when they share it.`
    : 'Their screen will appear here by itself as soon as they share it.';
  // The host is already named above, so only mention anyone else.
  const rest = others().filter((viewer) => viewer.id !== host?.id);
  dom.placeholderHint.textContent =
    listNames(rest, ['is here too.', 'are here too.']) || (host ? '' : 'They have not joined yet.');
}

function renderTitle() {
  if (screenShare.sharing) {
    dom.nowShowing.textContent = 'Sharing your screen';
    document.title = 'Sharing — Stream';
  } else if (isScreenMode()) {
    dom.nowShowing.textContent = `${nameOf(state.room.sharerId)}'s screen`;
    document.title = 'Their screen — Stream';
  } else {
    dom.nowShowing.textContent = 'Stream';
    document.title = 'Stream';
  }
}

function renderPermissions() {
  // Only the host has a screen, and only some browsers will hand it over.
  dom.btnShare.hidden = state.role !== 'host' || !navigator.mediaDevices?.getDisplayMedia;
}

// Muted playback is the easiest thing in the room to miss, so the control says
// which state it is in rather than only offering to change it.
function renderSound() {
  dom.btnSound.hidden = !isScreenMode() || screenShare.sharing;

  const muted = dom.video.muted || dom.video.volume === 0;
  dom.btnSound.dataset.muted = String(muted);
  dom.btnSound.dataset.playing = String(!dom.video.paused);
  dom.soundLabel.textContent = muted ? 'Tap for sound' : 'Sound on';
  dom.btnSound.title = muted ? 'The film is muted — turn the sound on' : 'Mute';
}

dom.btnSound.addEventListener('click', (event) => {
  // Not the page-wide "tap anywhere" handler; this one is deliberate.
  event.stopPropagation();
  dom.video.muted = !dom.video.muted;
  if (!dom.video.muted && dom.video.volume === 0) dom.video.volume = 1;
  state.needsGesture = false;
  hideOverlay();
  if (dom.video.paused) playVideo();
  renderSound();
  updateSyncBadge();
});

for (const event of ['volumechange', 'play', 'pause', 'loadedmetadata']) {
  dom.video.addEventListener(event, renderSound);
}

function renderPresence() {
  dom.presence.replaceChildren();
  for (const viewer of state.viewers) {
    const chip = document.createElement('span');
    chip.dataset.role = viewer.role;
    chip.textContent = viewer.id === state.me?.id ? `${viewer.name} (you)` : viewer.name;
    dom.presence.append(chip);
  }
  const count = others().length;
  dom.panelLabel.textContent = count ? `Chat · ${count}` : 'Chat';
  if (screenShare.sharing) renderSharingCard();
  else if (!isScreenMode()) renderWaiting();
  renderTitle();
}

function appendChat(entry, { quiet = false } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message' + (entry.from === state.me?.id ? ' mine' : '');

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.textContent = `${entry.name} · ${time}`;

  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = entry.text;

  wrapper.append(meta, body);
  dom.chat.append(wrapper);
  dom.chat.scrollTop = dom.chat.scrollHeight;

  if (!quiet && dom.app.dataset.panel === 'closed' && entry.from !== state.me?.id) {
    toast(`${entry.name}: ${entry.text}`);
  }
}

// ---------------------------------------------------------------- events --

document.addEventListener('click', () => {
  if (!state.needsGesture) return;
  state.needsGesture = false;
  // The tap is what buys the sound, so take it.
  dom.video.muted = false;
  hideOverlay();
  playVideo();
}, { capture: true });

// Fullscreen on the whole stage, so the overlays stay visible. iOS Safari will
// not do that for an arbitrary element, so there we hand the video its own
// native fullscreen instead.
function isFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement);
}

async function toggleFullscreen() {
  try {
    if (isFullscreen()) {
      await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
      return;
    }
    const target = dom.screen;
    if (target.requestFullscreen) {
      await target.requestFullscreen({ navigationUI: 'hide' });
    } else if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
    } else if (dom.video.webkitEnterFullscreen) {
      dom.video.webkitEnterFullscreen(); // iPhone Safari
    } else {
      toast('This browser will not allow fullscreen here.');
    }
  } catch {
    toast('Fullscreen was refused.');
  }
}

function renderFullscreenButton() {
  dom.btnFullscreen.querySelector('span').textContent = isFullscreen() ? 'Exit fullscreen' : 'Fullscreen';
  dom.btnFullscreen.setAttribute('aria-pressed', String(isFullscreen()));
}

// Added to the home screen there is no browser chrome, so the page has to
// carry its own way out and its own way to start over.
const STANDALONE =
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

dom.btnExit.hidden = !STANDALONE;

dom.btnReload.addEventListener('click', () => location.reload());

async function leave() {
  if (screenShare.sharing) screenShare.stop();
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  state.socket?.close();
  showGate();
}

dom.btnExit.addEventListener('click', leave);
dom.btnLeave.addEventListener('click', leave);

dom.btnFullscreen.addEventListener('click', toggleFullscreen);
for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(event, renderFullscreenButton);
}

function togglePanel(open) {
  const next = open ?? dom.app.dataset.panel === 'closed';
  dom.app.dataset.panel = next ? 'open' : 'closed';
  dom.btnPanel.setAttribute('aria-expanded', String(next));
  if (next) dom.chat.scrollTop = dom.chat.scrollHeight;
}

dom.btnPanel.addEventListener('click', () => togglePanel());
dom.btnPanelClose.addEventListener('click', () => togglePanel(false));

dom.composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = dom.chatInput.value.trim();
  if (!text) return;
  send({ type: 'chat', text });
  dom.chatInput.value = '';
});

document.addEventListener('keydown', (event) => {
  if (event.target.matches('input, textarea, select')) return;
  if (event.key === 'f') {
    event.preventDefault();
    toggleFullscreen();
  }
});

// ------------------------------------------------------------ screen share --

const screenShare = new ScreenShare({
  send: (message) => send(message),
  onStream: (stream) => {
    // Guest side: the host's screen has arrived.
    dom.video.srcObject = stream;
    dom.video.muted = false;
    dom.video.hidden = false;
    dom.placeholder.hidden = true;
    hideOverlay();
    playVideo();
    updateSyncBadge();
  },
  onStateChange: (id, connectionState) => {
    if (connectionState === 'reconnecting') {
      const message = 'Connection dropped — reconnecting…';
      if (screenShare.sharing) toast(message, 4000);
      else showOverlay(message);
      return;
    }
    if (connectionState === 'connected') {
      if (!screenShare.sharing) hideOverlay();
      return;
    }
    if (connectionState === 'still-trying') {
      // The quick attempts are spent, so this is a network that is actually
      // down. It keeps trying on a slow beat, and says so rather than looking
      // like it has stopped caring.
      const message = 'Still trying to reconnect — it will pick up by itself when the network is back.';
      if (screenShare.sharing) toast(message, 8000);
      else showOverlay(message);
      return;
    }
    if (connectionState !== 'failed') return;
    // Almost always a network that will not allow a direct connection.
    const message = state.capabilities.iceServers?.length
      ? 'Could not connect, even through the relay.'
      : 'Could not connect directly between the two networks. A TURN relay is needed — see --turn in the README.';
    if (screenShare.sharing) toast(message, 12_000);
    else showOverlay(message);
  },
  onEnded: () => {
    statsSampler.previous.clear();
    dom.linkStats.hidden = true;
    dom.btnShare.querySelector('span').textContent = 'Share screen';
    dom.btnShare.setAttribute('aria-pressed', 'false');
    state.reclaimShare = false;
    send({ type: 'share', on: false });
    renderWaiting();
    renderTitle();
    updateSyncBadge();
  },
});

// The same connection a share would need, carrying nothing, so it can be
// checked on a Tuesday rather than discovered on the night.
const probe = new ConnectionProbe({ send: (message) => send(message) });

// A dark screen stops the capture, and a tablet dimming mid-scene is its own
// small misery. Held while a screen is being shown, dropped when it is not.
const wakeLock = new WakeLock();

function updateWakeLock() {
  wakeLock.want(isScreenMode() || screenShare.sharing);
}

const statsSampler = new StatsSampler();

async function updateLinkStats() {
  if (!isScreenMode() || screenShare.peers.size === 0) {
    dom.linkStats.hidden = true;
    return;
  }

  // The host measures what it is sending; everyone else what they receive.
  const sending = screenShare.sharing;
  const samples = [];
  for (const [id, peer] of screenShare.peers) {
    const sample = await statsSampler.sample(id, peer, { sending });
    if (sample) samples.push([id, sample]);
  }
  if (samples.length === 0) {
    dom.linkStats.hidden = true;
    return;
  }

  dom.linkStats.hidden = false;
  // With several viewers, the one having the worst time is the one to show.
  const order = { poor: 0, fair: 1, good: 2 };
  samples.sort((a, b) => (order[statsVerdict(a[1])] ?? 3) - (order[statsVerdict(b[1])] ?? 3));
  const [worstId, worst] = samples[0];

  const who = sending ? `${nameOf(worstId)}: ` : '';
  dom.linkText.textContent = who + describeStats(worst);
  dom.linkStats.dataset.quality = statsVerdict(worst) ?? '';
}

dom.btnTest.addEventListener('click', async () => {
  const everyoneElse = others();

  dom.btnTest.disabled = true;
  dom.btnTest.textContent = 'Testing…';
  try {
    // Testing against the other person is the real test, so prefer it whenever
    // they are here. Alone, ask what this network alone can answer — which is
    // most of it, and is the version somebody can run before arranging to be
    // on the page at the same time as anyone.
    if (everyoneElse.length === 0) {
      const result = await selfTest(state.probeIceServers);
      toast(describeSelfTest(result), 22_000);
      return;
    }
    for (const viewer of everyoneElse) {
      const result = await probe.test(viewer.id);
      toast(describeProbeResult(result, { name: viewer.name }), 14_000);
    }
  } catch {
    toast('The test could not run. Try again in a moment.', 8000);
  } finally {
    dom.btnTest.disabled = false;
    dom.btnTest.textContent = 'Test link';
  }
});

async function startSharing() {
  let started;
  try {
    started = await screenShare.start();
  } catch (error) {
    toast(
      error.name === 'NotAllowedError'
        ? 'Screen share was cancelled.'
        : `Could not capture the screen (${error.name}).`
    );
    return;
  }

  if (!started.hasAudio) {
    // Windows offers audio on "Entire Screen" and on a Chrome tab, but never
    // on a single window — which is the option people reach for first.
    toast(
      'Sharing without sound — the audio tick was cleared in the picker. ' +
        'Stop, share again, and leave "Share system audio" on.',
      10_000
    );
  }

  dom.btnShare.querySelector('span').textContent = 'Stop sharing';
  dom.btnShare.setAttribute('aria-pressed', 'true');
  send({ type: 'share', on: true });

  // Deliberately no preview: sharing the whole screen means a preview of it
  // sits inside itself, repeating into infinity. The host is looking at the
  // real thing already.
  dom.video.srcObject = null;
  renderSharingCard();
  renderTitle();

  for (const viewer of others()) screenShare.offerTo(viewer.id);
}

dom.btnShare.addEventListener('click', () => {
  if (screenShare.sharing) {
    // stop() ends the capture, and onEnded tells the room.
    screenShare.stop();
    return;
  }
  // The picker is narrowed to whole screens and asks for audio already, so
  // there is nothing left to explain unless it comes back silent.
  startSharing();
});

// --------------------------------------------------------------- the gate --

function showGate(message) {
  state.entered = false;
  dom.gate.hidden = false;
  dom.app.hidden = true;
  if (message) {
    dom.joinError.textContent = message;
    dom.joinError.hidden = false;
  }
  dom.joinName.value = localStorage.getItem('stream:name') ?? '';
  (dom.joinName.value ? dom.joinPasscode : dom.joinName).focus();
}

function enterRoom() {
  if (state.entered) return;
  state.entered = true;
  dom.gate.hidden = true;
  dom.app.hidden = false;
  connect();
}

// The field is styled uppercase, which changes how it looks and not what it
// holds. Keep the two the same so nobody sends something they cannot see.
dom.joinPasscode.addEventListener('input', () => {
  const start = dom.joinPasscode.selectionStart;
  dom.joinPasscode.value = dom.joinPasscode.value.toUpperCase();
  dom.joinPasscode.setSelectionRange(start, start);
});

dom.joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  dom.joinError.hidden = true;
  dom.joinSubmit.disabled = true;
  dom.joinSubmit.textContent = 'Checking…';

  try {
    const response = await fetch('/api/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        passcode: dom.joinPasscode.value.trim(),
        name: dom.joinName.value.trim(),
      }),
    });

    if (response.ok) {
      const name = dom.joinName.value.trim();
      if (name) localStorage.setItem('stream:name', name);
      enterRoom();
      return;
    }

    const body = await response.json().catch(() => ({}));
    dom.joinError.textContent = body.error ?? 'Could not join. Try again.';
    dom.joinError.hidden = false;
    dom.joinPasscode.select();
  } catch {
    dom.joinError.textContent = 'Could not reach the room. Is it still running?';
    dom.joinError.hidden = false;
  } finally {
    dom.joinSubmit.disabled = false;
    dom.joinSubmit.textContent = 'Join';
  }
});

// A viewer can be sitting in screen mode with no picture while the host
// believes the connection is fine: a reloaded tab, a peer that went away
// without saying so. Nothing on the host's side will notice, so the viewer
// asks — after a pause, because the usual reason is simply that the share is
// still being set up.
const REOFFER_AFTER_MS = 10_000;
let blankSince = 0;

function nudgeScreenShare() {
  const sharer = state.room?.sharerId;
  const waiting =
    state.connected && sharer && sharer !== state.me?.id && !screenShare.sharing && !dom.video.srcObject;

  if (!waiting) {
    blankSince = 0;
    return;
  }
  const now = Date.now();
  if (!blankSince) {
    blankSince = now;
    return;
  }
  if (now - blankSince < REOFFER_AFTER_MS) return;
  blankSince = now;
  screenShare.requestOffer(sharer);
}

setInterval(updateSyncBadge, 1000);
setInterval(() => {
  updateWakeLock();
  updateLinkStats();
  nudgeScreenShare();
}, 2000);

// Loading the page clears any session, so this is normally the gate. The check
// still runs, so a tab restored mid-session goes straight back in.
(async () => {
  let authenticated = false;
  try {
    authenticated = (await fetch('/api/session', { credentials: 'same-origin' })).ok;
  } catch {
    /* treat as not signed in */
  }
  // This check is slower than typing a passcode, so it must not undo a join
  // that already happened while it was in flight.
  if (state.entered) return;
  if (authenticated) enterRoom();
  else showGate();
})();
