/**
 * The scaffold's tracer test — wires the `@effect/vitest` harness end to end so the
 * package's `test` script runs something real (issue #3052). Replaced by the modules'
 * own tests as they land.
 */
import {assert, describe, it} from "@effect/vitest";
import {VERSION} from "./version.ts";

describe("pipeline-crew-mcp scaffold", () => {
	it("exposes a version string", () => {
		assert.strictEqual(VERSION, "0.0.0");
	});
});
