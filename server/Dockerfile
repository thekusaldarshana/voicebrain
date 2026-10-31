FROM node:24-slim

# git versions the vault; ca-certificates lets the server call your transcription and language-model providers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

# Node 24 runs TypeScript directly, so there is no build step.
ENV NODE_ENV=production DATA_DIR=/data PORT=8787 HOST=0.0.0.0 HOME=/tmp NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.ts"]
