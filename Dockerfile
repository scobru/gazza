# gazza needs three things at runtime that are not JavaScript: ffmpeg to write
# and read the video, ffprobe to tell what a carrier came back as, and yt-dlp to
# fetch one from a link. Alpine carries all three.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg yt-dlp

WORKDIR /app

# Manifests first: this layer is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build && npm prune --omit=dev

# The page is served from src, not dist: it is not compiled, only read.
# HOST is also detected at runtime, so this is a default and not the only way
# it reaches the process: some platforms start a container without carrying the
# image's environment through.
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
EXPOSE 4321

# Carriers are written to a temp directory and deleted once collected. Nothing
# is kept, so there is no volume to mount and nothing to back up.
CMD ["node", "packages/web/dist/server.js"]
