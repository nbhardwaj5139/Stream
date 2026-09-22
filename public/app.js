// Client: keeps this browser's <video> lined up with the room's shared clock.
import { ScreenShare } from './screen.js';

const HARD_SEEK_THRESHOLD = 1.5;   // seconds out before we jump
const SOFT_NUDGE_THRESHOLD = 0.25; // seconds out before we speed up/slow down
const NUDGE_RATE = 0.06;           // ±6% playback rate to close small gaps
const REPORT_INTERVAL = 2000;

const el = (id) => document.getElementById(id);
const dom = {
  app: el('app'),
  video: el('video'),
  placeholder: el('placeholder'),
  placeholderTitle: el('placeholder-title'),
  placeholderText: el('placeholder-text'),
  placeholderHint: el('placeholder-hint'),
  placeholderBrowse: el('placeholder-browse'),
  overlay: el('overlay'),
  overlayText: el('overlay-text'),
  nudge: el('nudge'),
  roleBadge: el('role-badge'),
  nowPlaying: el('now-playing'),
  syncBadge: el('sync-badge'),
  qualityWrap: el('quality-wrap'),
  quality: el('quality'),
  btnResync: el('btn-resync'),
  btnStop: el('btn-stop'),
  screen: document.querySelector('.screen'),
  btnFullscreen: el('btn-fullscreen'),
  btnReload: el('btn-reload'),
  btnExit: el('btn-exit'),
  btnShare: el('btn-share'),
  btnLibrary: el('btn-library'),
  btnPanel: el('btn-panel'),
  panelLabel: el('panel-label'),
  btnPanelClose: el('btn-panel-close'),
  btnLeave: el('btn-leave'),
  presence: el('presence'),
  chat: el('chat'),
  composer: el('composer'),
  chatInput: el('chat-input'),
  librarySheet: el('library-sheet'),
  libraryList: el('library-list'),
  libraryFilter: el('library-filter'),
  libraryNote: el('library-note'),
  btnRescan: el('btn-rescan'),
  btnLibraryClose: el('btn-library-close'),
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
  library: [],
  media: null,
  room: null,
  viewers: [],
  capabilities: {},
  clockOffset: 0,   // serverTime - clientTime
  bestRtt: Infinity,
  socket: null,
  connected: false,
  applyingRemote: false,
  startOffset: 0,   // transcoded streams begin partway into the movie
  deliveryIndex: 0, // how far down deliveryChain() we have had to go
  needsGesture: false,
  buffering: false,
  filter: '',
  entered: false,
  screen: null,
};

// ------------------------------------------------------------------ misc --

const serverNow = () => Date.now() + state.clockOffset;

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function resolutionLabel(height) {
  if (!height) return '';
  if (height >= 2000) return '4K';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  return `${height}p`;
}

let toastTimer = null;
function toast(text, ms = 3600) {
  dom.toast.textContent = text;
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, ms);
}

let nudgeTimer = null;
function flash(text, ms = 2200) {
  dom.nudge.textContent = text;
  dom.nudge.hidden = false;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => { dom.nudge.hidden = true; }, ms);
}

const showOverlay = (text) => {
  dom.overlayText.textContent = text;
  dom.overlay.hidden = false;
};
const hideOverlay = () => { dom.overlay.hidden = true; };

// --------------------------------------------------------------- network --

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

const control = (action, extra = {}) => send({ type: 'control', action, ...extra });

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
    measureClock();
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

// Sample the round trip a few times and keep the fastest: the fastest sample
// has the least queuing noise, so its midpoint estimate is the most honest.
function measureClock(samples = 5) {
  let remaining = samples;
  const tick = () => {
    if (remaining-- <= 0) return;
    send({ type: 'ping', t0: Date.now() });
    setTimeout(tick, 220);
  };
  tick();
}

