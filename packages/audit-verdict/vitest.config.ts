/**
 * Vitest config — only the `unit` tier (ADR 0082). The verdict core is pure (no DB, no
 * deploy, no IO): `buildVerdict` / `diffVerdicts` / `findingKey` / the archive-path
 * invariant are all asserted in-memory, so there is no integration tier here.
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
