FROM node:20-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# --ignore-scripts because `prepare` (needed so `npm i github:...` builds the
# package) would run scripts/build.js here, before the sources are copied in.
# It also defers the native builds, which `npm rebuild` performs below.
RUN npm ci --ignore-scripts

COPY . .
RUN npm rebuild && npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV PORT=32352

WORKDIR /app

RUN useradd --create-home --shell /bin/bash appuser

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin
COPY --from=build /app/LICENSE ./LICENSE
COPY --from=build /app/README.md ./README.md

RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 32352

CMD ["node", "bin/cc-web.js", "--no-open", "--port", "32352"]
