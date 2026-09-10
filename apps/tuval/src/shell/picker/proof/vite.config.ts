import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import react from "@vitejs/plugin-react";
import {defineConfig} from "vite";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * How long `/announce-pause` stays open. `ui render` captures at network-idle, and the match count
 * is deliberately held back 1000 ms (`../../ui/PickerView.tsx`), so without a request outliving that
 * pause the gate captures the two status regions still empty — which is the one thing on this page
 * the pause exists to produce. Same technique as the chat proof's `/paging-inspection`.
 */
const ANNOUNCE_SETTLE_MS = 1_600;

export default defineConfig({
	root: here,
	plugins: [
		react(),
		{
			name: "picker-announce-pause",
			configureServer(server) {
				server.middlewares.use("/announce-pause", (_request, response) => {
					setTimeout(() => {
						response.setHeader("Content-Type", "text/plain");
						response.setHeader("Cache-Control", "no-store");
						response.end("settled");
					}, ANNOUNCE_SETTLE_MS);
				});
			},
		},
	],
	// `@kampus/design` and the design tokens are source-consumed out of the workspace, so the dev
	// server has to be allowed to read above this app's root.
	server: {fs: {allow: [resolve(here, "../../../../../..")]}},
});
