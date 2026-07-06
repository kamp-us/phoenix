/**
 * Vitest config — this package has a `unit` tier only. Its pure core
 * (surface→plan selection, the upload-response parser, the endpoint URL
 * builder) is DB-free and browser-free, so it needs neither the real-D1
 * integration tier of ADR 0082 nor a Playwright run: the impure legs
 * (`captureShots` over chromium, `uploadAsset` over the network) are the thin
 * bin, unit-covered only where a stubbed transport keeps them off-network
 * (`upload.unit.test.ts` drives `uploadAsset` over an in-memory `HttpClient` to
 * prove the fallback path).
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
