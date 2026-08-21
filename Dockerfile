FROM node:24-bookworm-slim
WORKDIR /app
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
