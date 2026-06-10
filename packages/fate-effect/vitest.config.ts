/**
 * Vitest config — the package hosts T0 tests only (ADR 0040): pure logic,
 * zero storage, colocated `*.unit.test.ts` files next to the module under
 * test. T1/T2 coverage of the compiled server lives in `@phoenix/web`, where
 * the worker layer and test databases are.
 */
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
});
