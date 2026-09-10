import {assert, it} from "@effect/vitest";
import {Effect} from "effect";
import {pagingReplay} from "./paging-replay.ts";

it.effect(
	"the browser proof replays the partial-to-stored identity boundary without a live CLI",
	() =>
		Effect.gen(function* () {
			const replay = yield* pagingReplay();
			assert.deepStrictEqual(replay.unavailable, [{kind: "unavailable"}, {kind: "unavailable"}]);
			assert.strictEqual(replay.partialReads, 0);
			assert.strictEqual(replay.completedReads, 1);
			assert.isTrue(replay.partial.partial);
			assert.isUndefined(replay.completed.partial);
			assert.strictEqual(replay.local.id, "local:stream-send");
			assert.deepStrictEqual(replay.cursor, {kind: "page", before: replay.completed.id});
			assert.isString(replay.storedCursor);
			assert.notStrictEqual(replay.storedCursor, replay.completed.id);
			assert.deepStrictEqual(
				replay.page.items.map((item) => item.kind),
				["user", "tool", "assistant"],
			);
		}),
);
