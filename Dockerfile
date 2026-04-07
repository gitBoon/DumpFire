# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .
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
ENV ORIGIN=http://localhost:3000
ENV PROTOCOL_HEADER=X-Forwarded-Proto
ENV HOST_HEADER=X-Forwarded-Host

EXPOSE 3000

# The SvelteKit node adapter outputs to build/
CMD ["node", "build"]
