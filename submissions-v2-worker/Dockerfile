FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY api ./api
COPY resume-renderer-v2 ./resume-renderer-v2
COPY submissions-v2-worker ./submissions-v2-worker
CMD ["node", "submissions-v2-worker/server.mjs"]
