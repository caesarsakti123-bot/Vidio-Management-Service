FROM node:20-bookworm-slim

# ffmpeg is required for HLS transcoding and recording
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

RUN mkdir -p data recordings public/streams

EXPOSE 4000
CMD ["node", "src/index.js"]
