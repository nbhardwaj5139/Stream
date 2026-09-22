// Turning whatever was typed on the command line into a list of folders to
// serve. Kept apart from the CLI so the awkward cases can be tested.
import path from 'node:path';

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
