// Turning whatever was typed on the command line into a list of folders to
// serve. Kept apart from the CLI so the awkward cases can be tested.
import path from 'node:path';

import { VIDEO_EXTENSIONS } from './media.js';

export function expandHome(dir, homedir) {
  if (typeof dir !== 'string') return null;
  const trimmed = dir.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed.replace(/^~(?=$|[/\\])/, homedir));
}

// `statSync` is injected so this can be tested without touching a real disk.
export function resolveRoots(dirs, { homedir, stat }) {
  const roots = [];
  const problems = [];
  const seen = new Set();

  for (const dir of dirs) {
    const resolved = expandHome(dir, homedir);
    if (!resolved) continue;

    // Windows paths are case-insensitive, so compare them that way.
    const fingerprint = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    let info;
    try {
      info = stat(resolved);
    } catch {
      problems.push({ path: resolved, reason: 'missing' });
      continue;
    }

    // A stray argument — a pasted command, a file dragged into the terminal —
    // must not be accepted as a folder to share.
    if (!info.isDirectory()) {
      problems.push({ path: resolved, reason: 'not-a-folder' });
      continue;
    }

    roots.push(resolved);
  }

  return { roots, problems };
}

export function describeProblem({ path: target, reason }) {
  return reason === 'not-a-folder'
    ? `Not a folder: ${target}`
    : `Folder does not exist: ${target}`;
}

// Where the films probably are, for a machine that has never been told.
//
// Serving ~/Videos wholesale is a poor guess: it is full of game clips and
// screen recordings, and the films are one folder down in something called
// "Movies" or "Movie Night". Worse, the old list included ~/Downloads, which
// is one careless evening away from sharing something nobody meant to share.
//
// A folder named "Videos/Movies" wins wherever it turns up. The home folder is
// looked at first, and the other drives only if it has nothing — because on a
// work laptop some of those letters are network shares, and Windows can hang
// for half a minute on each one that is out of reach. So every look at the
// disk has a time limit, and after a couple of drives fail to answer the rest
// are left alone: the room starting is worth more than a folder it guessed.
const LIBRARY_BASES = ['Videos', 'Movies'];
const NAMED_LIKE_FILMS = /movie|film|cinema|watch/i;
const WINDOWS_DRIVES = 'CDEFGHIJKLMNOPQRSTUVWXYZ';

const RANK = { exact: 0, named: 1, hasFilms: 2, base: 3 };

// Windows path rules on Windows, POSIX everywhere else. In production this is
// exactly what `path` already does; stating it explicitly is what lets the
// Windows cases be tested from anywhere.
function flavour(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

// Where to look, in order, without touching the disk.
export function candidateBases({ homedir, platform = process.platform }) {
  const p = flavour(platform);
  const home = LIBRARY_BASES.map((base) => p.join(homedir, base));
  const drives = [];
  if (platform === 'win32') {
    for (const letter of WINDOWS_DRIVES) {
      for (const base of LIBRARY_BASES) drives.push(`${letter}:\\${base}`);
    }
  }
  return { home, drives };
}

const STALLED = Symbol('stalled');

// A disk operation that gives up waiting after `ms`. The underlying call may
// carry on in the background; we simply stop caring about its answer.
function limited(operation, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(STALLED), ms);
  });
  return Promise.race([Promise.resolve().then(operation), deadline])
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

export async function discoverMediaRoots({
  homedir,
  readdir,
  stat,
  platform = process.platform,
  timeoutMs = 1500,
  maxStalls = 2,
}) {
  const p = flavour(platform);
  const found = [];
  const existing = [];
  let stalls = 0;

  const add = (dir, rank) => {
    if (!found.some((entry) => entry.dir === dir)) found.push({ dir, rank });
  };

  const isDirectory = async (target) => {
    const info = await limited(() => stat(target), timeoutMs);
    if (info === STALLED) {
      stalls += 1;
      return false;
    }
    return Boolean(info?.isDirectory?.());
  };

  const list = async (dir) => {
    const entries = await limited(() => readdir(dir), timeoutMs);
    if (entries === STALLED) {
      stalls += 1;
      return [];
    }
    return Array.isArray(entries) ? entries : [];
  };

  const holdsVideo = (entries) =>
    entries.some((name) => VIDEO_EXTENSIONS.has(p.extname(name).toLowerCase()));

  const look = async (root) => {
    if (!(await isDirectory(root))) return;
    existing.push(root);
    const entries = await list(root);

    // A folder one level down that holds films beats the parent: it is the
    // one somebody made on purpose. "Movies" beats every other name.
    for (const name of entries) {
      const child = p.join(root, name);
      if (VIDEO_EXTENSIONS.has(p.extname(name).toLowerCase())) continue;
      if (!(await isDirectory(child))) continue;
      if (!holdsVideo(await list(child))) continue;
      if (/^movies$/i.test(name)) add(child, RANK.exact);
      else if (NAMED_LIKE_FILMS.test(name)) add(child, RANK.named);
      else add(child, RANK.hasFilms);
    }
    if (holdsVideo(entries)) add(root, RANK.base);
  };

  const { home, drives } = candidateBases({ homedir, platform });

  for (const root of home) await look(root);

  // Only wander onto other drives when home had nothing, stop at the first
  // one with films, and stop the moment drives start refusing to answer.
  if (found.length === 0) {
    for (const root of drives) {
      if (found.length || stalls >= maxStalls) break;
      await look(root);
    }
  }

  if (found.length) {
    found.sort((a, b) => a.rank - b.rank);
    return found.map((entry) => entry.dir);
  }

  // Nothing with films in it. Offer the obvious empty folder if there is one,
  // but never the app's own directory — and no folder at all is a perfectly
  // good way to run, because screen sharing needs none.
  return existing.length ? [existing[0]] : [];
}
