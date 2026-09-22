#!/usr/bin/env bash
# Run from anywhere: works out where it lives first.
cd "$(dirname "$0")" || exit 1
exec node bin/stream.js "$@"
