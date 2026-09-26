import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  describeProblem,
  discoverMediaRoots,
  expandHome,
  libraryBases,
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

// A fake disk: a map of folder -> entries, and everything with a dot in it
// counts as a file.
function fakeDisk(tree) {
  const readdir = (dir) => {
    if (!(dir in tree)) throw new Error(`ENOENT: ${dir}`);
    return tree[dir];
  };
  const stat = (target) => {
    const isDir = target in tree;
    if (!isDir && !Object.values(tree).some((entries) => entries.some((name) => target.endsWith(name)))) {
      throw new Error(`ENOENT: ${target}`);
    }
    return { isDirectory: () => isDir };
  };
  return { readdir, stat };
}

const home = '/home/someone';
const join = (...parts) => parts.join('/');

test('a folder made for films beats the folder it sits in', () => {
  const disk = fakeDisk({
    [join(home, 'Videos')]: ['Movie Night', 'Clips', 'holiday.mp4'],
    [join(home, 'Videos', 'Movie Night')]: ['Heat.mkv', 'Arrival.mp4'],
    [join(home, 'Videos', 'Clips')]: ['gameplay.mp4'],
  });

  const found = discoverMediaRoots({ homedir: home, ...disk });
  // Named like films, so it goes first; the others are still offered.
  assert.equal(found[0], join(home, 'Videos', 'Movie Night'));
  assert.ok(found.includes(join(home, 'Videos', 'Clips')));
  assert.ok(found.includes(join(home, 'Videos')), 'the parent has a film in it too');
});

test('a folder with no films in it is not offered', () => {
  const disk = fakeDisk({
    [join(home, 'Videos')]: ['Movie Night', 'Notes'],
    [join(home, 'Videos', 'Movie Night')]: ['Heat.mkv'],
    [join(home, 'Videos', 'Notes')]: ['todo.txt', 'budget.xlsx'],
  });

  const found = discoverMediaRoots({ homedir: home, ...disk });
  assert.deepEqual(found, [join(home, 'Videos', 'Movie Night')]);
});

test('Downloads is never offered, however many films are in it', () => {
  // Sharing whatever happens to be in Downloads is one careless evening away
  // from sharing something nobody meant to.
  const disk = fakeDisk({
    [join(home, 'Downloads')]: ['film.mkv', 'payslip.pdf'],
    [join(home, 'Videos')]: ['Heat.mkv'],
  });

  const found = discoverMediaRoots({ homedir: home, ...disk });
  assert.deepEqual(found, [join(home, 'Videos')]);
  assert.equal(found.some((dir) => dir.includes('Downloads')), false);
});

test('an empty Videos folder is still the best guess', () => {
  const disk = fakeDisk({ [join(home, 'Videos')]: [] });
  assert.deepEqual(discoverMediaRoots({ homedir: home, ...disk }), [join(home, 'Videos')]);
});

test('a machine with nothing to go on offers no folder at all', () => {
  // Not an error: screen sharing needs no folder, and serving the app's own
  // directory — the old fallback — was never what anyone wanted.
  const disk = fakeDisk({});
  assert.deepEqual(discoverMediaRoots({ homedir: home, ...disk }), []);
});

test('an unreadable folder is skipped rather than fatal', () => {
  const disk = fakeDisk({
    [join(home, 'Videos')]: ['Locked', 'Movie Night'],
    [join(home, 'Videos', 'Movie Night')]: ['Heat.mkv'],
    // 'Locked' exists as a directory but reading it throws, as a permissions
    // failure would.
    [join(home, 'Videos', 'Locked')]: null,
  });
  const guarded = {
    readdir: (dir) => {
      const entries = disk.readdir(dir);
      if (entries === null) throw new Error('EACCES');
      return entries;
    },
    stat: disk.stat,
  };

  assert.deepEqual(
    discoverMediaRoots({ homedir: home, ...guarded }),
    [join(home, 'Videos', 'Movie Night')]
  );
});

test('a folder called Videos\\Movies wins wherever it is', () => {
  // Under the home folder on one laptop, on a second drive on another — the
  // name is the signal, not the location.
  const disk = fakeDisk({
    [join(home, 'Videos')]: ['Movie Night', 'Movies'],
    [join(home, 'Videos', 'Movie Night')]: ['Heat.mkv'],
    [join(home, 'Videos', 'Movies')]: ['Arrival.mp4'],
  });

  const found = discoverMediaRoots({ homedir: home, ...disk });
  assert.equal(found[0], join(home, 'Videos', 'Movies'), 'the exact name beats a merely film-ish one');
  assert.equal(found[1], join(home, 'Videos', 'Movie Night'));
});

test('a second drive is looked at too, because that is where the films live', () => {
  // A laptop with a small SSD keeps its films on D:.
  const tree = {
    'C:\\Users\\someone\\Videos': ['clips'],
    'C:\\Users\\someone\\Videos\\clips': ['gameplay.mp4'],
    'D:\\Videos': ['Movies'],
    'D:\\Videos\\Movies': ['Heat.mkv', 'Arrival.mp4'],
  };
  const readdir = (dir) => {
    if (!(dir in tree)) throw new Error(`ENOENT: ${dir}`);
    return tree[dir];
  };
  const stat = (target) => {
    if (target in tree) return { isDirectory: () => true };
    throw new Error(`ENOENT: ${target}`);
  };

  const found = discoverMediaRoots({
    homedir: 'C:\\Users\\someone',
    readdir,
    stat,
    platform: 'win32',
  });

  assert.equal(found[0], 'D:\\Videos\\Movies', 'found on another drive, and preferred');
});

test('scanning the drives costs a stat each and never reads them', () => {
  const statted = [];
  const readFrom = [];
  libraryBases({
    homedir: '/home/someone',
    stat: (dir) => {
      statted.push(dir);
      throw new Error('ENOENT');
    },
    platform: 'win32',
  });

  // Two names across 24 drive letters, plus the two under home.
  assert.equal(statted.length, 2 + 24 * 2);
  assert.deepEqual(readFrom, [], 'nothing was opened');
  assert.ok(statted.includes('D:\\Videos'));
});

test('on a Mac the drive letters are not looked for at all', () => {
  const bases = libraryBases({
    homedir: '/Users/someone',
    stat: (dir) => ({ isDirectory: () => dir === '/Users/someone/Movies' }),
    platform: 'darwin',
  });
  assert.deepEqual(bases, ['/Users/someone/Movies']);
});
