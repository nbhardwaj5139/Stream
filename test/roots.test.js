import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  describeProblem,
  discoverMediaRoots,
  expandHome,
  candidateBases,
  resolveRoots,
} from '../src/roots.js';

const HOME = path.resolve('/home/someone');

// A pretend filesystem, so these cases don't depend on what is on disk.
function fakeStat(entries) {
  return (target) => {
    const kind = entries[target];
    if (!kind) {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return { isDirectory: () => kind === 'dir' };
  };
}

test('~ expands and paths are made absolute', () => {
  assert.equal(expandHome('~/Movies', HOME), path.join(HOME, 'Movies'));
  assert.equal(expandHome('~', HOME), HOME);
  // "~notes" is a real relative name, not a home directory.
  assert.equal(expandHome('~notes', HOME), path.resolve('~notes'));
  assert.equal(expandHome('   ', HOME), null);
  assert.equal(expandHome(undefined, HOME), null);
});

test('folders are accepted and files are refused', () => {
  const films = path.resolve('/films');
  const script = path.resolve('/app/bin/stream.js');
  const stat = fakeStat({ [films]: 'dir', [script]: 'file' });

  const { roots, problems } = resolveRoots([films, script], { homedir: HOME, stat });

  assert.deepEqual(roots, [films]);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].reason, 'not-a-folder');
  assert.match(describeProblem(problems[0]), /^Not a folder: /);
});

test('a folder named twice is only served once', () => {
  // A command pasted twice is exactly how this happens.
  const films = path.resolve('/films');
  const stat = fakeStat({ [films]: 'dir' });

  const { roots } = resolveRoots([films, films, './films/../films'], { homedir: HOME, stat });
  assert.deepEqual(roots, [films]);
});

test('a missing folder is reported rather than silently skipped', () => {
  const stat = fakeStat({});
  const { roots, problems } = resolveRoots(['/nope'], { homedir: HOME, stat });
  assert.deepEqual(roots, []);
  assert.equal(problems[0].reason, 'missing');
  assert.match(describeProblem(problems[0]), /^Folder does not exist: /);
});

test('the pasted-command case produces exactly one root and one complaint', () => {
  // What actually happened: two commands ran concatenated, so the script path
  // and the folder both arrived twice.
  const films = path.resolve('/Users/nb/Videos/Movie Night');
  const script = path.resolve('/Users/nb/Stream/bin/stream.js');
  const stat = fakeStat({ [films]: 'dir', [script]: 'file' });

  const { roots, problems } = resolveRoots([films, script, films, script, films], {
    homedir: HOME,
    stat,
  });

  assert.deepEqual(roots, [films]);
  assert.equal(problems.length, 1, 'the same bad argument is not reported five times');
});

// --- Finding the films on a machine that has never been told ------------

// A fake disk: a map of folder -> entries. Anything that is a key is a
// folder; anything listed inside one is a file unless it is also a key.
function fakeDisk(tree, { hang = [] } = {}) {
  const never = new Promise(() => {});
  const readdir = (dir) => {
    if (hang.some((prefix) => dir.startsWith(prefix))) return never;
    if (!(dir in tree) || tree[dir] === null) throw new Error(`ENOENT: ${dir}`);
    return tree[dir];
  };
  const stat = (target) => {
    if (hang.some((prefix) => target.startsWith(prefix))) return never;
    if (target in tree) return { isDirectory: () => true };
    throw new Error(`ENOENT: ${target}`);
  };
  return { readdir, stat };
}

const home = '/home/someone';
const join = (...parts) => parts.join('/');
const discover = (disk, extra = {}) =>
  discoverMediaRoots({ homedir: home, platform: 'linux', timeoutMs: 50, ...disk, ...extra });

test('a folder made for films beats the folder it sits in', async () => {
  const disk = fakeDisk({
    [join(home, 'Videos')]: ['Movie Night', 'Clips', 'holiday.mp4'],
    [join(home, 'Videos', 'Movie Night')]: ['Heat.mkv', 'Arrival.mp4'],
    [join(home, 'Videos', 'Clips')]: ['gameplay.mp4'],
  });

  const found = await discover(disk);
  // Named like films, so it goes first; the others are still offered.
  assert.equal(found[0], join(home, 'Videos', 'Movie Night'));
  assert.ok(found.includes(join(home, 'Videos', 'Clips')));
  assert.ok(found.includes(join(home, 'Videos')), 'the parent has a film in it too');
});

test('a folder called Movies beats one merely named like films', async () => {
  const disk = fakeDisk({
    [join(home, 'Videos')]: ['Movie Night', 'Movies'],
    [join(home, 'Videos', 'Movie Night')]: ['Heat.mkv'],
    [join(home, 'Videos', 'Movies')]: ['Arrival.mp4'],
  });
  const found = await discover(disk);
  assert.equal(found[0], join(home, 'Videos', 'Movies'));
  assert.equal(found[1], join(home, 'Videos', 'Movie Night'));
});

test('a folder with no films in it is not offered', async () => {
  const disk = fakeDisk({
    [join(home, 'Videos')]: ['Movie Night', 'Notes'],
    [join(home, 'Videos', 'Movie Night')]: ['Heat.mkv'],
    [join(home, 'Videos', 'Notes')]: ['todo.txt', 'budget.xlsx'],
  });
  assert.deepEqual(await discover(disk), [join(home, 'Videos', 'Movie Night')]);
});