function handleMessage(message) {
  switch (message.type) {
    case 'welcome':
      state.me = message.you;
      state.role = message.you.role;
      state.library = message.library ?? [];
      state.capabilities = message.capabilities ?? {};
      dom.btnRescan.hidden = state.role !== 'host';
      // Both sides use the same link, so say plainly which passcode got you in.
      dom.roleBadge.textContent = state.role === 'host' ? 'Host' : 'Guest';
      dom.roleBadge.dataset.role = state.role;
      dom.roleBadge.hidden = false;
      renderLibrary();
      renderPermissions();
      for (const entry of message.chat ?? []) appendChat(entry, { quiet: true });
      applyState(message.state, { initial: true });
      warnAboutEncoding();
      break;

    case 'pong': {
      const rtt = Date.now() - message.t0;
      if (rtt < state.bestRtt) {
        state.bestRtt = rtt;
        state.clockOffset = message.serverTime - (message.t0 + rtt / 2);
      }
      break;
    }

    case 'state':
      applyState(message);
      break;

    case 'media':
      state.media = message.media;
      renderMedia();
      break;

    case 'presence': {
      const known = new Set(state.viewers.map((viewer) => viewer.id));
      state.viewers = message.viewers ?? [];
      // Somebody who joins mid-share needs their own offer.
      if (screenShare.sharing) {
        for (const viewer of state.viewers) {
          if (viewer.id !== state.me?.id && !known.has(viewer.id)) screenShare.offerTo(viewer.id);
        }
      }
      renderPresence();
      break;
    }

    case 'signal':
      screenShare.handleSignal(message).catch(() => {
        showOverlay('Could not connect to their screen.');
      });
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

function warnAboutEncoding() {
  if (state.role !== 'host') return;
  if (!state.capabilities.ffmpeg) {
    toast('ffmpeg was not found, so .mkv and 4K files will not play. Install it and restart.', 8000);
  } else if (!state.capabilities.hardwareEncoding) {
    toast('No GPU encoder found — 4K files will re-encode on the CPU and may stutter.', 8000);
  }
}

// ---------------------------------------------------------------- player --

const currentPosition = () => state.startOffset + (dom.video.currentTime || 0);

// Where the room says we should be, projected to this instant.
function targetPosition(room = state.room) {
  if (!room) return 0;
  if (room.paused) return room.position;
  const elapsed = (serverNow() - room.serverTime) / 1000;
  return Math.max(0, room.position + elapsed * room.rate);
}

// Safari reports it "cannot decode" a fragmented MP4 arriving on a chunked
// response, but plays HLS with no player library at all. Native HLS support is
// the reliable signal for which browsers those are.
const NATIVE_HLS = (() => {
  const probe = document.createElement('video');
  return Boolean(
    probe.canPlayType('application/vnd.apple.mpegurl') ||
      probe.canPlayType('application/x-mpegURL')
  );
})();

// Every way this browser could be handed the film, best first. Codec support
// is guesswork — a container can hold anything — so rather than predict it we
// try the next one whenever the browser says no. Nothing is "unsupported"
// until every route has failed.
function deliveryChain(media) {
  const quality = state.room?.quality ?? 'original';
  const chain = [];
  // Untouched bytes: best picture, instant seeking, no CPU. Only when the file
  // is already something browsers open and nobody asked to downscale.
  if (media.deliveryMode === 'direct' && quality === 'original') chain.push('direct');

  if (NATIVE_HLS) {
    // Safari genuinely cannot play a fragmented MP4 off a chunked response, so
    // falling back to one turns a slow start into a dead end. Retry HLS
    // instead — the usual cause is ffmpeg not having produced a segment yet.
    chain.push('hls', 'hls');
  } else {
    chain.push('fmp4', 'hls');
  }
  return chain;
}

function currentDelivery(media) {
  const chain = deliveryChain(media);
  return chain[Math.min(state.deliveryIndex, chain.length - 1)];
}

function streamUrl(media, startSeconds, mode = currentDelivery(media)) {
  if (!media) return null;

  const quality = state.room?.quality ?? 'original';
  const track = state.room?.audioTrack ?? 0;
  const start = Math.max(0, Math.floor(startSeconds || 0));

  if (mode === 'direct') {
    return new URL(`/stream/${media.id}`, location.href).toString();
  }

  if (mode === 'hls') {
    // Must match sessionKey() on the server.
    const key = `${media.id}_q-${quality}_t-${track}_s-${start}`;
    return new URL(`/hls/${key}/playlist.m3u8`, location.href).toString();
  }

  const url = new URL(`/transcode/${media.id}`, location.href);
  if (start > 0) url.searchParams.set('start', String(start));
  if (track) url.searchParams.set('track', String(track));
  url.searchParams.set('quality', quality);
  return url.toString();
}

function loadMedia(media, startSeconds = 0) {
  if (!media) return;
  // Between picking a film and the first frame there can be several seconds of
  // ffmpeg start-up. Say what is happening rather than showing a black box.
  showOverlay(`Getting ${media.name} ready…`);
  const transcoding = currentDelivery(media) !== 'direct';
  state.startOffset = transcoding ? Math.floor(startSeconds) : 0;

  dom.video.hidden = false;
  dom.placeholder.hidden = true;
  dom.video.src = streamUrl(media, startSeconds);
  dom.video.load();

  // Direct streams can seek freely; transcodes start at the requested point.
  if (!transcoding && startSeconds > 0) {
    const seekWhenReady = () => {
      dom.video.currentTime = startSeconds;
      dom.video.removeEventListener('loadedmetadata', seekWhenReady);
    };
    dom.video.addEventListener('loadedmetadata', seekWhenReady);
  }

  renderSubtitleTracks(media);
  renderMedia();
}

function renderSubtitleTracks(media) {
  for (const track of [...dom.video.querySelectorAll('track')]) track.remove();
  for (const subtitle of media.subtitles ?? []) {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = subtitle.label;
    track.src = `/subtitles/${media.id}/${subtitle.id}.vtt`;
    dom.video.append(track);
  }
}

// Seek this player to `position` in movie-time, reloading a transcode if the
// target is outside the window ffmpeg is currently producing.
function seekLocal(position) {
  const media = state.media;
  if (!media) return;

  if (currentDelivery(media) !== 'direct') {
    const relative = position - state.startOffset;
    const buffered = dom.video.buffered;
    let covered = false;
    for (let i = 0; i < buffered.length; i++) {
      if (relative >= buffered.start(i) - 0.5 && relative <= buffered.end(i) + 0.5) covered = true;
    }
    if (relative < 0 || !covered) {
      loadMedia(media, Math.max(0, position));
      return;
    }
    dom.video.currentTime = Math.max(0, relative);
    return;
  }

  dom.video.currentTime = Math.max(0, position);
}

async function playVideo() {
  try {
    await dom.video.play();
    state.needsGesture = false;
    hideOverlay();
  } catch {
    // Browsers block autoplay until the viewer interacts with the page.
    state.needsGesture = true;
    showOverlay('Tap anywhere to start watching');
  }
}

function applyState(room, { initial = false } = {}) {
  const previous = state.room;
  state.room = room;

  if (room.source === 'screen') {
    if (screenShare.sharing) {
      state.media = null;
      renderSharingCard();
      renderMedia();
      renderPermissions();
      updateSyncBadge();
      return;
    }
    if (previous?.source !== 'screen') {
      state.media = null;
      dom.placeholder.hidden = true;
      dom.video.hidden = false;
      // Only clear the element for someone who is about to receive a stream.
      // Doing it to the host tears down the preview they just started, and the
      // pause() aborts its play(), which surfaces as "tap to start watching"
      // on the machine that is doing the sharing.
      if (!screenShare.sharing) {
        dom.video.removeAttribute('src');
        dom.video.pause();
        dom.video.srcObject = null;
        showOverlay('Connecting to their screen…');
      }
      renderMedia();
    }
    renderMedia();
    renderPermissions();
    renderQuality();
    updateSyncBadge();
    return;
  }

  if (previous?.source === 'screen') {
    // Back to files: drop the peer connections and the live track.
    if (screenShare.sharing) screenShare.stop();
    else screenShare.closeAll();
    dom.video.srcObject = null;
    dom.video.muted = false;
    hideOverlay();
  }

  const mediaChanged = !previous || previous.mediaId !== room.mediaId;
  const encodingChanged =
    previous &&
    !mediaChanged &&
    state.media &&
    (previous.quality !== room.quality || previous.audioTrack !== room.audioTrack);

  if (!room.mediaId) {
    state.media = null;
    dom.video.removeAttribute('src');
    dom.video.hidden = true;
    dom.placeholder.hidden = false;
    renderEmptyState();
    hideOverlay();
    renderPermissions();
    updateSyncBadge();
    return;
  }

  if (mediaChanged) {
    fetchMedia(room.mediaId).then((media) => {
      if (!media || state.room?.mediaId !== media.id) return;
      state.media = media;
      state.deliveryIndex = 0;
      loadMedia(media, targetPosition());
      syncToRoom({ force: true });
    });
    return;
  }

  if (encodingChanged) {
    // ffmpeg has to be restarted with different settings; pick up where we are.
    state.deliveryIndex = 0;
    loadMedia(state.media, targetPosition());
  }

  syncToRoom({ force: initial });
  renderQuality();
  renderPermissions();
  updateSyncBadge();
}

async function fetchMedia(id) {
  const response = await fetch(`/api/media/${id}`, { credentials: 'same-origin' });
  if (!response.ok) {
    toast('That file could not be opened.');
    return null;
  }
  return response.json();
}

function syncToRoom({ force = false } = {}) {
  const room = state.room;
  // A shared screen is live: there is nothing to seek and nothing to line up.
  if (!room || room.source === 'screen' || !state.media) return;

  const target = targetPosition();
  const drift = currentPosition() - target;

  state.applyingRemote = true;
  try {
    if (room.paused) {
      if (!dom.video.paused) dom.video.pause();
      dom.video.playbackRate = room.rate;
      if (force || Math.abs(drift) > 0.4) seekLocal(target);
      if (room.waitingFor && room.waitingFor !== state.me?.id) {
        const who = state.viewers.find((viewer) => viewer.id === room.waitingFor);
        showOverlay(`Waiting for ${who?.name ?? 'the other side'} to buffer…`);
      } else if (!state.needsGesture) {
        hideOverlay();
      }
      return;
    }

    if (force || Math.abs(drift) > HARD_SEEK_THRESHOLD) {
      seekLocal(target);
      dom.video.playbackRate = room.rate;
    } else if (Math.abs(drift) > SOFT_NUDGE_THRESHOLD) {
      // Gently stretch time instead of jumping: far less jarring to watch.
      dom.video.playbackRate = room.rate * (drift > 0 ? 1 - NUDGE_RATE : 1 + NUDGE_RATE);
    } else {
      dom.video.playbackRate = room.rate;
    }

    if (dom.video.paused) playVideo();
    if (!state.needsGesture && !state.buffering) hideOverlay();
  } finally {
    state.applyingRemote = false;
  }
}

function nameOf(id) {
  return state.viewers.find((viewer) => viewer.id === id)?.name ?? 'the other side';
}

// Says what is happening in words, because "0.4s drift" means nothing to
// somebody who just opened a link on an iPad.
function updateSyncBadge() {
  const badge = dom.syncBadge;
  const room = state.room;

  if (!state.connected) {
    badge.textContent = 'Reconnecting…';
    badge.dataset.state = 'offline';
    return;
  }
  if (room?.source === 'screen') {
    badge.textContent = screenShare.sharing ? 'Sharing your screen' : 'Watching their screen';
    badge.dataset.state = 'ok';
    return;
  }
  if (!room?.mediaId) {
    const chooser = state.viewers.find((viewer) => viewer.browsing && viewer.id !== state.me?.id);
    badge.textContent = chooser ? `${chooser.name} is choosing…` : 'Nothing playing';
    badge.dataset.state = chooser ? 'drifting' : 'idle';
    return;
  }
  if (room.waitingFor) {
    badge.textContent =
      room.waitingFor === state.me?.id ? 'Loading…' : `Waiting for ${nameOf(room.waitingFor)}…`;
    badge.dataset.state = 'drifting';
    return;
  }
  if (state.media && dom.video.readyState < 2) {
    badge.textContent = 'Starting…';
    badge.dataset.state = 'drifting';
    return;
  }
  if (room.paused) {
    badge.textContent = 'Paused';
    badge.dataset.state = 'idle';
    return;
  }
  if (state.media && Math.abs(currentPosition() - targetPosition()) > HARD_SEEK_THRESHOLD) {
    badge.textContent = 'Catching up…';
    badge.dataset.state = 'drifting';
    return;
  }
  badge.textContent = 'Playing';
  badge.dataset.state = 'ok';
}

// ---------------------------------------------------------------- render --

// The library is the host's disk. A guest only ever sees what is playing.
function canBrowse() {
  return state.role === 'host' || state.room?.libraryMode === 'shared';
}

// What the host sees while sharing: not their own screen back again.
function renderSharingCard() {
  dom.video.hidden = true;
  dom.placeholder.hidden = false;
  hideOverlay();

  const others = state.viewers.filter((viewer) => viewer.id !== state.me?.id);
  dom.placeholderTitle.textContent = 'You are sharing this screen';
  dom.placeholderText.textContent =
    'Play the film however you like — everything on this monitor goes across.';
  dom.placeholderHint.textContent = others.length
    ? `${others.map((viewer) => viewer.name).join(' and ')} ${others.length === 1 ? 'is' : 'are'} watching.`
    : 'Nobody has joined yet.';
  dom.placeholderBrowse.hidden = true;
}

function renderEmptyState() {
  const others = state.viewers.filter((viewer) => viewer.id !== state.me?.id);
  if (canBrowse()) {
    dom.placeholderTitle.textContent = 'Nothing playing yet';
    dom.placeholderText.textContent = 'Pick something to watch and it will start for both of you.';
  } else {
    const chooser = state.viewers.find((viewer) => viewer.browsing);
    const host = state.viewers.find((viewer) => viewer.role === 'host');
    dom.placeholderTitle.textContent = chooser
      ? `${chooser.name} is choosing a film…`
      : 'Waiting for the film to start';
    dom.placeholderText.textContent = chooser
      ? 'It will start here by itself the moment they pick one.'
      : host
        ? `${host.name} is picking something. It will start here by itself.`
        : 'It will start here by itself as soon as they pick something.';
  }
  dom.placeholderHint.textContent = others.length
    ? `${others.map((viewer) => viewer.name).join(' and ')} ${others.length === 1 ? 'is' : 'are'} here too.`
    : 'Nobody else has joined yet.';
}

function renderPermissions() {
  const allowed = canBrowse();
  // Only the host has a screen, and only some browsers will hand it over.
  dom.btnShare.hidden = state.role !== 'host' || !navigator.mediaDevices?.getDisplayMedia;
  dom.btnLibrary.hidden = !allowed;
  dom.placeholderBrowse.hidden = !allowed || (isScreenMode() && screenShare.sharing);
  // Stopping puts everyone back to the empty room, so it belongs to whoever
  // is allowed to choose what plays.
  dom.btnStop.hidden = !allowed || !state.room?.mediaId;
  // The wording carries the state: there is nothing on, or you are swapping it.
  dom.btnLibrary.querySelector('span').textContent = state.room?.mediaId
    ? 'Change film'
    : 'Choose a film';
  dom.btnLibrary.classList.toggle('primary', !state.room?.mediaId);
  if (!allowed) closeLibrary();
}

function renderQuality() {
  // Quality is ffmpeg's business; a shared screen negotiates its own.
  dom.qualityWrap.hidden = !state.media || isScreenMode();
  if (state.media && state.room?.quality) dom.quality.value = state.room.quality;
}

function renderMedia() {
  const media = state.media;
  if (isScreenMode()) {
    dom.nowPlaying.textContent = screenShare.sharing ? 'Sharing your screen' : 'Their screen';
    document.title = screenShare.sharing ? 'Sharing — Stream' : 'Their screen — Stream';
    renderQuality();
    return;
  }
  if (!media) {
    dom.nowPlaying.textContent = 'Stream';
    document.title = 'Stream';
  } else {
    const tags = [
      resolutionLabel(media.height),
      media.hdr ? 'HDR' : '',
      currentDelivery(media) === 'direct' ? 'original' : 'converting',
    ]
      .filter(Boolean)
      .join(' · ');
    dom.nowPlaying.textContent = media.name;
    dom.nowPlaying.title = tags;
    document.title = `${media.name} — Stream`;
  }
  renderLibrary();
  renderQuality();
}

function renderLibrary() {
  const filter = state.filter.trim().toLowerCase();
  const items = filter
    ? state.library.filter((item) => item.relativePath.toLowerCase().includes(filter))
    : state.library;

  dom.libraryList.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = state.library.length
      ? 'Nothing matches that filter.'
      : 'No video files found in the folders being shared.';
    dom.libraryList.append(empty);
  }

  for (const item of items) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    if (item.id === state.room?.mediaId) button.setAttribute('aria-current', 'true');

    // Filename on top, then where it lives and what it is underneath.
    const separator = item.relativePath.includes('\\') ? '\\' : '/';
    const parts = item.relativePath.split(separator);
    const filename = parts.pop();
    const folder = parts.join(separator);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = filename;

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = [
      folder,
      resolutionLabel(item.height),
      item.duration ? formatDuration(item.duration) : '',
      formatSize(item.size),
    ]
      .filter(Boolean)
      .join('  ·  ');

    button.append(title, hint);
    button.addEventListener('click', () => {
      control('select', { mediaId: item.id });
      closeLibrary();
    });
    li.append(button);
    dom.libraryList.append(li);
  }

  dom.libraryNote.textContent =
    state.room?.controlMode === 'host' && state.role !== 'host'
      ? 'Only the host can change what is playing.'
      : `${state.library.length} file${state.library.length === 1 ? '' : 's'} available.`;
}

