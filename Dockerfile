# myon-fitness-server: the data server the 米亚健身 / Myon Fitness app talks to in 数据存储 › 自己的服务器 (My Server).
#   docker build -t myon-fitness-server .
FROM oven/bun:1.3.9-slim

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY migrations ./migrations

ENV FITNESS_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8720
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
EXPOSE 8720
USER bun
CMD ["bun", "src/selfhost.ts"]
