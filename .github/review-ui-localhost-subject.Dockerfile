FROM node:26.2.0-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npm install --global pnpm@10.27.0 playwright@1.62.1 \
	&& playwright install --with-deps chromium \
	&& mkdir /subject /subject-source \
	&& chown node:node /subject /subject-source \
	&& chmod -R a+rX /ms-playwright

WORKDIR /subject-source
COPY --chown=node:node . .
USER node
RUN pnpm fetch --frozen-lockfile --ignore-scripts --ignore-pnpmfile
