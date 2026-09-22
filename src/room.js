// The shared playback state everyone in the room is following.
import crypto from 'node:crypto';

const CHAT_HISTORY_LIMIT = 200;
const CHAT_MAX_LENGTH = 800;
const NAME_MAX_LENGTH = 40;

export function now() {
  return Date.now();
}

function sanitizeName(name, fallback) {
  if (typeof name !== 'string') return fallback;
  const cleaned = name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX_LENGTH);
  return cleaned || fallback;
}

export class Room {
  constructor({
    controlMode = 'everyone',
    libraryMode = 'host',
    autoPauseOnBuffer = false,
    // How long the room will hold for one person's buffer before giving up.
    // Without a bound, a viewer who never finishes loading stops the film for
    // everyone, permanently.
    maxBufferHoldMs = 30_000,
    clock = now,
  } = {}) {
    this.controlMode = controlMode; // 'everyone' | 'host'
    // 'host': guests never see the file list, only what is playing right now.
    this.libraryMode = libraryMode; // 'host' | 'shared'
    this.autoPauseOnBuffer = autoPauseOnBuffer;
    this.maxBufferHoldMs = maxBufferHoldMs;
    this.clock = clock;

    this.mediaId = null;
    this.paused = true;
    this.rate = 1;
    this.audioTrack = 0;
    // 'original' keeps ffmpeg in remux mode where it can: far cheaper than
    // downscaling, and lossless. Either side can dial it down if it stutters.
    this.quality = 'original';

    this.anchorPosition = 0; // playback seconds at anchorTime
    this.anchorTime = this.clock();

    this.viewers = new Map();
    this.chat = [];
    this.version = 0;
    this.waitingFor = null; // viewer id we auto-paused for
    this.waitingSince = null;
    // Why we are paused. A pause somebody asked for must never be undone by
    // the buffering logic deciding everyone has caught up.
    this.pausedBy = null; // 'user' | 'buffer'
  }

  // Where the movie should be right now, in seconds.
  positionAt(timestamp = this.clock()) {
    if (this.paused) return this.anchorPosition;
    const elapsed = (timestamp - this.anchorTime) / 1000;
    return Math.max(0, this.anchorPosition + elapsed * this.rate);
  }

  _anchor(position, timestamp = this.clock()) {
    this.anchorPosition = Math.max(0, position);
    this.anchorTime = timestamp;
    this.version += 1;
  }

  addViewer({ id = crypto.randomUUID(), name, role = 'guest' } = {}) {
    const viewer = {
      id,
      name: sanitizeName(name, role === 'host' ? 'Host' : 'Guest'),
      role,
      joinedAt: this.clock(),
      lastSeen: this.clock(),
      position: null,
      paused: true,
      buffering: false,
      // True while they have the film list open, so the other side is told
      // somebody is choosing rather than left staring at an empty room.
      browsing: false,
      drift: null,
    };
    this.viewers.set(id, viewer);
    return viewer;
  }

  removeViewer(id) {
    const viewer = this.viewers.get(id);
    this.viewers.delete(id);
    if (this.waitingFor === id) this.waitingFor = null;
    return viewer ?? null;
  }

  // Browsing the disk is a separate privilege from pausing the film.
  canBrowse(viewer) {
    if (!viewer) return false;
    return this.libraryMode === 'shared' || viewer.role === 'host';
  }

  canControl(viewer) {
    if (!viewer) return false;
    if (this.controlMode === 'host') return viewer.role === 'host';
    return true;
  }

  setBrowsing(viewer, value) {
    if (!viewer) return false;
    const next = Boolean(value) && this.canBrowse(viewer);
    if (viewer.browsing === next) return false;
    viewer.browsing = next;
    return true;
  }

  rename(id, name) {
    const viewer = this.viewers.get(id);
    if (!viewer) return null;
    viewer.name = sanitizeName(name, viewer.name);
    return viewer;
  }

