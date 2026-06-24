# ═══════════════════════════════════════════════════════════════════════════════
# Smart Solar Monitoring Pay-As-You-Go Energy Platform
# Multi-stage Docker build
# ═══════════════════════════════════════════════════════════════════════════════

# Stage 1: Builder
FROM node:22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Stage 2: Runtime
FROM node:22-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache \
    postgresql-client \
    dumb-init \
    wget

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy package files
COPY package*.json ./

# Copy application code
COPY . .

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S solarpayg -u 1001 && \
    chown -R solarpayg:nodejs /app

USER solarpayg

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

# Use dumb-init to handle signals properly
ENTRYPOINT ["/sbin/dumb-init", "--"]

# Start the application
CMD ["npm", "start"]