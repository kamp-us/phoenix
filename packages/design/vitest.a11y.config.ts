import react from "@vitejs/plugin-react";
import {defineConfig} from "vitest/config";

export default defineConfig({
	plugins: [react()],
	test: {
		name: "design-a11y",
		include: ["src/a11y/**/*.test.tsx"],
		environment: "jsdom",
		setupFiles: ["./test-setup.ts"],
		exclude: ["node_modules/**", "dist/**"],
		// Match the web client tier's jsdom storage posture (#7728).
		execArgv: ["--no-experimental-webstorage"],
		// fast-check renders every primitive repeatedly, and each case also runs axe.
		testTimeout: 30_000,
	},
});
