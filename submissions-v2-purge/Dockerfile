FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY api/submissions-v2/_lib/db.mjs ./api/submissions-v2/_lib/db.mjs
COPY submissions-v2-purge ./submissions-v2-purge
USER node
CMD ["node", "submissions-v2-purge/server.mjs"]
