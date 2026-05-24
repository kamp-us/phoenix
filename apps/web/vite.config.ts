import {cloudflare} from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react-swc";
import {fate} from "react-fate/vite";
import {defineConfig} from "vite";

export default defineConfig({
	plugins: [
		// fate's codegen runs as a Vite plugin (no hand-run codegen, no committed
		// artifact). It reads the server's data views + `fateServer` manifest from
		// `worker/fate/schema.ts` and generates the typed `react-fate/client`
		// module from the exported `Entity<>` types. `transport: "native"` matches
		// phoenix's native fate server on Hono (no tRPC/GraphQL adapter). The
		// generated file lands in `.fate/` (gitignored).
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
		cloudflare(),
	],
	server: {
		port: 3000,
		strictPort: true,
	},
	build: {
		outDir: "dist/client",
	},
});
