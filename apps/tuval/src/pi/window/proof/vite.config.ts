import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import react from "@vitejs/plugin-react";
import {defineConfig} from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: here,
	plugins: [react()],
	// `@kampus/design` and the design tokens are source-consumed out of the workspace, so the dev
	// server has to be allowed to read above this app's root.
	server: {fs: {allow: [resolve(here, "../../../../../..")]}},
});
