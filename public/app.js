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
  emojiRow: el('emoji-row'),
  surpriseEmoji: el('surprise-emoji'),
  tonight: el('tonight'),
  surpriseInput: el('surprise-input'),
  headingInput: el('heading-input'),
  tonightStatus: el('tonight-status'),
  reveal: el('reveal'),
  revealText: el('reveal-text'),
  revealX: el('reveal-x'),
  roomName: el('room-name'),
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
  // the picture to whoever lost it as soon as we know who is here.
  reclaimShare: false,
  // Viewer side. The sharer's connection to the site went, but the picture
  // may still be arriving: keep showing it while they come back.
  away: null, // { name, timer }
  // Why the last share ended, so the waiting screen can say so in words.
  ended: null, // { name, reason: 'stopped' | 'left' }
  // The picture's own connection has dropped and is being re-offered.
  lost: false,
  lostTimer: null,
  everConnected: false,
  // Guest side, when there is a note: what is going wrong, said on the note
  // rather than over a frozen or black picture. Null when all is well.
  status: null,
  // This browser's own connection to the site has been gone a moment.
  offline: false,
  // Guest side: the host's name once they have been here, and whether they
  // have since dropped off the site.
  lastHost: null,
  hostGone: false,
};

// How long a viewer keeps the last picture while the sharer's connection to
// the site is gone. Long enough for a Wi-Fi hiccup or the tunnel restarting;
// short enough that a laptop that has actually gone away is said to have.
const AWAY_GRACE_MS = 45_000;
// How long a blink may last before the viewer is told about it.
const AWAY_NOTICE_MS = 3000;
// A connection that drops and mends inside this is not worth a notification.
const DROP_NOTICE_MS = 4000;

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
// A picture is on this screen: a share is running, or one is being waited out.
const showingScreen = () => isScreenMode() || Boolean(state.away);
const others = () => state.viewers.filter((viewer) => viewer.id !== state.me?.id);

// A problem with the picture, in words. With a note set, the note stays on
// the screen and this goes under it — her note, not a blank screen, while it
// sorts itself out. Without one, it goes over the picture as before.
function showStatus(text) {
  if (state.role === 'host' || !state.surprise) {
    showOverlay(text);
    return;
  }
  hideOverlay();
  state.status = text;
  renderWaiting();
}

// The picture is back: take the note away and show it.
function clearStatus() {
  if (!state.status) return;
  state.status = null;
  if (dom.video.srcObject && showingScreen()) {
    dom.placeholder.hidden = true;
    dom.video.hidden = false;
  }
}
const nameOf = (id) => state.viewers.find((viewer) => viewer.id === id)?.name ?? 'the other side';

function listNames(viewers, verb) {
  if (viewers.length === 0) return '';
  const names = viewers.map((viewer) => viewer.name).join(' and ');
  return `${names} ${viewers.length === 1 ? verb[0] : verb[1]}`;
}

// The host is usually looking at the film, full screen in another program, not
// at this page. A notification is the one thing that reaches them there. Only
// used when this page does not have focus: when it does, a toast is enough.
function notify(title, body) {
  const wanted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  if (!wanted || document.hasFocus()) return false;
  try {
    // One tag per subject, so a flapping connection replaces its notice
    // rather than stacking a column of them.
    new Notification(title, { body, tag: `stream:${title}` });
    return true;
  } catch {
    return false;
  }
}

// Tell the host, wherever they are looking.
function tellHost(title, body) {
  if (state.role !== 'host') return;
  if (!notify(title, body)) toast(`${title} — ${body}`, 7000);
}

