import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {atLine, gateFailureAnnotations, unlocated} from "./annotate.ts";
import {annotationsOrNone} from "./gate-fail.ts";

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

describe("annotationsOrNone", () => {
	it("passes a successful build through untouched", async () => {
		const built = [atLine("error", "a.ts", 3, "bad")];
		expect(await run(annotationsOrNone(() => built))).toEqual(built);
	});

	// The build runs EAGERLY as the `annotations` argument of a guard's CheckFailed, so an
	// unguarded throw kills the report before the error carrying it exists.
	it("degrades a throwing build to no annotations, so the report survives", async () => {
		const annotations = await run(
			annotationsOrNone(() => {
				throw new SyntaxError("Invalid regular expression");
			}),
		);
		expect(annotations).toEqual([]);
		// and the shared handler then still annotates the failure off the report itself
		expect(
			gateFailureAnnotations("catalog-guard: 1 dependency pins a hardcoded version", annotations),
		).toEqual([unlocated("error", "catalog-guard: 1 dependency pins a hardcoded version")]);
	});
});
