// The parts of setting a Windows laptop up that are decisions rather than
// actions, kept apart so they can be tested anywhere.
import path from 'node:path';

// cloudflared's rule for tunnel names, applied to this computer's name. Each
// laptop gets its own tunnel, so two laptops never fight over one.
export function tunnelNameFor(computerName) {
  const cleaned = `stream-${String(computerName ?? '')}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32)
    .replace(/-+$/, '');
  return cleaned || 'stream';
}

// %USERPROFILE%\Desktop and the like, as the registry stores them.
export function expandWindowsEnv(value, env) {
  return String(value).replace(/%([^%]+)%/g, (whole, name) => {
    // Windows environment names are case-insensitive.
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return key ? env[key] : whole;
  });
}

// One value out of `reg query`, which prints something like:
//     Desktop    REG_EXPAND_SZ    %USERPROFILE%\OneDrive\Desktop
export function parseRegValue(output, name) {
  const line = String(output ?? '')
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().toLowerCase().startsWith(`${name.toLowerCase()} `));
  if (!line) return null;
  const match = /\s+REG_(?:EXPAND_)?SZ\s+(.+)$/.exec(line);
  return match ? match[1].trim() : null;
}

// Where Desktop and Startup really are. Not always under the profile folder:
// OneDrive moves the desktop, and so do some company setups — and a button
// written to a desktop nobody looks at is no button at all.
export function shellFolder(name, { queryRegistry, env }) {
  const fallbacks = {
    Desktop: path.win32.join(env.USERPROFILE ?? '', 'Desktop'),
    Startup: path.win32.join(env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
  };
  try {
    const raw = parseRegValue(
      queryRegistry('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', name),
      name
    );
    if (raw) return expandWindowsEnv(raw, env);
  } catch {
    /* fall back to the usual place */
  }
  return fallbacks[name];
}

// The Start Stream button. A small .cmd rather than a shortcut, because making
// a shortcut takes PowerShell or a COM object, and those are exactly what
// security software is apt to block. Double-clicking this works the same.
export function launcherScript(startCmd, { minimised = false } = {}) {
  const lines = ['@echo off', 'REM Starts the screen-sharing room. Made by the installer; safe to delete.'];
  if (minimised) {
    // At login it should sit on the taskbar, not in the way. `start /min`
    // opens start.cmd in its own minimised window, and this one closes. The
    // doubled quotes are deliberate: `cmd /c` strips one pair from around its
    // command, by rules that depend on what the path contains, and a path
    // with a space or a bracket in it would otherwise come out mangled.
    lines.push(`start "Stream" /min cmd /c ""${startCmd}""`);
  } else {
    lines.push(`call "${startCmd}"`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

// The first hostname cloudflared is configured to serve, as a default answer
// when the installer is run again.
export function defaultHostname(configuredHostnames) {
  return configuredHostnames.find(Boolean) ?? null;
}

// People paste whole links. Take the address out of whatever they typed.
export function cleanHostname(typed) {
  return String(typed ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
}
