# Node 24.16+ is required for the built-in node:sqlite serialization APIs this
# app runs on. The python3/make/g++ layer that used to be here is gone with
# the last compiled dependency — nothing in the tree builds native code now.
FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
# --ignore-scripts because `prepare` (needed so `npm i github:...` builds the
# package) would run scripts/build.js here, before the sources are copied in.
RUN npm ci --ignore-scripts

COPY . .

# .dockerignore excludes .git, so the build cannot read the commit itself.
# Without these the image reports "commit unknown" and cannot check for
# updates; pass them from CI (see .github/workflows/release-on-main.yml).
ARG BUILD_SHA=""
ARG BUILD_DATE=""
ENV CODE_AGENTS_WEBCLI_BUILD_SHA=$BUILD_SHA
ENV CODE_AGENTS_WEBCLI_BUILD_DATE=$BUILD_DATE

RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim

ENV NODE_ENV=production
ENV PORT=32352
# Deliberately not carried into the runtime image: the commit is already baked
# into dist/build-info.json, and an inherited value here would be picked up by
# any nested build and misreport it.

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
