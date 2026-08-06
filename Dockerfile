# Base image with Node.js 20 and Python 3.11+ (needed for yt-dlp)
FROM node:20-bookworm-slim

# Skip heavy browser downloads during npm install
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Install Python, PIP, FFmpeg, curl, unzip, and Chromium for stealth cookie generator
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    unzip \
    chromium \
    fonts-liberation \
    libnss3 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install Deno JS runtime for yt-dlp EJS challenge solving
RUN curl -fsSL https://deno.land/x/install/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="$DENO_INSTALL/bin:$PATH"


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

# Pre-generate cookies.txt during image build using headless Chromium
RUN node cookieGenerator.cjs || true


# Expose port 8080 (matches Railway Public Networking domain mapping)
EXPOSE 8080

# Start the Node.js server
CMD ["node", "server.cjs"]