function renderPresence() {
  dom.presence.replaceChildren();
  for (const viewer of state.viewers) {
    const chip = document.createElement('span');
    chip.dataset.buffering = String(viewer.buffering);
    chip.dataset.role = viewer.role;
    chip.textContent = viewer.id === state.me?.id ? `${viewer.name} (you)` : viewer.name;
    if (viewer.buffering) chip.textContent += ' · buffering';
    dom.presence.append(chip);
  }
  const others = state.viewers.filter((viewer) => viewer.id !== state.me?.id);
  dom.panelLabel.textContent = others.length ? `Chat · ${others.length}` : 'Chat';
  if (!state.room?.mediaId) renderEmptyState();
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

dom.video.addEventListener('play', () => {
  if (state.applyingRemote || isScreenMode()) return;
  control('play', { position: currentPosition() });
});

dom.video.addEventListener('pause', () => {
  if (state.applyingRemote || isScreenMode() || dom.video.ended) return;
  control('pause', { position: currentPosition() });
});

dom.video.addEventListener('seeked', () => {
  if (state.applyingRemote || isScreenMode()) return;
  const position = currentPosition();
  if (Math.abs(position - targetPosition()) < 0.75) return;
  control('seek', { position });
});

dom.video.addEventListener('ratechange', () => {
  if (state.applyingRemote) return;
  // Ignore our own drift-correction nudges; only report deliberate changes.
  const expected = state.room?.rate ?? 1;
  const ratio = dom.video.playbackRate / expected;
  if (Math.abs(ratio - 1) <= NUDGE_RATE + 0.001) return;
  control('rate', { rate: dom.video.playbackRate });
});

for (const event of ['waiting', 'stalled']) {
  dom.video.addEventListener(event, () => {
    state.buffering = true;
    showOverlay('Buffering…');
  });
}
for (const event of ['playing', 'canplay', 'seeked']) {
  dom.video.addEventListener(event, () => {
    state.buffering = false;
    if (!state.needsGesture && !state.room?.waitingFor) hideOverlay();
  });
}

// The <video> error event says nothing useful, so try the next way of
// delivering the film before concluding anything is wrong with it.
async function explainPlaybackFailure() {
  const media = state.media;
  if (!media) return;

  if (!state.capabilities.ffmpeg) {
    showOverlay('This file needs ffmpeg on the host machine to play here.');
    return;
  }

  const chain = deliveryChain(media);
  if (state.deliveryIndex < chain.length - 1) {
    state.deliveryIndex += 1;
    showOverlay(`Getting ${media.name} ready…`);
    // A retry of the same route is almost always ffmpeg still starting up, so
    // give it a moment instead of asking again immediately.
    const same = chain[state.deliveryIndex] === chain[state.deliveryIndex - 1];
    setTimeout(() => {
      if (state.media !== media) return;
      loadMedia(media, targetPosition());
      syncToRoom({ force: true });
    }, same ? 4000 : 0);
    return;
  }

  // Every route failed. Ask the server what it made of the last one, because
  // it is the only side that can see ffmpeg's own complaint.
  showOverlay('Could not play that. Checking why…');
  try {
    const response = await fetch(streamUrl(media, state.startOffset), {
      credentials: 'same-origin',
    });
    if (response.ok) {
      response.body?.cancel();
      showOverlay('This browser could not decode that file, even converted.');
      return;
    }
    const detail = (await response.text()).trim();
    showOverlay(detail.slice(0, 400) || `The host machine returned ${response.status}.`);
  } catch {
    showOverlay('Lost contact with the host machine.');
  }
}

dom.video.addEventListener('error', () => {
  if (isScreenMode()) return;
  explainPlaybackFailure();
});

document.addEventListener('click', () => {
  if (!state.needsGesture) return;
  state.needsGesture = false;
  if (isScreenMode()) {
    hideOverlay();
    playVideo();
    return;
  }
  syncToRoom({ force: true });
}, { capture: true });

dom.quality.addEventListener('change', () => control('quality', { quality: dom.quality.value }));

// Fullscreen on the whole stage, so the overlays and "waiting for her to
// buffer" messages stay visible. iOS Safari will not do that for an arbitrary
// element, so there we hand the video its own native fullscreen instead.
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
  dom.btnFullscreen.textContent = isFullscreen() ? 'Exit fullscreen' : 'Fullscreen';
  dom.btnFullscreen.setAttribute('aria-pressed', String(isFullscreen()));
}

