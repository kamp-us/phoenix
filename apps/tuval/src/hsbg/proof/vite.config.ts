import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import react from "@vitejs/plugin-react";
import {defineConfig} from "vite";

const here = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
	root: here,
	plugins: [react()],
	server: {
		host: "127.0.0.1",
		port: 5179,
		strictPort: true,
		fs: {allow: [resolve(here, "../../../../../..")]},
	},
});
