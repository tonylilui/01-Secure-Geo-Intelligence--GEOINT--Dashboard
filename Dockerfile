# ════════════════════════════════════════════════════════════
# GEOINT Dashboard — Dockerfile (Multi-stage Build)
# ════════════════════════════════════════════════════════════

# ── Stage 1: Build Client ──────────────────────────────────
FROM node:20-alpine AS client-build

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY client/ ./client/
RUN npm run build

# ── Stage 2: Production Server ─────────────────────────────
FROM node:20-alpine AS production

# Security: run as non-root
RUN addgroup -g 1001 -S geoint && \
    adduser -S geoint -u 1001 -G geoint

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy server code
COPY server/ ./server/

# Copy built client
COPY --from=client-build /app/dist ./dist/

# Security hardening
USER geoint

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3001/healthz || exit 1

CMD ["node", "server/index.js"]
