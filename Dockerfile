# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14-debian AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.14-debian
LABEL org.opencontainers.image.source="https://github.com/JWilson45/openbot"
ARG TARGETARCH
ARG GROK_VERSION=1.0.13
USER root
RUN apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
    ca-certificates chromium chromium-sandbox curl git tini python3 \
    && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in amd64) grok_arch=x86_64 ;; arm64) grok_arch=aarch64 ;; *) exit 1 ;; esac \
    && curl --fail --location --retry 3 \
      "https://x.ai/cli/grok-${GROK_VERSION}-linux-${grok_arch}" -o /usr/local/bin/grok \
    && chmod 755 /usr/local/bin/grok \
    && grok --version
WORKDIR /app
COPY --from=dependencies /app /app
COPY contrib ./contrib
RUN mkdir -p /data /home/bun/.grok && chown -R bun:bun /data /home/bun
ENV OPENBOT_HOME=/data OPENBOT_CHROME=/usr/bin/chromium HOME=/home/bun
USER bun
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "bun", "run", "apps/server/src/cli.ts"]
CMD ["server", "--host", "127.0.0.1", "--port", "8787"]
