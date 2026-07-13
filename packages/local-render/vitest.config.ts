/**
 * Vitest config — this package has a `unit` tier only. Its pure core (base
 * resolution, override-cookie build, crop/downscale plan, CLI-token parsers) is
 * DB-free and browser-free; the impure Playwright leg is `@kampus/design-capture`'s
 * injected `captureShots`, so the orchestration is unit-covered with a fake leg
 * (no real browser, no local dev server).
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
