# Base image with Node.js 20 and Python (needed for yt-dlp)
FROM node:20-bullseye-slim

# Skip heavy browser downloads during npm install, use system chromium
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install Python, FFmpeg, curl, unzip, and Chromium for bot bypass cookies
RUN apt-get update && apt-get install -y \
    python3 \
    ffmpeg \
    curl \
    unzip \
    chromium \
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

# Change the yt-dlp path in server.cjs to use the Linux binary we just downloaded
RUN sed -i "s/yt-dlp.exe/yt-dlp/g" server.cjs

# Change the temporary download directory to /tmp/DownMaster
RUN sed -i "s/path.join(os.homedir(), 'Downloads', 'DownMaster')/'\/tmp\/DownMaster'/g" server.cjs

# Expose port 5000
EXPOSE 5000

# Start the Node.js server
CMD ["node", "server.cjs"]
