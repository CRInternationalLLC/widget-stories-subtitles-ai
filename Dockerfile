FROM node:20-slim

# Install FFmpeg + fonts per libass subtitle rendering
RUN apt-get update && apt-get install -y \
    ffmpeg \
    fonts-liberation \
    fonts-liberation2 \
    fonts-dejavu-core \
    fontconfig \
    wget \
    && fc-cache -f -v \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
