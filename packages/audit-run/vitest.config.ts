/**
 * Vitest config — unit-only (ADR 0082's `unit` tier). The orchestration core (`run.ts`) is
 * tested against an in-memory fake port + a fake walk + a fake archiver with no real deploy
 * and no real agent run; the real adapter (`adapter.ts`) is exercised only against a live
 * Cloudflare account + a real explorer walk (the integration concern, out of scope here).
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
