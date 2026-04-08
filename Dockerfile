FROM node:20-slim

# Install FFmpeg + fonts for libass subtitle rendering
RUN apt-get update && \
    apt-get install -y \
      ffmpeg \
      fonts-liberation \
      fonts-dejavu-core \
      fonts-open-sans \
      fontconfig && \
    fc-cache -fv && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
