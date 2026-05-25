import react from "@vitejs/plugin-react-swc";
import {fate} from "react-fate/vite";
import {defineConfig} from "vite";

// ── The two-process dev loop (ADR 0030) ──
// `@cloudflare/vite-plugin` is gone: it only drives alchemy's *other* worker
// path (`Cloudflare.Vite`, a plain `export default {fetch}`), which can't host
// phoenix's Effect-native `Cloudflare.Worker` (`bind()` + the Effect DO model).
// So `vite dev` serves the SPA with HMR + the `fate()` codegen plugin, and
// `alchemy dev` runs the one worker; Vite proxies the API to it.
//
// `alchemy dev` serves the worker *vhost-routed* at
// `http://phoenix.localhost:1337`. Node can't resolve `*.localhost`, so the
// proxy must target the IP and FORCE the `Host` header — a
// `target: "http://phoenix.localhost:1337"` fails with `ENOTFOUND`.
// `changeOrigin: false` keeps our forced `Host` (changeOrigin would rewrite it
// to the target's `127.0.0.1:1337`, which the worker's vhost routing rejects).
const worker = {
	target: "http://127.0.0.1:1337",
	changeOrigin: false,
	headers: {host: "phoenix.localhost"},
};

export default defineConfig({
	plugins: [
		// fate's codegen runs as a Vite plugin (no hand-run codegen, no committed
		// artifact). It reads the server's data views + `fateServer` manifest from
		// `worker/fate/schema.ts` and generates the typed `react-fate/client`
		// module from the exported `Entity<>` types. `transport: "native"` matches
		// phoenix's native fate server (no tRPC/GraphQL adapter). The generated
		// file lands in `.fate/` (gitignored). The codegen plugin is orthogonal to
		// the Cloudflare deploy path — it reads the `Entity<>` types regardless —
		// so it stays after the cloudflare plugin is dropped.
		//
		// The plugin imports the server schema graph in a plain Node runner; the
		// one workerd-only specifier in that graph (`cloudflare:workers`, in the
		// pasaport auth wiring) is a lazy dynamic import there, so it never
		// resolves during codegen — no alias/stub needed.
		fate({
			module: "./worker/fate/schema.ts",
			transport: "native",
			// We don't extend the plugin's generated `.fate/tsconfig.json`; the app
			// project includes the generated file directly (see tsconfig.app.json).
			tsconfigFile: false,
		}),
		react(),
	],
	server: {
		port: 3000,
		strictPort: true,
		// Forward the worker-owned paths to `alchemy dev`. A Vite proxy key is a
		// prefix match, so `/fate` covers `/fate`, `/fate/live` (SSE — streams
		// through fine), and `/fate/*`; `/api` covers `/api/*`. Everything else
		// (the SPA shell, `/assets/*`) is served by Vite with HMR. At the
		// Cloudflare edge there is no proxy — the worker's `assets` +
		// `runWorkerFirst` precedence serves both (preserved in `worker/index.ts`).
		proxy: {
			"/api": worker,
			"/fate": worker,
		},
	},
	build: {
		// With `@cloudflare/vite-plugin` gone the SPA build is no longer nested
		// under `dist/client/client` — it lands directly in `dist/client`, which
		// the worker's `assets.directory` points at.
		outDir: "dist/client",
	},
});
