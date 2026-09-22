# Build without runtime secrets. Supply only the allowlisted context below.
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY svelte.config.js vite.config.ts tsconfig.json postcss.config.cjs ./
COPY src ./src
COPY static ./static
COPY scripts/start-cloud-run.mjs ./scripts/start-cloud-run.mjs
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS runtime
ENV NODE_ENV=production NTS_HOSTED_STAGING=1 HOST=0.0.0.0
ENV ORIGIN=https://nts2spotify.vincentvanderveken.com
WORKDIR /app
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node scripts/start-cloud-run.mjs ./scripts/start-cloud-run.mjs
COPY --chown=node:node LICENSE ./LICENSE
USER node
EXPOSE 8080
CMD ["node", "scripts/start-cloud-run.mjs"]
