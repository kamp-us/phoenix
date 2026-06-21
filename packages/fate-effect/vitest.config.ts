/**
 * Vitest config — the package hosts unit + integration tests (ADR 0082): pure
 * logic in colocated `*.unit.test.ts` files, plus the layer-construction and
 * compiled-server suites (`Server.test.ts`, `Executor.test.ts`) that build
 * real runtimes over in-memory fixtures — no external storage. Integration
 * coverage of the worker's fate server lives in `@kampus/web`, where the worker
 * layer and test databases are.
 */
import {defineConfig} from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
});
