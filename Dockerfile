# Use Node.js LTS version
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install production dependencies first (for better caching)
COPY package*.json ./

# Install dependencies (use install since we don't have package-lock.json)
RUN npm install --omit=dev && \
    npm cache clean --force

# Copy application files
COPY . .

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port (Render will set PORT env var)
EXPOSE 10000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:${PORT:-10000}/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Start the application
CMD ["node", "indexnew.js"]
