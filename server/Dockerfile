FROM node:18-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm install
COPY server/index.js ./
COPY server/spotify.html ./
COPY dashboard/ ./dashboard/
COPY overlay/ ./overlay/
EXPOSE 3000
CMD ["node", "index.js"]
