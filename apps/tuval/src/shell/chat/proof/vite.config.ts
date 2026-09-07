import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import react from "@vitejs/plugin-react";
import {Effect} from "effect";
import {defineConfig} from "vite";
import {initialEffortProof} from "../../../claude/proof/initial-effort.ts";
import {pagingReplay} from "../../../claude/proof/paging-replay.ts";

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
		{
			name: "chat-paging-replay",
			configureServer(server) {
				const waiting = new Map<string, () => void>();
				// ui render waits for network-idle; keep this journey's request open until its DOM assertions finish.
				server.middlewares.use("/paging-inspection", (request, response) => {
					const key = request.url ?? "";
					if (request.method === "POST") {
						waiting.get(key)?.();
						response.end();
						return;
					}
					response.writeHead(200, {"Content-Type": "text/plain"});
					response.flushHeaders();
					const timer = setTimeout(() => {
						waiting.delete(key);
						response.end("timed-out");
					}, 10_000);
					waiting.set(key, () => {
						clearTimeout(timer);
						waiting.delete(key);
						response.end("settled");
					});
				});
				server.middlewares.use("/paging-replay", (_request, response) => {
					void Effect.runPromise(pagingReplay()).then(
						(replay) => {
							response.setHeader("Content-Type", "application/json");
							response.end(JSON.stringify(replay));
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
