import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import react from "@vitejs/plugin-react";
import {Effect} from "effect";
import {defineConfig} from "vite";
import {initialEffortProof} from "../../../claude/proof/initial-effort.ts";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root: here,
	plugins: [
		react(),
		{
			name: "initial-effort-proof",
			configureServer(server) {
				server.middlewares.use("/initial-effort.json", (_request, response) => {
					Effect.runPromise(initialEffortProof()).then(
						(proof) => {
							response.setHeader("Content-Type", "application/json");
							response.setHeader("Cache-Control", "no-store");
							response.end(JSON.stringify(proof));
						},
						(error: unknown) => {
							response.statusCode = 500;
							response.end(String(error));
						},
					);
				});
			},
		},
	],
	// `@kampus/design` and the design tokens are source-consumed out of the workspace, so the dev
	// server has to be allowed to read above this app's root.
	server: {fs: {allow: [resolve(here, "../../../../../..")]}},
});
