FROM node:20-alpine AS build-base
WORKDIR /app
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache python3 make g++

FROM build-base AS base
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --only=production --legacy-peer-deps

FROM build-base AS builder
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps
COPY . .
RUN npm run build

FROM build-base AS frontend-builder
WORKDIR /app
COPY multi-agent-console/package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps
COPY multi-agent-console/ .
RUN NODE_OPTIONS="--max-old-space-size=4096" REACT_APP_API_URL="http://124.221.121.60:12323" npm run build

FROM node:20-alpine AS production
WORKDIR /app
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache python3 make g++
COPY --from=base /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json .
COPY --from=builder /app/src ./src
COPY --from=frontend-builder /app/build ./public
RUN npm install -g tsx
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/workspace /app/data
VOLUME ["/app/workspace", "/app/data"]
EXPOSE 12323
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
