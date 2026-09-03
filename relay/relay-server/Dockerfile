FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY *.js ./
ENV NODE_ENV=production
CMD ["node", "server.js"]
