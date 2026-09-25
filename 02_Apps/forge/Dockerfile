FROM oven/bun:1.3.14-alpine AS build

WORKDIR /workspace

# Install from the workspace lockfile before copying source for better layer caching.
COPY package.json bun.lock ./
COPY 02_Apps/forge/package.json 02_Apps/forge/package.json
RUN bun install --frozen-lockfile

COPY . .
RUN cd 02_Apps/forge && bun run build

FROM oven/bun:1.3.14-alpine AS runtime

WORKDIR /app/02_Apps/forge
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000

COPY --from=build --chown=bun:bun /workspace/02_Apps/forge/.output ./.output

USER bun
EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
