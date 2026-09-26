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
// A folder named "Videos/Movies" is the answer wherever it turns up — under
// the home folder on one laptop, on a second drive on another — so it is
// looked for on every drive and always wins.
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

function holdsVideo(dir, { readdir }) {
  try {
    return readdir(dir).some((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()));
  } catch {
    return false;
  }
}

function isDirectory(target, { stat }) {
  try {
    return stat(target).isDirectory();
  } catch {
    return false;
  }
}

function subdirectories(dir, deps, p = path) {
  try {
    return deps
      .readdir(dir)
      .map((name) => p.join(dir, name))
      .filter((child) => isDirectory(child, deps));
  } catch {
    return [];
  }
}

// Every place a "Videos" or "Movies" folder could reasonably live. On Windows
// that includes the other drives, because a laptop with a small SSD keeps its
// films on D:.
export function libraryBases({ homedir, stat, platform = process.platform }) {
  const p = flavour(platform);
  const bases = [];
  for (const base of LIBRARY_BASES) bases.push(p.join(homedir, base));

  if (platform === 'win32') {
    // Every drive, not just C: a laptop with a small SSD keeps its films
    // wherever the big disk happens to be lettered.
    for (const letter of WINDOWS_DRIVES) {
      for (const base of LIBRARY_BASES) bases.push(`${letter}:\\${base}`);
    }
  }
  // A stat apiece, and no reading of anything, so scanning the alphabet costs
  // nothing on a machine with two drives.
  return bases.filter((dir) => isDirectory(dir, { stat }));
}

export function discoverMediaRoots({ homedir, readdir, stat, platform }) {
  const deps = { readdir, stat };
  const p = flavour(platform);
  const found = [];
  const add = (dir, rank) => {
    if (!found.some((entry) => entry.dir === dir)) found.push({ dir, rank });
  };

  const bases = libraryBases({ homedir, stat, platform });

  for (const root of bases) {
    // A folder one level down that holds films beats the parent: it is the one
    // somebody made on purpose. "Movies" beats every other name.
    for (const child of subdirectories(root, deps, p)) {
      if (!holdsVideo(child, deps)) continue;
      const name = p.basename(child);
      if (/^movies$/i.test(name)) add(child, RANK.exact);
      else if (NAMED_LIKE_FILMS.test(name)) add(child, RANK.named);
      else add(child, RANK.hasFilms);
    }
    if (holdsVideo(root, deps)) add(root, RANK.base);
  }

  if (found.length) {
    found.sort((a, b) => a.rank - b.rank);
    return found.map((entry) => entry.dir);
  }

  // Nothing with films in it. Offer the obvious empty folder if there is one,
  // but never the app's own directory — and no folder at all is a perfectly
  // good way to run, because screen sharing needs none.
  return bases.length ? [bases[0]] : [];
}
