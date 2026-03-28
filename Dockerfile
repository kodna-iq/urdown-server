FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache \
    python3 py3-pip ffmpeg curl \
    make g++ sqlite-dev && \
    pip3 install --break-system-packages yt-dlp && \
    ln -sf $(which yt-dlp) /usr/local/bin/yt-dlp

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/
COPY .env.example ./.env.example
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN sed -i 's/\r//' ./docker-entrypoint.sh && chmod +x ./docker-entrypoint.sh

RUN mkdir -p data logs tmp

EXPOSE 3000

ENV NODE_ENV=production
ENV AUTO_UPDATE_INTERVAL_MS=21600000
ENV LOG_LEVEL=info

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["./docker-entrypoint.sh"]
