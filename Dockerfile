FROM node:20-slim

# FFmpeg è l'unica dipendenza necessaria
# I font sono bundled direttamente in server.js
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY story_subtitler.html ./

EXPOSE 3000
CMD ["node", "server.js"]
