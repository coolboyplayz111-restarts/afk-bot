# Dockerfile - builds node-canvas and runs the app
FROM node:22-bullseye-slim

# Install system dependencies required by node-canvas/prismarine-viewer
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copy package manifest and install deps (production)
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY . .

# Expose the internal port used by the server (server reads process.env.PORT || 3000)
EXPOSE 3000

CMD ["node", "server.js"]