// Asked at the moment of sharing, because that is the click it belongs to.
function askToNotify() {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
  // Older Safari takes a callback and returns nothing, so there may be no
  // promise to catch.
  Notification.requestPermission()?.catch?.(() => {});
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
let offlineTimer = null;

// The waiting screen says when this browser has lost the site — after a
// moment, so a blink shows nothing. A film already playing carries on (the
// picture does not come through the site), so it is left alone.
function setOffline(offline) {
  const apply = () => {
    offlineTimer = null;
    if (state.offline === offline) return;
    state.offline = offline;
    if (state.status || (!showingScreen() && !screenShare.sharing)) renderWaiting();
  };
  if (offline) {
    // Every failed attempt to reconnect lands here again; the moment counts
    // from the first.
    if (!state.offline && !offlineTimer) offlineTimer = setTimeout(apply, AWAY_NOTICE_MS);
  } else {
    clearTimeout(offlineTimer);
    apply();
  }
}

function connect() {
  const url = new URL('/ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

  const socket = new WebSocket(url);
  state.socket = socket;

  socket.addEventListener('open', () => {
    state.connected = true;
    reconnectDelay = 500;
    setOffline(false);
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
    setOffline(true);
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
      // The room is the truth about how things look and what is waiting for
      // them — on a first arrival and on every reconnection alike, so a
      // blink never leaves either side showing something the room has moved
      // on from.
      applyTheme(tonightDirty && themeChoice() ? themeChoice() : message.theme);
      if (message.roomName) setRoomName(message.roomName);
      settleSurprise(message.surprise ?? null);
      if (state.role === 'host') loadTonight();

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
      state.previousViewers = state.viewers.map((viewer) => [viewer.id, viewer]);
      const known = new Set(state.viewers.map((viewer) => viewer.id));
      state.viewers = message.viewers ?? [];
      const here = new Set(state.viewers.map((viewer) => viewer.id));
      if (screenShare.sharing) {
        for (const viewer of others()) {
          if (!known.has(viewer.id)) {
            // Somebody who joins mid-share needs their own offer.
            screenShare.offerTo(viewer.id);
          } else if (state.reclaimShare && screenShare.peers.get(viewer.id)?.connectionState !== 'connected') {
            // After a reclaim, only whoever actually lost the picture. For the
            // rest it never stopped, and offering again would interrupt it.
            screenShare.offerTo(viewer.id);
          }
        }
        state.reclaimShare = false;
      }
      if (state.role === 'host' && state.me) noticeComingsAndGoings(known, here);
      // Somebody who left is not coming back under the same id, so stop
      // reconnecting to them — otherwise a closed tab is retried all evening.
      // Only the sharer does this: a viewer's one connection is to the
      // sharer, and when the sharer's connection to the site blinks, the
      // picture is still arriving on it. Closing it here froze the picture.
      if (screenShare.sharing) {
        for (const id of known) if (!here.has(id)) screenShare.forget(id);
      }
      renderPresence();
      break;
    }

    case 'signal':
      if (message.data?.kind === 'probe') {
        probe.handleSignal(message).catch(() => {});
      } else {
        screenShare.handleSignal(message).catch(() => {
          showStatus('Could not connect to their screen.');
        });
      }
      break;

    case 'surprise':
      // Sent only when it changed, so a new one is always worth showing.
      settleSurprise(message.text || null, { fresh: true });
      break;

    case 'room-name':
      setRoomName(message.name);
      break;

    case 'theme':
      // A preview the host has not saved yet stays on their own screen.
      if (!(state.role === 'host' && tonightDirty)) applyTheme(message.theme);
      break;

    case 'chat':
      appendChat(message.entry);
      // Somebody asking to pause needs to reach the person with the remote.
      if (message.entry.from !== state.me?.id) notify(message.entry.name, message.entry.text);
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

// Tell the host when somebody arrives or leaves — but not when they are only
// reconnecting, which looks like leaving and arriving again a moment later
// under a new id with the same name.
const recentlyLeft = new Map(); // name -> when they went
const REJOIN_WINDOW_MS = 20_000;

function noticeComingsAndGoings(known, here) {
  const before = new Map(state.previousViewers ?? []);

  // Only guests: a host's own connection coming and going — this very page
  // reconnecting — shows up here too, and is not news to them.
  for (const viewer of others()) {
    if (viewer.role === 'host' || known.has(viewer.id)) continue;
    const left = recentlyLeft.get(viewer.name);
    recentlyLeft.delete(viewer.name);
    if (left && Date.now() - left < REJOIN_WINDOW_MS) continue;
    tellHost(
      `${viewer.name} joined`,
      screenShare.sharing ? 'Their picture is connecting.' : 'Press Share screen when you are ready.'
    );
  }

  for (const id of known) {
    if (here.has(id) || id === state.me?.id) continue;
    const gone = before.get(id);
    if (!gone || gone.role === 'host') continue;
    const { name } = gone;
    recentlyLeft.set(name, Date.now());
    setTimeout(() => {
      // Back already, under a new connection: nothing to say.
      if (state.viewers.some((viewer) => viewer.name === name && viewer.id !== state.me?.id)) return;
      tellHost(`${name} left`, 'They are no longer in the room.');
    }, DROP_NOTICE_MS * 2);
  }
}

function applyState(room) {
  const wasShowing = isScreenMode();
  state.room = room;

  if (isScreenMode()) {
    // Whatever was being waited out is over: the share is running again.
    endAway();
    state.ended = null;
    if (screenShare.sharing) {
      renderSharingCard();
    } else if (!dom.video.srcObject) {
      // A share has just begun. Wait for the offer, which follows within a
      // second. A note stays up until the film takes its place.
      if (!state.surprise) {
        dom.placeholder.hidden = true;
        dom.video.hidden = false;
      }
      showStatus('Connecting to their screen…');
    }
    // Otherwise a picture is already here — the sharer's connection to the
    // site blinked and they have taken the share back. It never stopped, so
    // leave it alone.
  } else if (wasShowing && !screenShare.sharing) {
    if (room.reason === 'left') {
      // Their connection to the site went, but the picture is a separate
      // connection and may well still be coming. Keep it, and give them a
      // while to come back before calling it over.
      beginAway(room.by);
    } else {
      stopWatching({ name: room.by, reason: 'stopped' });
    }
  } else if (!screenShare.sharing && !state.away) {
    renderWaiting();
  }

  renderTitle();
  renderPermissions();
  renderSound();
  updateSyncBadge();
}

function beginAway(name) {
  endAway();
  const who = name ?? 'They';
  state.away = {
    name: who,
    timer: setTimeout(() => {
      // Long enough: they have gone, not blinked.
      stopWatching({ name, reason: 'left' });
      renderTitle();
      renderSound();
      updateSyncBadge();
    }, AWAY_GRACE_MS),
    // The picture's own connection cannot be trusted to notice: when the far
    // end vanishes outright it can go on reporting "connected" for most of a
    // minute. The room noticing is the reliable signal, so say so — after a
    // moment, so that a one-second blink shows nothing at all.
    notice: setTimeout(() => {
      if (state.away) showStatus(`Disconnected from ${who} — waiting for them to come back…`);
    }, AWAY_NOTICE_MS),
  };
}

function endAway() {
  if (!state.away) return;
  clearTimeout(state.away.timer);
  clearTimeout(state.away.notice);
  const wasShowingNotice =
    /^Disconnected from/.test(state.status ?? '') ||
    (!dom.overlay.hidden && /^Disconnected from/.test(dom.overlayText.textContent));
  state.away = null;
  if (wasShowingNotice && !state.lost) {
    hideOverlay();
    clearStatus();
    toast('Back — the picture is live again.', 4000);
  }
}

// The share is over: drop the picture and say why.
function stopWatching(ended) {
  endAway();
  clearTimeout(state.lostTimer);
  state.lost = false;
  state.everConnected = false;
  screenShare.closeAll();
  dom.video.srcObject = null;
  dom.video.muted = false;
  state.needsGesture = false;
  state.ended = ended;
  state.status = null;
  hideOverlay();
  renderWaiting();
}

// Viewer side: what the picture's own connection is doing, in words.
function viewerConnectionChanged(connectionState) {
  if (connectionState === 'connected') {
    clearTimeout(state.lostTimer);
    const wasLost = state.lost;
    state.lost = false;
    state.everConnected = true;
    hideOverlay();
    clearStatus();
    if (state.needsGesture) showOverlay('Tap anywhere for sound', { sound: true });
    if (wasLost) toast('Back — the picture is live again.', 4000);
    return;
  }

  if (connectionState === 'disconnected' || connectionState === 'failed') {
    if (!state.everConnected) {
      if (connectionState !== 'failed') return;
      // Never got going at all: almost always two networks that will not
      // connect directly.
      showStatus(
        state.capabilities.iceServers?.length
          ? 'Could not connect, even through the relay.'
          : 'Could not connect directly between the two networks. A TURN relay is needed — see --turn in the README.'
      );
      return;
    }
    if (state.lost) return;
    // It was working. The frozen frame stays behind this; the host's side is
    // already offering again, and so will we if it takes a while.
    state.lost = true;
    showStatus(
      state.away
        ? `Disconnected from ${state.away.name} — waiting for them to come back…`
        : 'Disconnected — reconnecting…'
    );
    clearTimeout(state.lostTimer);
    state.lostTimer = setTimeout(() => {
      if (!state.lost) return;
      showStatus('Still disconnected. It will pick up by itself as soon as the connection is back.');
    }, 20_000);
    updateSyncBadge();
  }
}

// Host side: a viewer's picture dropped or came back. The host is probably
// watching the film, not this page, so this is where the notifications are.
const dropNotices = new Map(); // viewerId -> { timer, notified, everConnected }

function hostConnectionChanged(id, connectionState) {
  const name = nameOf(id);
  const entry = dropNotices.get(id) ?? { timer: null, notified: false, everConnected: false };
  dropNotices.set(id, entry);

  if (connectionState === 'connected') {
    if (!entry.everConnected) tellHost(`${name} is watching`, 'Your screen is reaching them.');
    entry.everConnected = true;
    clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.notified) {
      entry.notified = false;
      tellHost(`${name} is back`, 'The picture is reaching them again — carry on.');
      renderTitle();
    }
    return;
  }

  // Never reached them at all: that is two networks that will not connect,
  // not a drop, and pausing will not help. Say what will.
  if (connectionState === 'failed' && !entry.everConnected) {
    toast(
      state.capabilities.iceServers?.length
        ? `Could not reach ${name}, even through the relay.`
        : `Could not reach ${name} directly between the two networks. A TURN relay is needed — see --turn in the README.`,
      12_000
    );
    return;
  }

  if (['disconnected', 'failed', 'reconnecting'].includes(connectionState)) {
    if (!entry.everConnected || entry.timer || entry.notified) return;
    // Wait a moment: most drops mend themselves before anyone would notice.
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const peer = screenShare.peers.get(id);
      if (peer?.connectionState === 'connected') return;
      entry.notified = true;
      document.title = `⚠ ${name} dropped — Stream`;
      tellHost(`${name}'s picture dropped`, 'Pause the film if you do not want them to miss anything. It is reconnecting by itself.');
    }, DROP_NOTICE_MS);
  }
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
    const dropped = [...dropNotices.values()].some((entry) => entry.notified);
    badge.textContent = dropped ? 'Sharing — someone dropped' : 'Sharing your screen';
    badge.dataset.state = dropped ? 'drifting' : 'ok';
    return;
  }
  if (state.away) {
    badge.textContent = `Reconnecting to ${state.away.name}…`;
    badge.dataset.state = 'drifting';
    return;
  }
  if (state.lost) {
    badge.textContent = 'Reconnecting…';
    badge.dataset.state = 'drifting';
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
  dom.tonight.hidden = false;
  hideOverlay();

  dom.placeholderTitle.classList.remove('love');
  dom.placeholderText.classList.remove('trouble');
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

  dom.tonight.hidden = state.role !== 'host';
  dom.placeholderTitle.classList.remove('love');
  dom.placeholderText.classList.remove('trouble');
  if (state.role === 'host') {
    dom.placeholderTitle.textContent = 'Ready when you are';
    dom.placeholderText.textContent =
      'Press Share screen, pick Entire Screen, and tick Share system audio.';
    dom.placeholderHint.textContent =
      listNames(others(), ['is here.', 'are here.']) || 'Nobody else has joined yet.';
    return;
  }

  const host = state.viewers.find((viewer) => viewer.role === 'host' && viewer.id !== state.me?.id);
  noticeHostGone(host);
  const who = state.ended?.name ?? state.lastHost ?? 'them';
  const sharer = state.ended?.name ?? 'They';
  let trouble = false;
  let title;
  let line;
  if (state.ended?.reason === 'stopped') {
    title = `${sharer} stopped sharing`;
    line = 'Their screen will appear here again the moment they share it.';
  } else if (!host && (state.ended?.reason === 'left' || state.hostGone)) {
    trouble = true;
    title = `Lost contact with ${who}`;
    line = 'Their screen will appear here again by itself when they are back.';
  } else {
    title = 'Waiting for the film to start';
    line = host
      ? `${host.name} is here. Their screen will appear by itself when they share it.`
      : 'Their screen will appear here by itself as soon as they share it.';
  }

  // Their note stays in front of them, whatever is going on, until the film
  // takes its place. What is happening goes under it.
  if (state.surprise) {
    title = state.surprise;
    if (state.ended?.reason === 'stopped') {
      line = `${sharer} stopped sharing. The film will appear here again the moment they share it.`;
    } else if (trouble) {
      line = `Disconnected from ${who} — the film will come back by itself when they are back.`;
    } else {
      line = line.replace('Their screen', 'The film');
    }
  }
  // Trouble happening right now comes last, so it wins: it is what they need
  // to know, and it clears by itself.
  if (state.status) {
    trouble = true;
    line = state.status;
  }
  if (state.offline) {
    trouble = true;
    line = 'Disconnected — reconnecting…';
  }

  dom.placeholderTitle.textContent = title;
  dom.placeholderText.textContent = line;
  dom.placeholderTitle.classList.toggle('love', Boolean(state.surprise));
  dom.placeholderText.classList.toggle('trouble', trouble);
  // The host is already named above, so only mention anyone else.
  const rest = others().filter((viewer) => viewer.id !== host?.id);
  dom.placeholderHint.textContent = trouble
    ? ''
    : listNames(rest, ['is here too.', 'are here too.']) || (host ? '' : 'They have not joined yet.');
}

// The host was here and their connection to the site has gone. Said after a
// moment, so that their laptop blinking shows nothing at all.
let hostGoneTimer = null;
function noticeHostGone(host) {
  if (host) {
    state.lastHost = host.name;
    state.hostGone = false;
    clearTimeout(hostGoneTimer);
    hostGoneTimer = null;
    return;
  }
  if (!state.lastHost || state.hostGone || hostGoneTimer) return;
  hostGoneTimer = setTimeout(() => {
    hostGoneTimer = null;
    state.hostGone = true;
    if (!showingScreen() && !screenShare.sharing) renderWaiting();
  }, AWAY_NOTICE_MS);
}

function renderTitle() {
  if (screenShare.sharing) {
    dom.nowShowing.textContent = 'Sharing your screen';
    const dropped = [...dropNotices.entries()].find(([, entry]) => entry.notified);
    // The tab title shows on the taskbar, so it carries a drop even when a
    // notification was refused.
    document.title = dropped ? `⚠ ${nameOf(dropped[0])} dropped — Stream` : 'Sharing — Stream';
  } else if (state.away) {
    dom.nowShowing.textContent = `${state.away.name}'s screen`;
    document.title = 'Reconnecting — Stream';
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
  dom.btnSound.hidden = !showingScreen() || screenShare.sharing;

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
  else if (!showingScreen()) renderWaiting();
  renderTitle();
}

// Built at run time and guarded: an older browser that does not know these
// Unicode properties would reject a regex literal, and with it the whole page.
const EMOJI_ONLY = (() => {
  try {
    return new RegExp('^(?:\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|\\p{Regional_Indicator}|\\u200d|\\ufe0f|\\s)+$', 'u');
  } catch {
    return null;
  }
})();
const HAS_PICTOGRAPH = (() => {
  try {
    return new RegExp('\\p{Extended_Pictographic}|\\p{Regional_Indicator}', 'u');
  } catch {
    return null;
  }
})();

function isEmojiOnly(text) {
  if (!EMOJI_ONLY || !HAS_PICTOGRAPH) return false;
  if (!EMOJI_ONLY.test(text) || !HAS_PICTOGRAPH.test(text)) return false;
  // Up to three, as you would see them: "😂😂😂" is a reaction, a row of ten
  // is a message.
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter() : null;
  const count = segmenter
    ? Array.from(segmenter.segment(text.replace(/\s/g, ''))).length
    : Array.from(text.replace(/\s|\u200d|\ufe0f/g, '')).length;
  return count <= 3;
}

function appendChat(entry, { quiet = false } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'message' + (entry.from === state.me?.id ? ' mine' : '');

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  meta.textContent = `${entry.name} · ${time}`;

  const body = document.createElement('div');
  body.className = isEmojiOnly(entry.text) ? 'body emoji-only' : 'body';
  body.textContent = entry.text;

  wrapper.append(meta, body);
  dom.chat.append(wrapper);
  dom.chat.scrollTop = dom.chat.scrollHeight;

  if (!quiet && dom.app.dataset.panel === 'closed' && entry.from !== state.me?.id) {
    toast(`${entry.name}: ${entry.text}`);
  }
}

// ------------------------------------------------------------ the surprise --

// Shown over everything the moment they arrive: the screen dims and the note
// rises, and it stays until they close it themselves — a note is not a
// notification. That tap is also the one a browser wants before it will play
// sound, so it earns its keep twice. Closed, it stays on their waiting screen
// until the picture arrives.
// Once per sitting. A reconnection or a reload in the same tab must not
// spring it on them again — mid-film, it would land on top of the picture —
// but a new note always shows, and so does the same one on another evening.
// sessionStorage is exactly "this tab, until it is closed". Guarded, because
// a private window can refuse it; then it simply shows each time.
const REVEALED_KEY = 'stream:revealed';

function alreadyRevealed(text) {
  try {
    return sessionStorage.getItem(REVEALED_KEY) === text;
  } catch {
    return false;
  }
}

function markRevealed(text) {
  try {
    sessionStorage.setItem(REVEALED_KEY, text);
  } catch {
    /* it will show again next time, which is the lesser problem */
  }
}

// Bring the screen into line with whatever note the room has now.
function settleSurprise(text, { fresh = false } = {}) {
  state.surprise = text;
  if (!text) {
    if (!dom.reveal.hidden) closeReveal();
  } else if (fresh || !alreadyRevealed(text)) {
    revealSurprise(text);
  }
  if (state.status && !text) {
    // No note to keep up any more: say it over the picture instead.
    const status = state.status;
    state.status = null;
    if (dom.video.srcObject) {
      dom.placeholder.hidden = true;
      dom.video.hidden = false;
    }
    showOverlay(status);
  } else if (state.status || (!showingScreen() && !screenShare.sharing)) {
    renderWaiting();
  }
}

function revealSurprise(text) {
  if (!text) return;
  state.surprise = text;
  markRevealed(text);
  dom.revealText.textContent = text;
  if (state.status || (!showingScreen() && !screenShare.sharing)) renderWaiting();
  // A beat after arriving, so it lands rather than flickers in with the page.
  setTimeout(() => {
    dom.reveal.hidden = false;
    dom.reveal.dataset.shown = 'false';
    requestAnimationFrame(() => { dom.reveal.dataset.shown = 'true'; });
    dom.revealX.focus({ preventScroll: true });
  }, 450);
}

function closeReveal() {
  dom.reveal.dataset.shown = 'false';
  setTimeout(() => { dom.reveal.hidden = true; }, 350);
}

dom.revealX.addEventListener('click', closeReveal);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !dom.reveal.hidden) closeReveal();
});

