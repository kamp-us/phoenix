/**
 * Vitest config — mirrors apps/web's taxonomy (ADR 0040,
 * `.patterns/effect-testing.md`). The scaffold ships only the `unit` project
 * (T0–T2: everything reachable in-process by `Effect.provide`, offline in the
 * default node pool). An `integration` project (T3 — the deployed alchemy stack
 * on local workerd) is added when this app grows real backend behavior to assert
 * black-box over HTTP.
 */
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		reporters: ["verbose"],
		projects: [
			{
				test: {
					name: "unit",
					include: ["worker/**/*.test.ts", "src/**/*.test.ts"],
					exclude: ["tests/**", "node_modules/**", "dist/**"],
				},
			},
		],
	},
});
