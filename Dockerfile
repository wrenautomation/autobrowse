# Worker image: Restate endpoint (:9081) + UI/API (:9080) + a Chromium for
# local-tier flows. Playwright's image pins the browser to the SDK version.
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
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/src ./src
COPY --from=build /app/ui/dist ./ui/dist
# Profiles, artifacts, recordings and locator fixes live on a volume; the image is stateless.
ENV PROFILES_DIR=/data/profiles ARTIFACTS_DIR=/data/artifacts RECORDINGS_DIR=/data/recordings FIXES_FILE=/data/fixes.json
VOLUME ["/data"]
EXPOSE 9080 9081
USER pwuser
CMD ["node_modules/.bin/tsx", "src/app/main.ts"]
