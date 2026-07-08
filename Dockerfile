FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=6767

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY routes ./routes
COPY public ./public
COPY docs ./docs

RUN mkdir -p data uploads models datasets

EXPOSE 6767

CMD ["node", "server.js"]
