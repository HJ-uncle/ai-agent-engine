FROM node:20-alpine AS build-base
WORKDIR /app
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache python3 make g++ libc6-compat

FROM build-base AS base
COPY package*.json ./
# 修复：解决私有仓库 npm.nie.netease.com 无法访问的问题，将其替换为公共镜像源
# 注意：由于修改了 package-lock.json，npm ci 可能会由于校验失败而跳过某些可选依赖
# 改用 npm install 并根据当前架构动态安装必要的平台原生模块
RUN sed -i 's|https://npm.nie.netease.com|https://registry.npmmirror.com|g' package-lock.json && \
    npm config set registry https://registry.npmmirror.com
RUN --mount=type=cache,target=/root/.npm \
    npm install --only=production --legacy-peer-deps && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
      npm install @libsql/linux-x64-musl --legacy-peer-deps; \
    elif [ "$ARCH" = "aarch64" ]; then \
      npm install @libsql/linux-arm64-musl --legacy-peer-deps; \
    fi

FROM build-base AS builder
COPY package*.json ./
RUN sed -i 's|https://npm.nie.netease.com|https://registry.npmmirror.com|g' package-lock.json && \
    npm config set registry https://registry.npmmirror.com
RUN --mount=type=cache,target=/root/.npm \
    npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM build-base AS frontend-builder
WORKDIR /app
COPY multi-agent-console/package*.json ./
# 修复：解决私有仓库 npm.nie.netease.com 无法访问的问题
RUN if [ -f package-lock.json ]; then sed -i 's|https://npm.nie.netease.com|https://registry.npmmirror.com|g' package-lock.json; fi && \
    npm config set registry https://registry.npmmirror.com
# Vite 构建需要 esbuild，在某些环境下需要显式安装以确保路径正确
RUN --mount=type=cache,target=/root/.npm \
    npm install esbuild --legacy-peer-deps && \
    npm install --legacy-peer-deps
COPY multi-agent-console/ .
RUN NODE_OPTIONS="--max-old-space-size=4096" VITE_API_URL="http://124.221.121.60:12323" npm run build

FROM node:20-alpine AS production
WORKDIR /app
RUN --mount=type=cache,target=/var/cache/apk \
    apk add --no-cache python3 make g++ libc6-compat
COPY --from=base /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json .
COPY --from=builder /app/src ./src
COPY --from=frontend-builder /app/dist ./public
RUN npm install -g tsx
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /app/workspace /app/data
VOLUME ["/app/workspace", "/app/data"]
EXPOSE 12323
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
