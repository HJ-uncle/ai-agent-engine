FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS frontend-builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY multi-agent-console/package*.json ./
RUN npm ci
COPY multi-agent-console/ .
RUN REACT_APP_API_URL="" npm run build

FROM node:20-alpine AS production
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY --from=base /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json .
COPY --from=builder /app/src ./src
COPY --from=frontend-builder /app/build ./public
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/workspace /app/data
VOLUME ["/app/workspace", "/app/data"]
EXPOSE 12323
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
