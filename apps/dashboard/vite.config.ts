import react from "@vitejs/plugin-react";
import {defineConfig} from "vite";

// ── The two-process dev loop (ADR 0030, mirrors apps/web) ──
// `vite dev` serves the SPA with HMR; `alchemy dev` runs the one worker. Vite
// proxies the worker-owned `/api` paths to it. `@cloudflare/vite-plugin` is NOT
// used — alchemy ships its own Cloudflare integration and is incompatible with
// it (see .patterns/alchemy-worker.md).
//
// `alchemy dev` serves the worker vhost-routed at `http://dashboard.localhost:1337`.
// Node can't resolve `*.localhost`, so the proxy targets the IP and FORCES the
// `Host` header; `changeOrigin: false` keeps that forced `Host` (changeOrigin
// would rewrite it to `127.0.0.1`, which the worker's vhost routing rejects).
const worker = {
	target: "http://127.0.0.1:1337",
	changeOrigin: false,
	headers: {host: "dashboard.localhost"},
};

export default defineConfig({
	plugins: [react()],
	server: {
		port: 3001,
		strictPort: true,
		// Forward the worker-owned paths to `alchemy dev`. A Vite proxy key is a
		// prefix match, so `/api` covers `/api/*`. Everything else (the SPA shell,
		// `/assets/*`) is served by Vite with HMR. At the Cloudflare edge there is no
		// proxy — the worker's `assets` + `runWorkerFirst` precedence serves both.
		proxy: {
			"/api": worker,
		},
	},
	build: {
		// The SPA build lands directly in `dist/client`, which the worker's
		// `assets.directory` points at.
		outDir: "dist/client",
	},
});
