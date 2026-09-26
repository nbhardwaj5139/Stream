import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { describeProblem, expandHome, resolveRoots } from '../src/roots.js';

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
