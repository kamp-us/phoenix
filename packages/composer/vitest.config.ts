/**
 * Vitest config — the round-trip test (T1) instantiates a real tiptap `Editor`,
 * which mounts a ProseMirror view against `document`, so this package runs under
 * `jsdom` (unlike the pure-node packages). No worker/D1 integration tier: the base
 * is a headless editor mechanism with nothing to deploy against.
 */
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		environment: "jsdom",
		include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
	},
});