// Added to the home screen there is no browser chrome, so the page has to
// carry its own way out and its own way to start over.
const STANDALONE =
  window.matchMedia?.('(display-mode: standalone)').matches ||
  window.navigator.standalone === true;

dom.btnExit.hidden = !STANDALONE;

dom.btnReload.addEventListener('click', () => location.reload());

dom.btnExit.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  state.socket?.close();
  showGate();
});

dom.btnFullscreen.addEventListener('click', toggleFullscreen);
for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(event, renderFullscreenButton);
}

dom.btnStop.addEventListener('click', () => {
  control('select', { mediaId: null });
  flash('Stopped');
});

dom.btnResync.addEventListener('click', () => {
  state.bestRtt = Infinity;
  measureClock();
  syncToRoom({ force: true });
  flash('Re-synced');
});

const openLibrary = () => {
  if (!canBrowse()) return;
  dom.librarySheet.hidden = false;
  dom.libraryFilter.focus();
  send({ type: 'browsing', value: true });
};
const closeLibrary = () => {
  const wasOpen = !dom.librarySheet.hidden;
  dom.librarySheet.hidden = true;
  if (wasOpen) send({ type: 'browsing', value: false });
};

dom.btnLibrary.addEventListener('click', openLibrary);
dom.placeholderBrowse.addEventListener('click', openLibrary);
dom.btnLibraryClose.addEventListener('click', closeLibrary);
dom.librarySheet.addEventListener('click', (event) => {
  if (event.target === dom.librarySheet) closeLibrary();
});

