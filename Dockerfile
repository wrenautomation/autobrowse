# Worker image: Restate endpoint (:9081) + UI/API (:9080) + a headed Google
# Chrome on a virtual screen for local-tier flows. Playwright's image pins the browser to the SDK version.
# Secrets never enter the image: they come from the environment at run time.
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json biome.json ./
COPY src ./src
COPY ui ./ui
RUN pnpm typecheck && pnpm ui:build && pnpm prune --prod

FROM base
# Google Chrome, not the bundled Chromium: its codecs, plugins and version string are what
# sites expect from a person. amd64 only (Google ships no arm64 Linux build); elsewhere the
# launch falls back to Chromium. Xvfb (already in the image) gives headed Chrome a screen.
RUN if [ "$(dpkg --print-architecture)" = amd64 ]; then \
      apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
      && curl -fsSLo /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
      && apt-get install -y --no-install-recommends /tmp/chrome.deb fonts-noto-color-emoji \
      && rm -rf /tmp/chrome.deb /var/lib/apt/lists/*; \
    fi
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/ui/dist ./ui/dist
COPY deploy/worker-entry.sh ./deploy/
# Profiles, artifacts, recordings, locator fixes, learned screens and daily caps live on a volume; the image is stateless.
ENV PROFILES_DIR=/data/profiles ARTIFACTS_DIR=/data/artifacts RECORDINGS_DIR=/data/recordings FIXES_FILE=/data/fixes.json SCREENS_FILE=/data/screens.json CAPS_FILE=/data/caps.json
VOLUME ["/data"]
EXPOSE 9080 9081
USER pwuser
CMD ["sh", "deploy/worker-entry.sh"]
