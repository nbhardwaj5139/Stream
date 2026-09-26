// Who is in the room, whose screen is being shown, and what has been said.
//
// There is no playback state: a shared screen is live, so there is nothing to
// seek, pause or keep in step. The only thing the room decides is whose screen
// everyone is looking at.
import crypto from 'node:crypto';

const CHAT_HISTORY_LIMIT = 200;
const CHAT_MAX_LENGTH = 800;
const NAME_MAX_LENGTH = 40;

// Cut to a length without cutting a character in half. Most emoji are two
// UTF-16 units, and many are several joined — a family, a flag, a skin tone —
// so a plain slice can leave half of one behind, which shows as a broken box.
const graphemes =
  typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

export function trimToLength(text, max) {
  if (text.length <= max) return text;
  let out = '';
  const pieces = graphemes ? Array.from(graphemes.segment(text), (piece) => piece.segment) : Array.from(text);
  for (const piece of pieces) {
    if (out.length + piece.length > max) break;
    out += piece;
  }
  return out;
}

function sanitizeName(name, fallback) {
  if (typeof name !== 'string') return fallback;
  const cleaned = trimToLength(name.replace(/\s+/g, ' ').trim(), NAME_MAX_LENGTH);
  return cleaned || fallback;
}

export class Room {
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    // Whose screen is showing, or null. A screen belongs to the person whose
    // screen it is, so it ends when they leave.
    this.sharerId = null;
    this.viewers = new Map();
    this.chat = [];
    this.version = 0;
  }

  addViewer({ id = crypto.randomUUID(), name, role = 'guest' } = {}) {
    const viewer = {
      id,
      name: sanitizeName(name, role === 'host' ? 'Host' : 'Guest'),
      role,
      joinedAt: this.clock(),
    };
    this.viewers.set(id, viewer);
    return viewer;
  }

  // Returns true when their leaving ended a share, so the caller can say so.
  removeViewer(id) {
    const viewer = this.viewers.get(id);
    this.viewers.delete(id);
    if (this.sharerId === id) {
      // Without this the room would go on claiming a screen nobody is sharing,
      // and whoever joined next would wait for a picture that never comes.
      this.sharerId = null;
      this.version += 1;
      return { viewer: viewer ?? null, endedShare: true };
    }
    return { viewer: viewer ?? null, endedShare: false };
  }

  rename(id, name) {
    const viewer = this.viewers.get(id);
    if (!viewer) return null;
    viewer.name = sanitizeName(name, viewer.name);
    return viewer;
  }

  // Start or stop showing this viewer's screen. Returns { changed, reason }.
  setSharing(viewer, on) {
    if (!viewer) return { changed: false, reason: 'unknown-viewer' };
    // Only the host has a screen to share.
    if (viewer.role !== 'host') return { changed: false, reason: 'not-allowed' };

    if (on) {
      if (this.sharerId === viewer.id) return { changed: false };
      this.sharerId = viewer.id;
    } else {
      // Stopping someone else's share is not this viewer's to do.
      if (this.sharerId !== viewer.id) return { changed: false };
      this.sharerId = null;
    }
    this.version += 1;
    return { changed: true };
  }

  addChat(viewer, text) {
    if (!viewer || typeof text !== 'string') return null;
    const body = trimToLength(text.replace(/\s+/g, ' ').trim(), CHAT_MAX_LENGTH);
    if (!body) return null;
    const entry = {
      id: crypto.randomUUID(),
      from: viewer.id,
      name: viewer.name,
      text: body,
      at: this.clock(),
    };
    this.chat.push(entry);
    if (this.chat.length > CHAT_HISTORY_LIMIT) this.chat.splice(0, this.chat.length - CHAT_HISTORY_LIMIT);
    return entry;
  }

  snapshot() {
    return { type: 'state', version: this.version, sharerId: this.sharerId };
  }

  presence() {
    return {
      type: 'presence',
      viewers: [...this.viewers.values()].map((viewer) => ({
        id: viewer.id,
        name: viewer.name,
        role: viewer.role,
      })),
    };
  }
}
