FROM node:26.2.0-bookworm-slim

RUN npm install --global pnpm@10.27.0

WORKDIR /subject
COPY . .
RUN pnpm install --frozen-lockfile \
	&& pnpm exec playwright install --with-deps chromium \
	&& chown -R node:node /subject
USER node
