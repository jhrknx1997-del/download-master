# Base image with Node.js 20 and Python (needed for yt-dlp)
FROM node:20-bullseye-slim

# Skip heavy browser downloads during npm install
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install Python, FFmpeg, curl, and unzip (Lightweight < 100MB build)
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install Node dependencies
COPY package*.json ./
RUN npm install

# Copy all project files
COPY . .

# Build the React frontend
RUN npm run build

# Download the latest yt-dlp nightly build for Linux
RUN curl -L -o yt-dlp https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp \
    && chmod a+rx yt-dlp

# Expose port 8080 (matches Railway Public Networking domain mapping)
EXPOSE 8080

# Start the Node.js server
CMD ["node", "server.cjs"]