// The whole room changes look at once, both sides, when the host says so.
const THEME_COLORS = { classic: '#08090d', cozy: '#170d12' };
function applyTheme(theme) {
  if (!THEME_COLORS[theme]) return;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
}

const themeChoice = () => dom.tonight.querySelector('input[name="theme"]:checked')?.value;

// The heading lives on the passcode page and in the tab title. Kept current
// even while they are in the room, so leaving shows the one set now.
function setRoomName(name) {
  if (!name) return;
  dom.roomName.textContent = name;
  if (!state.entered) document.title = name;
}

// Edits the host has made but not saved. A reconnection reloads the saved
// values, and must not wipe out what they were in the middle of.
let tonightDirty = false;
dom.tonight.addEventListener('input', () => { tonightDirty = true; });

// The host's side: what they have left for tonight.
async function loadTonight() {
  try {
    const response = await fetch('/api/settings', { credentials: 'same-origin' });
    if (!response.ok) return;
    const settings = await response.json();
    if (tonightDirty) return;
    const radio = dom.tonight.querySelector(`input[name="theme"][value="${settings.theme}"]`);
    if (radio) radio.checked = true;
    // Do not overwrite something they are in the middle of typing.
    if (document.activeElement !== dom.surpriseInput) dom.surpriseInput.value = settings.surprise ?? '';
    if (document.activeElement !== dom.headingInput) {
      dom.headingInput.value = settings.roomName === 'Tonight at the pictures' ? '' : settings.roomName ?? '';
    }
  } catch {
    /* the box simply starts empty */
  }
}

