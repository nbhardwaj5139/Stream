#!/usr/bin/env bash
# Run from anywhere: works out where it lives, updates itself, starts the room.
cd "$(dirname "$0")" || exit 1

# Pull quietly, and never let a failed update stop the evening: being a day
# behind is a far smaller problem than not starting at all.
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Checking for updates..."
  git pull --ff-only --quiet || echo "  Could not update. Carrying on with what is already here."
fi

echo
exec node bin/stream.js "$@"
