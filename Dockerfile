# Render no trae ffmpeg en su entorno Node nativo, por eso se despliega con Docker.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --chown=node:node . .

ENV NODE_ENV=production
USER node
EXPOSE 10000
CMD ["node", "server.js"]
