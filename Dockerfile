# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY . .

# Run the whole test suite on the image's own Linux and Node. A failing test
# stops the build here, so no image is made from a tree whose tests fail.
# The tests use an in-memory database and the temp folder, and this stage is
# discarded: nothing they write reaches the production stage below.
#
# The tests refuse any network access themselves: tests/setup.ts refuses every
# fetch and every DNS lookup a test attempts, and fails the test that attempted
# it. So this step needs no network and no special builder: it is a plain RUN,
# which the classic builder and BuildKit both run.
RUN npm run verify

RUN npm run build

# Prune dev dependencies after build
RUN npm ci --omit=dev


# ── Stage 2: Production ────────────────────────────────────────
FROM node:22-slim AS production

# better-sqlite3 needs these native libs at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the built output and production node_modules
COPY --from=builder /app/build          ./build
COPY --from=builder /app/node_modules   ./node_modules
COPY --from=builder /app/package.json   ./package.json

# Copy migration files — needed at runtime by hooks.server
COPY --from=builder /app/drizzle        ./drizzle

# Create a directory for the SQLite database
# Mount a volume here for data persistence
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
# IMPORTANT: Set ORIGIN to your actual public URL at runtime, e.g.:
#   docker run -e ORIGIN=https://kanban.example.com ...
# Leaving this as localhost will cause CSRF failures in production.
ENV ORIGIN=http://localhost:3000
ENV PROTOCOL_HEADER=X-Forwarded-Proto
ENV HOST_HEADER=X-Forwarded-Host
# The largest request body the server accepts on any route. The node adapter's
# own default is 512K, which refused every attachment and every backup over
# half a megabyte. 512M is enough to import a database backup; the gate
# (src/hooks.server.ts, with src/lib/server/body-limits.ts) narrows it again,
# route by route: 512K everywhere, 26M for an attachment upload, and all of it
# for the import alone.
# Bytes, or a number followed by K, M or G. "512MB" is NOT accepted: it is no
# number to the adapter, and the server refuses to start on it.
ENV BODY_SIZE_LIMIT=512M

EXPOSE 3000

# The SvelteKit node adapter outputs to build/
CMD ["node", "build"]
