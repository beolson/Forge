FROM oven/bun:1.3.14-alpine
WORKDIR /workspace
COPY package.json bun.lock ./
COPY 02_Apps/forge.app/package.json 02_Apps/forge.app/package.json
COPY 02_Apps/forge.orchistrator/package.json 02_Apps/forge.orchistrator/package.json
COPY 03_Libraries/project/package.json 03_Libraries/project/package.json
COPY 03_Libraries/automation/package.json 03_Libraries/automation/package.json
COPY 02_Apps/forge.provisioner/package.json 02_Apps/forge.provisioner/package.json
RUN bun install --frozen-lockfile
COPY 02_Apps/forge.orchistrator 02_Apps/forge.orchistrator
COPY 03_Libraries/project 03_Libraries/project
COPY 03_Libraries/automation 03_Libraries/automation
WORKDIR /workspace/02_Apps/forge.orchistrator
CMD ["bun", "src/main.ts"]
