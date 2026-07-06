/**
 * Vitest config — the unit tier only (ADR 0082's `unit`/`integration` split; the moved
 * `credentials.unit.test.ts` is pure-logic over a FAKE Keychain, no real `security` CLI and
 * no real CF). A later slice adds an `integration` project if a read is only-wrong-if-the-real-CF-differs.
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
