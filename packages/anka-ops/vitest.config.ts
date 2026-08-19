// Unit tier only (ADR 0082) — nothing here touches a real keychain or CF yet.
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
