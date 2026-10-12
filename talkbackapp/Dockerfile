FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

ENV PORT=3000
EXPOSE 3000

USER node
CMD ["node", "server.js"]