  // Returns { changed, reason } — callers broadcast when `changed` is true.
  applyControl(viewer, message) {
    if (!this.canControl(viewer)) {
      return { changed: false, reason: 'not-allowed' };
    }
    const timestamp = this.clock();

    switch (message.action) {
      case 'play': {
        this.waitingSince = null;
        if (typeof message.position === 'number' && Number.isFinite(message.position)) {
          this._anchor(message.position, timestamp);
        } else if (this.paused) {
          this._anchor(this.anchorPosition, timestamp);
        }
        if (!this.paused) return { changed: false };
        this.paused = false;
        this.waitingFor = null;
        this.pausedBy = null;
        return { changed: true, reason: 'play', by: viewer.id };
      }

      case 'pause': {
        const position =
          typeof message.position === 'number' && Number.isFinite(message.position)
            ? message.position
            : this.positionAt(timestamp);
        this.paused = true;
        // Somebody asked for this, so stop waiting on anyone's buffer.
        this.pausedBy = 'user';
        this.waitingFor = null;
        this.waitingSince = null;
        this._anchor(position, timestamp);
        return { changed: true, reason: 'pause', by: viewer.id };
      }

      case 'seek': {
        if (typeof message.position !== 'number' || !Number.isFinite(message.position)) {
          return { changed: false, reason: 'bad-position' };
        }
        this._anchor(message.position, timestamp);
        return { changed: true, reason: 'seek', by: viewer.id };
      }

      case 'rate': {
        const rate = Number(message.rate);
        if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) {
          return { changed: false, reason: 'bad-rate' };
        }
        // Re-anchor first so the speed change doesn't retroactively move us.
        this._anchor(this.positionAt(timestamp), timestamp);
        this.rate = rate;
        return { changed: true, reason: 'rate', by: viewer.id };
      }

      case 'select': {
        if (!this.canBrowse(viewer)) return { changed: false, reason: 'not-allowed-browse' };
        this.mediaId = typeof message.mediaId === 'string' ? message.mediaId : null;
        this.paused = true;
        this.rate = 1;
        this.audioTrack = 0;
        this._anchor(Number(message.position) || 0, timestamp);
        this.waitingFor = null;
        this.pausedBy = null;
        return { changed: true, reason: 'select', by: viewer.id };
      }

      case 'audioTrack': {
        const track = Number(message.track);
        if (!Number.isInteger(track) || track < 0 || track > 32) {
          return { changed: false, reason: 'bad-track' };
        }
        this.audioTrack = track;
        return { changed: true, reason: 'audioTrack', by: viewer.id };
      }

      case 'quality': {
        if (!['low', 'medium', 'high', 'original'].includes(message.quality)) {
          return { changed: false, reason: 'bad-quality' };
        }
        this.quality = message.quality;
        return { changed: true, reason: 'quality', by: viewer.id };
      }

      default:
        return { changed: false, reason: 'unknown-action' };
    }
  }

  // A viewer telling us where they actually are. May auto-pause the room.
  report(viewer, message) {
    if (!viewer) return { changed: false };
    viewer.lastSeen = this.clock();
    if (typeof message.position === 'number' && Number.isFinite(message.position)) {
      viewer.position = message.position;
      viewer.drift = this.paused ? null : message.position - this.positionAt();
    }
    if (typeof message.paused === 'boolean') viewer.paused = message.paused;

    const wasBuffering = viewer.buffering;
    viewer.buffering = Boolean(message.buffering);

    if (!this.autoPauseOnBuffer) return { changed: false };

    if (viewer.buffering && !wasBuffering && !this.paused) {
      // Freeze where the movie is *now*, before flipping the flag: once paused,
      // positionAt() stops advancing and would report the old anchor.
      const frozenAt = this.positionAt();
      this.paused = true;
      this.pausedBy = 'buffer';
      this._anchor(frozenAt, this.clock());
      this.waitingFor = viewer.id;
      this.waitingSince = this.clock();
      return { changed: true, reason: 'buffering', by: viewer.id };
    }

    if (!viewer.buffering && wasBuffering && this.waitingFor === viewer.id) {
      this.waitingFor = null;
      this.waitingSince = null;
      // Only resume a pause we caused. If somebody hit pause while we were
      // waiting, that is the state they asked for and it stands.
      if (this.pausedBy !== 'buffer') return { changed: false };

      const stillStalled = [...this.viewers.values()].some((other) => other.buffering);
      if (!stillStalled) {
        this.paused = false;
        this.pausedBy = null;
        this._anchor(this.anchorPosition, this.clock());
        return { changed: true, reason: 'resume', by: viewer.id };
      }
    }

    return { changed: false };
  }

  // Called on a timer. Somebody whose video never finishes loading would
  // otherwise hold the room for good — and a viewer who is paused may never
  // buffer enough to say they have recovered, which makes that a deadlock
  // rather than a wait.
  releaseStaleHold(timestamp = this.clock()) {
    if (!this.waitingFor || this.pausedBy !== 'buffer') return { changed: false };
    if (this.waitingSince === null) return { changed: false };
    if (timestamp - this.waitingSince < this.maxBufferHoldMs) return { changed: false };

    const waited = this.waitingFor;
    this.waitingFor = null;
    this.waitingSince = null;
    this.paused = false;
    this.pausedBy = null;
    this._anchor(this.anchorPosition, timestamp);
    return { changed: true, reason: 'gave-up-waiting', by: waited };
  }

  addChat(viewer, text) {
    if (!viewer || typeof text !== 'string') return null;
    const body = text.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
    if (!body) return null;
    const entry = {
      id: crypto.randomUUID(),
      from: viewer.id,
      name: viewer.name,
      text: body,
      at: this.clock(),
      position: this.positionAt(),
    };
    this.chat.push(entry);
    if (this.chat.length > CHAT_HISTORY_LIMIT) this.chat.splice(0, this.chat.length - CHAT_HISTORY_LIMIT);
    return entry;
  }

  // Back to an empty room: nothing playing, nothing waiting. Chat is kept —
  // it is the conversation, not the playback state.
  clearPlayback() {
    this.mediaId = null;
    this.waitingSince = null;
    this.paused = true;
    this.rate = 1;
    this.audioTrack = 0;
    this.quality = 'original';
    this.waitingFor = null;
    this.pausedBy = null;
    this._anchor(0);
    return this.snapshot();
  }

  snapshot() {
    const timestamp = this.clock();
    return {
      type: 'state',
      version: this.version,
      serverTime: timestamp,
      mediaId: this.mediaId,
      paused: this.paused,
      position: this.positionAt(timestamp),
      rate: this.rate,
      audioTrack: this.audioTrack,
      quality: this.quality,
      controlMode: this.controlMode,
      libraryMode: this.libraryMode,
      pausedBy: this.pausedBy,
      waitingFor: this.waitingFor,
    };
  }

  presence() {
    return {
      type: 'presence',
      viewers: [...this.viewers.values()].map((viewer) => ({
        id: viewer.id,
        name: viewer.name,
        role: viewer.role,
        buffering: viewer.buffering,
        browsing: viewer.browsing,
        drift: viewer.drift === null ? null : Math.round(viewer.drift * 100) / 100,
      })),
    };
  }
}
