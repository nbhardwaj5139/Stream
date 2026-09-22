// Client: keeps this browser's <video> lined up with the room's shared clock.

const HARD_SEEK_THRESHOLD = 1.5;   // seconds out before we jump
const SOFT_NUDGE_THRESHOLD = 0.25; // seconds out before we speed up/slow down
const NUDGE_RATE = 0.06;           // ±6% playback rate to close small gaps
const REPORT_INTERVAL = 2000;

const el = (id) => document.getElementById(id);
const dom = {
  app: el('app'),
  video: el('video'),
  placeholder: el('placeholder'),
  placeholderText: el('placeholder-text'),
  placeholderBrowse: el('placeholder-browse'),
  overlay: el('overlay'),
  overlayText: el('overlay-text'),
  nudge: el('nudge'),
  nowPlaying: el('now-playing'),
  syncBadge: el('sync-badge'),
  qualityWrap: el('quality-wrap'),
  quality: el('quality'),
  btnResync: el('btn-resync'),
  btnShareScreen: el('btn-share-screen'),
  btnLibrary: el('btn-library'),
  btnPanel: el('btn-panel'),
  btnPanelClose: el('btn-panel-close'),
  panel: el('panel'),
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
};

const state = {
  me: null,
  role: 'guest',
  library: [],
  media: null,
  room: null,
  viewers: [],
  clockOffset: 0,   // serverTime - clientTime
  bestRtt: Infinity,
  socket: null,
  connected: false,
  applyingRemote: false,
  startOffset: 0,   // transcoded streams begin partway into the movie
  needsGesture: false,
  buffering: false,
  lastReportedBuffering: null,
  screenStream: null,
  peers: new Map(),
  filter: '',
};

const key = new URL(location.href).searchParams.get('k') ?? '';

// ------------------------------------------------------------------ misc --

function serverNow() {
  return Date.now() + state.clockOffset;
}

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

