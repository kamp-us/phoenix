/**
 * Unit cover for the typed worker-env accessors (`shared/worker-env.ts`).
 *
 * These are pure, alchemy-free helpers so the admin gate derivation is testable
 * without evaluating the alchemy `Worker` class (which `index.ts` does at module
 * load). `index.ts` builds a typed `WorkerEnv` and derives `adminAllowed` through
 * {@link adminAllowed}; this asserts the gate opens only on `development` and is
 * closed for every other (real-deploy) environment.
 */
import {describe, expect, it} from "vitest";
import {adminAllowed} from "./worker-env.ts";

/** A minimal `WorkerEnv` with only the field the gate reads. */
const envWith = (environment: string) => ({ENVIRONMENT: environment}) as never;

describe("adminAllowed", () => {
	it("opens the admin gate when ENVIRONMENT is development", () => {
		expect(adminAllowed({ENVIRONMENT: "development"} as never)).toBe(true);
	});

	it("closes the admin gate when ENVIRONMENT is production (fail-closed)", () => {
		expect(adminAllowed(envWith("production"))).toBe(false);
	});

	it("closes the admin gate for any non-development environment", () => {
		for (const environment of ["staging", "preview", "", "DEVELOPMENT", "dev"]) {
			expect(adminAllowed(envWith(environment))).toBe(false);
		}
	});
});
