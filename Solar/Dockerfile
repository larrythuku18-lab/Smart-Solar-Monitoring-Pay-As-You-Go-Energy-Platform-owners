# SolarPAYG Platform Dockerfile
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Install system dependencies for native modules
RUN apk add --no-cache \
    postgresql-client \
    mosquitto-clients \
    && rm -rf /var/cache/apk/*

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S solarpayg -u 1001

# Change ownership of app directory
RUN chown -R solarpayg:nodejs /app
USER solarpayg

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/api/dashboard', (res) => { process.exit(res.statusCode === 401 ? 0 : 1) })"

# Start the application
CMD ["npm", "start"]