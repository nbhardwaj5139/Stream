import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanHostname,
  defaultHostname,
  expandWindowsEnv,
  launcherScript,
  parseRegValue,
  shellFolder,
  tunnelNameFor,
} from '../src/setup.js';

test('each laptop gets a tunnel name of its own that cloudflared accepts', () => {
  assert.equal(tunnelNameFor('DESKTOP-7QH2K9L'), 'stream-desktop-7qh2k9l');
  assert.equal(tunnelNameFor('Living Room PC!'), 'stream-living-room-pc');
  const long = tunnelNameFor('A-VERY-LONG-COMPUTER-NAME-INDEED-12345');
  assert.ok(long.length <= 32, long);
  assert.doesNotMatch(long, /-$/, 'never ends in a dash');
  // Nothing to go on still gives a usable name.
  assert.equal(tunnelNameFor(''), 'stream');
  assert.equal(tunnelNameFor(undefined), 'stream');
});

test('registry paths are expanded the way Windows expands them', () => {
  const env = { USERPROFILE: 'C:\\Users\\sam', OneDrive: 'C:\\Users\\sam\\OneDrive' };
  assert.equal(expandWindowsEnv('%USERPROFILE%\\Desktop', env), 'C:\\Users\\sam\\Desktop');
  // Names are case-insensitive on Windows.
  assert.equal(expandWindowsEnv('%userprofile%\\Desktop', env), 'C:\\Users\\sam\\Desktop');
  assert.equal(expandWindowsEnv('%ONEDRIVE%\\Desktop', env), 'C:\\Users\\sam\\OneDrive\\Desktop');
  // Unknown ones are left alone rather than blanked.
  assert.equal(expandWindowsEnv('%NOPE%\\x', env), '%NOPE%\\x');
});

test('one value is read out of reg query output', () => {
  const output = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
    '    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Desktop',
    '    Startup    REG_EXPAND_SZ    %APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
    '',
  ].join('\r\n');
  assert.equal(parseRegValue(output, 'Desktop'), '%USERPROFILE%\\OneDrive\\Desktop');
  assert.equal(parseRegValue(output, 'Startup'), '%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
  assert.equal(parseRegValue(output, 'Music'), null);
  assert.equal(parseRegValue('', 'Desktop'), null);
});

test('the button goes on the desktop people actually see, OneDrive or not', () => {
  const env = { USERPROFILE: 'C:\\Users\\sam', APPDATA: 'C:\\Users\\sam\\AppData\\Roaming' };
  const moved = {
    env,
    queryRegistry: () => '    Desktop    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Desktop\r\n',
  };
  assert.equal(shellFolder('Desktop', moved), 'C:\\Users\\sam\\OneDrive\\Desktop');

  // No registry answer — a locked-down machine, say — means the usual place.
  const refused = { env, queryRegistry: () => { throw new Error('Access is denied.'); } };
  assert.equal(shellFolder('Desktop', refused), 'C:\\Users\\sam\\Desktop');
  assert.equal(
    shellFolder('Startup', refused),
    'C:\\Users\\sam\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup'
  );
});

test('the desktop button runs start.cmd, and the login one does so minimised', () => {
  const startCmd = 'C:\\Users\\sam\\Stream\\start.cmd';

  const desktop = launcherScript(startCmd);
  assert.match(desktop, /^@echo off\r\n/);
  assert.match(desktop, /call "C:\\Users\\sam\\Stream\\start\.cmd"/);
  assert.ok(desktop.endsWith('\r\n'), 'Windows line endings, since cmd.exe reads it');
  assert.doesNotMatch(desktop, /(?<!\r)\n/, 'no bare newlines');

  const login = launcherScript(startCmd, { minimised: true });
  // start's first quoted argument is the window title, so it must be there,
  // or the path would be taken as the title and nothing would run.
  assert.match(login, /start "Stream" \/min cmd \/c ""C:\\Users\\sam\\Stream\\start\.cmd""/);

  // A profile folder with a space in it — "C:\Users\Sam Smith" — still arrives
  // as one path, because cmd /c only ever strips the outer pair.
  const spaced = launcherScript('C:\\Users\\Sam Smith\\Stream\\start.cmd', { minimised: true });
  assert.match(spaced, /cmd \/c ""C:\\Users\\Sam Smith\\Stream\\start\.cmd""/);
});

test('a pasted link is reduced to its address', () => {
  assert.equal(cleanHostname('  https://Stream.Example.com/  '), 'stream.example.com');
  assert.equal(cleanHostname('http://stream.example.com/some/page'), 'stream.example.com');
  assert.equal(cleanHostname('stream.example.com'), 'stream.example.com');
  assert.equal(cleanHostname(undefined), '');
});

test('running it again suggests the address already set up', () => {
  assert.equal(defaultHostname(['stream.example.com', 'other.example.com']), 'stream.example.com');
  assert.equal(defaultHostname([]), null);
});
