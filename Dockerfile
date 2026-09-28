# 构建 Next.js 前端产物。
FROM oven/bun:1.3.14 AS web-build

# 国内构建走 npmmirror：直连 registry.npmjs.org 容易在拉 next 这类大包时中断
# （表现为 `error: Fail extracting tarball for "next"`）。需要走官方源时传
# --build-arg BUN_REGISTRY=https://registry.npmjs.org 覆盖即可。
ARG BUN_REGISTRY=https://registry.npmmirror.com
ENV BUN_CONFIG_REGISTRY=$BUN_REGISTRY

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY web ./
RUN bun run build

# 构建 Go 后端入口。
FROM golang:1.25-alpine AS api-build

# 同理，Go 模块走 goproxy.cn，避免 proxy.golang.org 在国内不可达 / 超时。
ARG GO_PROXY=https://goproxy.cn,direct
ENV GOPROXY=$GO_PROXY

WORKDIR /app
COPY go.mod go.sum ./
COPY config ./config
COPY handler ./handler
COPY middleware ./middleware
COPY model ./model
COPY repository ./repository
COPY router ./router
COPY service ./service
COPY main.go ./
RUN go build -o /server .

# 运行镜像：Next.js 对外监听 3000，Go 只在容器内部监听 8080。
FROM node:22-bookworm-slim

WORKDIR /app
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY --from=api-build /server /app/server
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
COPY --from=web-build /app/web/public /app/web/public
COPY --from=web-build /app/web/.next/standalone /app/web
COPY --from=web-build /app/web/.next/static /app/web/.next/static
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV PROMPT_DATA_DIR=/app/data/prompts
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /app/data/prompts

EXPOSE 3000
# 先启动内部 Go API，再由 Next.js 提供页面并代理 /api/*。
CMD ["/app/docker-entrypoint.sh"]