// Picking one shows it straight away on the host's own screen, as a preview;
// saving shows everyone.
dom.tonight.addEventListener('change', (event) => {
  if (event.target.name !== 'theme') return;
  applyTheme(event.target.value);
  dom.tonightStatus.textContent = 'Press Save to show them this look too.';
});

dom.tonight.addEventListener('submit', async (event) => {
  event.preventDefault();
  dom.tonightStatus.textContent = 'Saving…';
  try {
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        surprise: dom.surpriseInput.value,
        roomName: dom.headingInput.value,
        ...(themeChoice() ? { theme: themeChoice() } : {}),
      }),
    });
    if (!response.ok) throw new Error(String(response.status));
    const saved = await response.json();
    tonightDirty = false;
    applyTheme(saved.theme);
    const here = others().some((viewer) => viewer.role === 'guest');
    dom.tonightStatus.textContent = saved.surprise
      ? here
        ? 'Saved — it is on their screen now 💌'
        : 'Saved — they will see it the moment they sign in 💌'
      : 'Saved.';
  } catch {
    dom.tonightStatus.textContent = 'Could not save. Try again.';
  }
});

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

// An emoji goes into the message rather than straight out, so it can sit
// beside words. On a phone the box is not focused, because focusing it throws
// up the keyboard over the film for the sake of one tap.
const TOUCH = window.matchMedia?.('(pointer: coarse)').matches ?? false;