let toastTimer = null;
function toast(text, ms = 3200) {
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

function showOverlay(text) {
  dom.overlayText.textContent = text;
  dom.overlay.hidden = false;
}

function hideOverlay() {
  dom.overlay.hidden = true;
}

// --------------------------------------------------------------- network --

function send(message) {
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function control(action, extra = {}) {
  send({ type: 'control', action, ...extra });
}

let reconnectDelay = 500;

function connect() {
  const url = new URL('/ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (key) url.searchParams.set('k', key);

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

  socket.addEventListener('close', () => {
    state.connected = false;
    updateSyncBadge();
    for (const peer of state.peers.values()) peer.close();
    state.peers.clear();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  });

  socket.addEventListener('error', () => socket.close());
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
      dom.btnShareScreen.hidden = state.role !== 'host' || !navigator.mediaDevices?.getDisplayMedia;
      dom.btnRescan.hidden = state.role !== 'host';
      renderLibrary();
      for (const entry of message.chat ?? []) appendChat(entry, { quiet: true });
      applyState(message.state, { initial: true });
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

    case 'presence':
      state.viewers = message.viewers ?? [];
      renderPresence();
      break;

    case 'chat':
      appendChat(message.entry);
      break;

    case 'signal':
      handleSignal(message).catch((error) => console.warn('signal failed', error));
      break;

    case 'error':
      toast(message.error);
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------- player --

function currentPosition() {
  return state.startOffset + (dom.video.currentTime || 0);
}

// Where the room says we should be, projected to this instant.
function targetPosition(room = state.room) {
  if (!room) return 0;
  if (room.paused) return room.position;
  const elapsed = (serverNow() - room.serverTime) / 1000;
  return Math.max(0, room.position + elapsed * room.rate);
}

// Only the transcoder can change resolution; direct streams are sent as-is.
const MAX_HEIGHT_BY_QUALITY = { original: null, high: 1080, medium: 720, low: 480 };

function streamUrl(media, startSeconds) {
  if (!media) return null;
  const url = new URL(
    media.deliveryMode === 'transcode' ? `/transcode/${media.id}` : `/stream/${media.id}`,
    location.href
  );
  if (media.deliveryMode === 'transcode') {
    if (startSeconds > 0) url.searchParams.set('start', String(Math.floor(startSeconds)));
    if (state.room?.audioTrack) url.searchParams.set('track', String(state.room.audioTrack));
    const quality = state.room?.quality ?? 'medium';
    url.searchParams.set('quality', quality);
    const maxHeight = MAX_HEIGHT_BY_QUALITY[quality];
    if (maxHeight) url.searchParams.set('maxHeight', String(maxHeight));
  }
  if (key) url.searchParams.set('k', key);
  return url.toString();
}

function loadMedia(media, startSeconds = 0) {
  if (!media) return;
  state.startOffset = media.deliveryMode === 'transcode' ? Math.floor(startSeconds) : 0;

  dom.video.hidden = false;
  dom.placeholder.hidden = true;
  dom.video.src = streamUrl(media, startSeconds);
  dom.video.load();

  // Direct streams can seek freely; transcodes start at the requested point.
  if (media.deliveryMode !== 'transcode' && startSeconds > 0) {
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
    const url = new URL(`/subtitles/${media.id}/${subtitle.id}.vtt`, location.href);
    if (key) url.searchParams.set('k', key);
    track.src = url.toString();
    dom.video.append(track);
  }
}

// Seek this player to `position` in movie-time, reloading a transcode if the
// target is outside the window ffmpeg is currently producing.
function seekLocal(position) {
  const media = state.media;
  if (!media) return;

  if (media.deliveryMode === 'transcode') {
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
    applyScreenMode(previous);
    updateSyncBadge();
    return;
  }

  const mediaChanged = !previous || previous.mediaId !== room.mediaId || previous.source !== room.source;
  const encodingChanged =
    previous &&
    !mediaChanged &&
    state.media?.deliveryMode === 'transcode' &&
    (previous.quality !== room.quality || previous.audioTrack !== room.audioTrack);

  if (!room.mediaId) {
    state.media = null;
    dom.video.removeAttribute('src');
    dom.video.hidden = true;
    dom.placeholder.hidden = false;
    dom.placeholderText.textContent =
      state.role === 'host' || room.controlMode !== 'host'
        ? 'Pick something from the library to get started.'
        : 'Waiting for the host to pick something.';
    hideOverlay();
    updateSyncBadge();
    return;
  }

  if (mediaChanged) {
    fetchMedia(room.mediaId).then((media) => {
      if (!media || state.room?.mediaId !== media.id) return;
      state.media = media;
      loadMedia(media, targetPosition());
      syncToRoom({ force: true });
    });
    return;
  }

  if (encodingChanged) {
    // ffmpeg has to be restarted with different settings; pick up where we are.
    loadMedia(state.media, targetPosition());
  }

  syncToRoom({ force: initial });
  renderQuality();
  updateSyncBadge();
}

async function fetchMedia(id) {
  const url = new URL(`/api/media/${id}`, location.href);
  if (key) url.searchParams.set('k', key);
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    toast('That file could not be opened.');
    return null;
  }
  return response.json();
}

function syncToRoom({ force = false } = {}) {
  const room = state.room;
  if (!room || room.source !== 'file' || !state.media) return;

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

function updateSyncBadge() {
  if (!state.connected) {
    dom.syncBadge.textContent = 'reconnecting';
    dom.syncBadge.dataset.state = 'offline';
    return;
  }
  if (state.room?.source === 'screen') {
    dom.syncBadge.textContent = 'screen share';
    dom.syncBadge.dataset.state = 'ok';
    return;
  }
  if (!state.media) {
    dom.syncBadge.textContent = 'connected';
    dom.syncBadge.dataset.state = 'ok';
    return;
  }
  const drift = Math.abs(currentPosition() - targetPosition());
  if (drift > HARD_SEEK_THRESHOLD) {
    dom.syncBadge.textContent = `${drift.toFixed(1)}s behind`;
    dom.syncBadge.dataset.state = 'drifting';
  } else {
    dom.syncBadge.textContent = 'in sync';
    dom.syncBadge.dataset.state = 'ok';
  }
}

// ----------------------------------------------------------- screen share --

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
};

function applyScreenMode(previous) {
  dom.video.hidden = false;
  dom.placeholder.hidden = true;
  if (previous?.source !== 'screen') {
    dom.video.removeAttribute('src');
    dom.video.srcObject = null;
    if (state.role !== 'host') showOverlay('Connecting to the shared screen…');
  }
  dom.nowPlaying.textContent = state.role === 'host' ? 'Sharing your screen' : 'Watching shared screen';
}

function createPeer(remoteId) {
  const peer = new RTCPeerConnection(RTC_CONFIG);
  state.peers.set(remoteId, peer);

  peer.addEventListener('icecandidate', (event) => {
    if (event.candidate) {
      send({ type: 'signal', to: remoteId, data: { candidate: event.candidate } });
    }
  });

  peer.addEventListener('connectionstatechange', () => {
    if (['failed', 'closed'].includes(peer.connectionState)) {
      peer.close();
      state.peers.delete(remoteId);
      if (state.role !== 'host' && state.room?.source === 'screen') {
        showOverlay('Lost the screen share. Trying again…');
      }
    }
  });

  peer.addEventListener('track', (event) => {
    dom.video.srcObject = event.streams[0];
    dom.video.muted = false;
    hideOverlay();
    playVideo();
  });

  return peer;
}

async function handleSignal({ from, data }) {
  let peer = state.peers.get(from);

  if (data.sdp) {
    if (!peer) peer = createPeer(from);
    await peer.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      send({ type: 'signal', to: from, data: { sdp: peer.localDescription } });
    }
    return;
  }

  if (data.candidate && peer) {
    try {
      await peer.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch {
      /* candidates can arrive before the description; safe to drop */
    }
  }
}

async function offerTo(viewerId) {
  if (!state.screenStream || viewerId === state.me?.id) return;
  const peer = createPeer(viewerId);
  for (const track of state.screenStream.getTracks()) {
    peer.addTrack(track, state.screenStream);
  }
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  send({ type: 'signal', to: viewerId, data: { sdp: peer.localDescription } });
}

async function startScreenShare() {
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch {
    toast('Screen share was cancelled.');
    return;
  }

  if (state.screenStream.getAudioTracks().length === 0) {
    toast('No audio was captured. In Chrome, tick "Share tab audio" when choosing what to share.', 6000);
  }

  state.screenStream.getVideoTracks()[0]?.addEventListener('ended', stopScreenShare);

  dom.btnShareScreen.textContent = 'Stop sharing';
  dom.btnShareScreen.setAttribute('aria-pressed', 'true');
  control('source', { source: 'screen' });

  // Show the host their own feed, muted to avoid a feedback loop.
  dom.video.srcObject = state.screenStream;
  dom.video.muted = true;
  dom.video.hidden = false;
  dom.placeholder.hidden = true;
  playVideo();

  for (const viewer of state.viewers) {
    if (viewer.id !== state.me?.id) offerTo(viewer.id);
  }
}

function stopScreenShare() {
  for (const track of state.screenStream?.getTracks() ?? []) track.stop();
  state.screenStream = null;
  for (const peer of state.peers.values()) peer.close();
  state.peers.clear();
  dom.video.srcObject = null;
  dom.video.muted = false;
  dom.btnShareScreen.textContent = 'Share screen';
  dom.btnShareScreen.setAttribute('aria-pressed', 'false');
  control('source', { source: 'file' });
}

// ---------------------------------------------------------------- render --

function renderQuality() {
  const transcoding = state.media?.deliveryMode === 'transcode';
  dom.qualityWrap.hidden = !transcoding;
  if (transcoding && state.room?.quality) dom.quality.value = state.room.quality;
}

function renderMedia() {
  dom.nowPlaying.textContent = state.media?.name ?? 'Stream';
  document.title = state.media ? `${state.media.name} — Stream` : 'Stream';
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

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.relativePath;

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = [item.duration ? formatDuration(item.duration) : '', formatSize(item.size)]
      .filter(Boolean)
      .join(' · ');

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
    const isMe = viewer.id === state.me?.id;
    chip.textContent = isMe ? `${viewer.name} (you)` : viewer.name;
    if (viewer.buffering) chip.textContent += ' · buffering';
    dom.presence.append(chip);
  }
  dom.btnPanel.textContent = `Chat · ${state.viewers.length}`;
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
  if (state.applyingRemote || state.room?.source === 'screen') return;
  control('play', { position: currentPosition() });
});

dom.video.addEventListener('pause', () => {
  if (state.applyingRemote || state.room?.source === 'screen') return;
  if (dom.video.ended) return;
  control('pause', { position: currentPosition() });
});

dom.video.addEventListener('seeked', () => {
  if (state.applyingRemote || state.room?.source === 'screen') return;
  const position = currentPosition();
  if (Math.abs(position - targetPosition()) < 0.75) return;
  control('seek', { position });
});

dom.video.addEventListener('ratechange', () => {
  if (state.applyingRemote || state.room?.source === 'screen') return;
  // Ignore our own drift-correction nudges; only report deliberate changes.
  const expected = state.room?.rate ?? 1;
  const ratio = dom.video.playbackRate / expected;
  if (Math.abs(ratio - 1) <= NUDGE_RATE + 0.001) return;
  control('rate', { rate: dom.video.playbackRate });
});

for (const event of ['waiting', 'stalled']) {
  dom.video.addEventListener(event, () => {
    state.buffering = true;
    if (state.room?.source === 'file') showOverlay('Buffering…');
  });
}
for (const event of ['playing', 'canplay', 'seeked']) {
  dom.video.addEventListener(event, () => {
    state.buffering = false;
    if (!state.needsGesture && !state.room?.waitingFor) hideOverlay();
  });
}

dom.video.addEventListener('error', () => {
  if (state.room?.source === 'screen' || !state.media) return;
  const hint =
    state.media.deliveryMode === 'transcode'
      ? 'This file needs ffmpeg on the host machine to play here.'
      : 'This browser could not play that file.';
  showOverlay(hint);
});

document.addEventListener('click', () => {
  if (!state.needsGesture) return;
  state.needsGesture = false;
  syncToRoom({ force: true });
}, { capture: true });

dom.quality.addEventListener('change', () => {
  control('quality', { quality: dom.quality.value });
});

dom.btnResync.addEventListener('click', () => {
  state.bestRtt = Infinity;
  measureClock();
  syncToRoom({ force: true });
  flash('Re-synced');
});

dom.btnShareScreen.addEventListener('click', () => {
  if (state.screenStream) stopScreenShare();
  else startScreenShare();
});

function openLibrary() {
  dom.librarySheet.hidden = false;
  dom.libraryFilter.focus();
}
function closeLibrary() {
  dom.librarySheet.hidden = true;
}

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
  const url = new URL('/api/rescan', location.href);
  if (key) url.searchParams.set('k', key);
  const response = await fetch(url, { method: 'POST', credentials: 'same-origin' });
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
  if (event.target.matches('input, textarea')) return;
  if (event.key === 'Escape') {
    closeLibrary();
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

// Ask for a display name once, so chat isn't two people called "Guest".
function ensureName() {
  let name = localStorage.getItem('stream:name');
  if (!name) {
    name = (prompt('What should the other side call you?') ?? '').trim();
    if (name) localStorage.setItem('stream:name', name);
  }
  return name;
}

setInterval(() => {
  if (!state.connected) return;
  const buffering = state.buffering || dom.video.readyState < 3;
  send({
    type: 'report',
    position: state.media ? currentPosition() : null,
    paused: dom.video.paused,
    buffering,
  });
  state.lastReportedBuffering = buffering;
  syncToRoom();
  updateSyncBadge();
}, REPORT_INTERVAL);

setInterval(updateSyncBadge, 1000);
setInterval(() => measureClock(2), 60_000);

ensureName();
connect();
