/**
 * Vitest config — this package is unit-only (ADR 0082's `unit` tier). The orchestration
 * core (`lifecycle.ts`) is tested against an in-memory fake port with no real deploy; the
 * real adapter (`adapter.ts`) is exercised only against a live Cloudflare account, which is
 * out of scope here (it needs CF creds + an actual `alchemy deploy`, the integration tier
 * the on-demand run #1517 will drive).
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
