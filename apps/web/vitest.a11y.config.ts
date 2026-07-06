/**
 * Vitest config for the property-based a11y promotion loop (#2175, ADR 0162
 * pillar 4). A standalone, self-contained jsdom config — deliberately NOT a
 * project inside `vitest.config.ts`: the a11y gate is its own always-on CI rung
 * (`.github/workflows/a11y-pbt.yml`) that must stay fast and never pull in the
 * integration tier's `globalSetup` (a real Cloudflare deploy) or the worker
 * toolchain. It renders the `ui/` primitives through React's JSX runtime in
 * jsdom and runs axe + structural invariants — the same `plugin-react` + jsdom +
 * per-test cleanup the `client` tier uses, scoped to the a11y suite only.
 */
import react from "@vitejs/plugin-react";
import {defineConfig} from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		name: "a11y",
		include: ["src/components/ui/a11y/**/*.test.tsx"],
		environment: "jsdom",
		setupFiles: ["./tests/client/setup.ts"],
		exclude: ["node_modules/**", "dist/**"],
		// A generative suite (fast-check runs N prop combinations per primitive,
		// each a render + async axe pass), so give it headroom over the default.
		testTimeout: 30_000,
	},
});