test('Downloads is never offered, however many films are in it', async () => {
  // Sharing whatever happens to be in Downloads is one careless evening away
  // from sharing something nobody meant to.
  const disk = fakeDisk({
    [join(home, 'Downloads')]: ['film.mkv', 'payslip.pdf'],
    [join(home, 'Videos')]: ['Heat.mkv'],
  });
  const found = await discover(disk);
  assert.deepEqual(found, [join(home, 'Videos')]);
});

test('an empty Videos folder is still the best guess', async () => {
  const disk = fakeDisk({ [join(home, 'Videos')]: [] });
  assert.deepEqual(await discover(disk), [join(home, 'Videos')]);
});

test('a machine with nothing to go on offers no folder at all', async () => {
  // Not an error: screen sharing needs no folder, and serving the app's own
  // directory — the old fallback — was never what anyone wanted.
  assert.deepEqual(await discover(fakeDisk({})), []);
});

test('an unreadable folder is skipped rather than fatal', async () => {
  const disk = fakeDisk({
    [join(home, 'Videos')]: ['Locked', 'Movie Night'],
    [join(home, 'Videos', 'Movie Night')]: ['Heat.mkv'],
    [join(home, 'Videos', 'Locked')]: null, // a folder, but reading it throws
  });
  assert.deepEqual(await discover(disk), [join(home, 'Videos', 'Movie Night')]);
});

// Windows cases, from anywhere: drive letters and backslashes throughout.
const winHome = 'C:\\Users\\someone';
const winDiscover = (disk, extra = {}) =>
  discoverMediaRoots({ homedir: winHome, platform: 'win32', timeoutMs: 50, ...disk, ...extra });

test('a second drive is looked at when home has nothing', async () => {
  // A laptop with a small SSD keeps its films on D:.
  const disk = fakeDisk({
    [`${winHome}\\Videos`]: ['clips'],
    [`${winHome}\\Videos\\clips`]: ['notes.txt'],
    'D:\\Videos': ['Movies'],
    'D:\\Videos\\Movies': ['Heat.mkv', 'Arrival.mp4'],
  });
  assert.equal((await winDiscover(disk))[0], 'D:\\Videos\\Movies');
});

test('films at home mean the other drives are never touched', async () => {
  // The whole point: a work laptop's network drives are not even asked.
  const touched = [];
  const disk = fakeDisk({
    [`${winHome}\\Videos`]: ['Movies'],
    [`${winHome}\\Videos\\Movies`]: ['Heat.mkv'],
  });
  const spy = {
    readdir: disk.readdir,
    stat: (target) => {
      touched.push(target);
      return disk.stat(target);
    },
  };

  assert.deepEqual(await winDiscover(spy), [`${winHome}\\Videos\\Movies`]);
  assert.equal(touched.some((target) => /^[C-Z]:\\(Videos|Movies)/.test(target)), false,
    `drives were probed: ${touched.join(', ')}`);
});

test('a network drive that never answers cannot hold up the start', async () => {
  // H: to K: are mapped shares out of reach, as on a work laptop away from the
  // office. Windows would hang on each for half a minute; we give up fast, and
  // after a couple of those stop asking drives at all.
  const touched = [];
  const disk = fakeDisk({}, { hang: ['H:', 'I:', 'J:', 'K:'] });
  const spy = {
    readdir: disk.readdir,
    stat: (target) => {
      touched.push(target);
      return disk.stat(target);
    },
  };

  const started = Date.now();
  const found = await winDiscover(spy, { timeoutMs: 40, maxStalls: 2 });
  const took = Date.now() - started;

  assert.deepEqual(found, [], 'nothing reachable, so screen sharing only — and it still starts');
  assert.ok(took < 1000, `took ${took}ms`);
  // Two stalls on H:, then it stopped: I: and beyond were never asked.
  assert.equal(touched.filter((target) => target.startsWith('H:')).length, 2);
  assert.equal(touched.some((target) => /^[I-Z]:/.test(target)), false);
});

test('the first drive with films ends the search', async () => {
  // No reason to go on towards the network drives once films are found.
  const touched = [];
  const disk = fakeDisk({ 'D:\\Videos': ['Movies'], 'D:\\Videos\\Movies': ['Heat.mkv'] }, { hang: ['H:'] });
  const spy = {
    readdir: disk.readdir,
    stat: (target) => {
      touched.push(target);
      return disk.stat(target);
    },
  };

  assert.deepEqual(await winDiscover(spy), ['D:\\Videos\\Movies']);
  assert.equal(touched.some((target) => /^[E-Z]:/.test(target)), false);
});

test('where to look is decided without touching the disk', () => {
  const win = candidateBases({ homedir: winHome, platform: 'win32' });
  assert.deepEqual(win.home, [`${winHome}\\Videos`, `${winHome}\\Movies`]);
  assert.equal(win.drives.length, 24 * 2, 'C: to Z:, two names each');
  assert.equal(win.drives[0], 'C:\\Videos');

  // No drive letters anywhere else.
  const mac = candidateBases({ homedir: '/Users/someone', platform: 'darwin' });
  assert.deepEqual(mac.home, ['/Users/someone/Videos', '/Users/someone/Movies']);
  assert.deepEqual(mac.drives, []);
});
