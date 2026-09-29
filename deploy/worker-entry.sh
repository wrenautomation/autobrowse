#!/bin/sh
# The worker's start. Headed Chrome needs a screen and the box has none: give it
# a virtual one (a desktop-sized display) unless one is already set.
if [ -z "$DISPLAY" ]; then
  rm -f /tmp/.X99-lock # left by a container restart; Xvfb refuses to start over it
  Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 &
  export DISPLAY=:99
fi
exec node_modules/.bin/tsx src/app/main.ts
