/**
 * The late holder's refusal arm: what `lateSpellBridge` does when nothing handed the kernel over.
 *
 * The holder is module state (`./late.ts` says why it has to be), so this file never calls
 * `handOverKernel` — a fill anywhere in it would hold for every case after it and the arm under
 * test would stop being reachable. The filled arm is proved where it matters instead, over two
 * boots against one project dir (`./holder-restart.integration.test.ts`).
 */

import {assert, describe, it} from "@effect/vitest";
import {Cause, Effect, Exit, Layer} from "effect";
import {lateSpellBridge} from "./late.ts";

describe("the late kernel holder", () => {
	it.effect("dies, naming its own file, when nothing has handed the kernel over", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(Effect.scoped(Layer.build(lateSpellBridge)));

			assert.isTrue(Exit.isFailure(exit), "an empty holder answered with a bridge");
			assert.isTrue(
				Exit.isFailure(exit) && Cause.hasDies(exit.cause),
				"the empty holder refused in the error channel, where a caller could swallow it",
			);
			const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
			assert.instanceOf(defect, Error);
			assert.include(
				(defect as Error).message,
				"src/claude/proof/late.ts",
				"the refusal does not name the file a reader has to open",
			);
		}),
	);
});
