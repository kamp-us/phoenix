// The suites here build real runtimes over in-memory fixtures — no external
// storage. Real-D1 coverage of the fate server lives in `@kampus/web` (ADR 0082).
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
});
