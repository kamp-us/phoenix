import {assert, it} from "@effect/vitest";
import {Effect} from "effect";
import {initialEffortProof} from "./initial-effort.ts";

it.effect("hands the paint proof actual initial-open state before a prompt or selection", () =>
	Effect.gen(function* () {
		const proof = yield* initialEffortProof();
		assert.strictEqual(proof.state.phase, "ready");
		assert.deepStrictEqual(proof.state.models.current, {id: "opus", name: "Opus 5"});
		assert.deepStrictEqual(proof.state.thinking, {
			current: null,
			available: ["low", "medium", "high", "xhigh", "max"],
		});
		assert.deepStrictEqual(proof.record, {
			configuredModel: null,
			prompts: 0,
			modelSelections: [],
			effortSelections: [],
			contextReads: [{detail: "summary"}],
		});
		assert.lengthOf(proof.state.transcript.items, 0);
		assert.isAtLeast(proof.elapsedMs, 0);
	}),
);
