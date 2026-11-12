# 單一 image：後端伺服器同時提供 API、後台靜態檔與背景任務；也可用 command 分開跑 Worker
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json ./web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/migrations ./migrations
COPY package.json ./
USER app
EXPOSE 4310
CMD ["node", "dist/main-api.js"]
