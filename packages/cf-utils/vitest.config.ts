/**
 * Vitest config — the unit tier only (ADR 0082's `unit`/`integration` split; this slice
 * ships the pure-logic + stubbed-transport `*.unit.test.ts` tier, no real CF). A later slice
 * adds an `integration` project when a read is only-wrong-if-the-real-CF-differs.
 */
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "unit",
					include: ["src/**/*.unit.test.ts"],
				},
			},
		],
	},
});