// Pressing a button normally takes the focus, and with it the box's idea of
// where the cursor was — so the emoji landed at the start of the sentence.
// Keeping the focus where it is keeps the cursor too.
function emojiButtons(row, input) {
  row.addEventListener('mousedown', (event) => event.preventDefault());
  row.addEventListener('click', (event) => {
    const emoji = event.target.closest('[data-emoji]')?.dataset.emoji;
    if (!emoji) return;
    // Mid-sentence if they are typing, otherwise on the end.
    const typing = document.activeElement === input;
    const start = typing ? input.selectionStart ?? input.value.length : input.value.length;
    const end = typing ? input.selectionEnd ?? input.value.length : input.value.length;
    const next = input.value.slice(0, start) + emoji + input.value.slice(end);
    if (next.length > input.maxLength && input.maxLength > 0) return;
    input.value = next;
    // As if typed, so anything watching the box hears about it.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const caret = start + emoji.length;
    if (!TOUCH) {
      input.focus();
      input.setSelectionRange(caret, caret);
    }
  });
}

emojiButtons(dom.emojiRow, dom.chatInput);
emojiButtons(dom.surpriseEmoji, dom.surpriseInput);

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
    state.ended = null;
    state.status = null;
    dom.video.srcObject = stream;
    dom.video.muted = false;
    dom.video.hidden = false;
    dom.placeholder.hidden = true;
    hideOverlay();
    playVideo();
    updateSyncBadge();
  },
  onStateChange: (id, connectionState) => {
    if (screenShare.sharing) {
      hostConnectionChanged(id, connectionState);
      if (connectionState === 'still-trying') {
        toast('Still trying to reach them — it will pick up by itself when the network is back.', 8000);
      }
      return;
    }
    viewerConnectionChanged(connectionState);
  },
  onEnded: () => {
    statsSampler.previous.clear();
    dom.linkStats.hidden = true;
    dom.btnShare.querySelector('span').textContent = 'Share screen';
    dom.btnShare.setAttribute('aria-pressed', 'false');
    state.reclaimShare = false;
    for (const entry of dropNotices.values()) clearTimeout(entry.timer);
    dropNotices.clear();
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
  wakeLock.want(showingScreen() || screenShare.sharing);
}

const statsSampler = new StatsSampler();

async function updateLinkStats() {
  if (!showingScreen() || screenShare.peers.size === 0) {
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
  // So a dropped connection can reach the host while the film is full screen.
  askToNotify();
  // The picker is narrowed to whole screens and asks for audio already, so
  // there is nothing left to explain unless it comes back silent.
  startSharing();
});

// --------------------------------------------------------------- the gate --

function showGate(message) {
  state.entered = false;
  document.title = dom.roomName.textContent;
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
    state.connected &&
    sharer &&
    sharer !== state.me?.id &&
    !screenShare.sharing &&
    (!dom.video.srcObject || state.lost);

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
