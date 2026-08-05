# Base image with Node.js 20 and Python 3.11+ (needed for yt-dlp)
FROM node:20-bookworm-slim

# Skip heavy browser downloads during npm install
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install Python, PIP, FFmpeg, curl, and unzip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install native yt-dlp via pip3 matching container's Python version exactly
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp

# Set working directory
WORKDIR /app

# Copy package files and install Node dependencies
COPY package*.json ./
RUN npm install

# Copy all project files
COPY . .

# Build the React frontend
RUN npm run build

# Expose port 8080 (matches Railway Public Networking domain mapping)
EXPOSE 8080

# Start the Node.js server
CMD ["node", "server.cjs"]
