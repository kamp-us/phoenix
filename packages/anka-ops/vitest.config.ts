/**
 * Vitest config — the unit tier only (ADR 0082's `unit`/`integration` split). The skeleton's
 * pure cores (verb-group registry, the ADR 0134 non-TTY posture) are deterministic transforms
 * with no real keychain or CF, so `*.unit.test.ts` is the whole surface today; a later verb
 * group adds an `integration` project when a read is only-wrong-if-the-real-infra-differs.
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