dom.libraryFilter.addEventListener('input', () => {
  state.filter = dom.libraryFilter.value;
  renderLibrary();
});

dom.btnRescan.addEventListener('click', async () => {
  const response = await fetch('/api/rescan', { method: 'POST', credentials: 'same-origin' });
  if (!response.ok) {
    toast('Rescan failed.');
    return;
  }
  const body = await response.json();
  state.library = body.items;
  renderLibrary();
  toast(`Found ${body.items.length} files.`);
});

function togglePanel(open) {
  const next = open ?? dom.app.dataset.panel === 'closed';
  dom.app.dataset.panel = next ? 'open' : 'closed';
  dom.btnPanel.setAttribute('aria-expanded', String(next));
  if (next) dom.chat.scrollTop = dom.chat.scrollHeight;
}

dom.btnLeave.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  state.socket?.close();
  showGate();
});

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
  if (event.key === 'Escape') {
    closeLibrary();
    return;
  }
  if (event.key === 'f') {
    event.preventDefault();
    toggleFullscreen();
    return;
  }
  if (event.key === ' ' || event.key === 'k') {
    event.preventDefault();
    if (dom.video.paused) control('play', { position: currentPosition() });
    else control('pause', { position: currentPosition() });
    return;
  }
  const jump = { ArrowLeft: -10, ArrowRight: 10, j: -10, l: 10 }[event.key];
  if (jump !== undefined && state.media) {
    event.preventDefault();
    control('seek', { position: Math.max(0, targetPosition() + jump) });
  }
});

// ------------------------------------------------------------ screen share --

const isScreenMode = () => state.room?.source === 'screen';

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
  },
  onStateChange: (id, connectionState) => {
    if (connectionState === 'failed' && !screenShare.sharing) {
      showOverlay('Lost the connection to their screen. Trying again…');
    }
  },
  onEnded: () => {
    dom.btnShare.querySelector('span').textContent = 'Share screen';
    dom.btnShare.setAttribute('aria-pressed', 'false');
    if (isScreenMode()) control('source', { source: 'file' });
  },
});
state.screen = screenShare;

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
      'Sharing without sound. Stop, share again, choose "Entire Screen" and ' +
        'tick "Share system audio" — a single window cannot carry audio.',
      10_000
    );
  }

  dom.btnShare.querySelector('span').textContent = 'Stop sharing';
  dom.btnShare.setAttribute('aria-pressed', 'true');
  control('source', { source: 'screen' });

  // Deliberately no preview: sharing the whole screen means a preview of it
  // sits inside itself, repeating into infinity. The host is looking at the
  // real thing already.
  dom.video.removeAttribute('src');
  dom.video.srcObject = null;
  renderSharingCard();

  for (const viewer of state.viewers) {
    if (viewer.id !== state.me?.id) screenShare.offerTo(viewer.id);
  }
}

dom.btnShare.addEventListener('click', () => {
  if (screenShare.sharing) {
    screenShare.stop();
    control('source', { source: 'file' });
    return;
  }
  // The picker covers anything shown now, so leave the advice on screen for
  // after it closes as well.
  toast('Choose "Entire Screen" and tick "Share system audio" for sound.', 12_000);
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

setInterval(() => {
  if (!state.connected) return;
  if (isScreenMode()) {
    updateSyncBadge();
    return;
  }
  send({
    type: 'report',
    position: state.media ? currentPosition() : null,
    paused: dom.video.paused,
    buffering: state.buffering || dom.video.readyState < 3,
  });
  syncToRoom();
  updateSyncBadge();
}, REPORT_INTERVAL);

setInterval(updateSyncBadge, 1000);
setInterval(() => measureClock(2), 60_000);

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
