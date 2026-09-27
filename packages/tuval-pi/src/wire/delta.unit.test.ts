/**
 * The incremental half of the session stream, over hand-built wire values: what one revision is
 * worth to a viewer holding the last one, and that applying it lands on the value it was diffed
 * from. The pair is a round trip, so both halves are asserted against the same snapshots.
 */

import {assert, describe, it} from "@effect/vitest";
import {compactionId} from "./compaction.ts";
import {applyDelta, nextPush} from "./delta.ts";
import type {SessionSnapshot, TranscriptItem} from "./index.ts";

const user: TranscriptItem = {
	id: "item-0",
	role: "user",
	content: [{type: "text", text: "say hello"}],
	timestamp: 10,
};

const reply = (text: string, status: "streaming" | "complete"): TranscriptItem =>
	status === "streaming"
		? {
				id: "item-1",
				role: "assistant",
				content: [{type: "text", text}],
				model: {provider: "faux", id: "faux-1"},
				timestamp: 11,
				status: "streaming",
			}
		: {
				id: "item-1",
				role: "assistant",
				content: [{type: "text", text}],
				model: {provider: "faux", id: "faux-1"},
				timestamp: 11,
				status: "complete",
				stopReason: "stop",
			};

/** A compaction's boundary row at `position`, keyed the way the server keys one. */
const boundary = (position: number): TranscriptItem => ({
	id: compactionId(position),
	role: "compaction",
	content: [{type: "text", text: "what came before, summarised"}],
	timestamp: position,
});

const snapshot = (options: {
	readonly transcript: ReadonlyArray<TranscriptItem>;
	readonly phase?: SessionSnapshot["phase"];
	readonly revision: number;
	readonly name?: string;
}): SessionSnapshot => ({
	id: "session-8554",
	...(options.name === undefined ? {} : {name: options.name}),
	cwd: "/workspace",
	createdAt: 0,
	updatedAt: options.revision * 100,
	phase: options.phase ?? "idle",
	model: {provider: "faux", id: "faux-1"},
	thinkingLevel: "off",
	attached: true,
	locked: true,
	revision: options.revision,
	transcript: [...options.transcript],
	queuedSteer: [],
	queuedSteerCount: 0,
});

describe("what one revision is worth to a viewer", () => {
	it("hands a viewer holding nothing the whole value", () => {
		const first = snapshot({transcript: [user], revision: 1});
		assert.deepStrictEqual(nextPush(undefined, first), {_tag: "Snapshot", snapshot: first});
	});

	it("sends one item and the phase for a token appended to a running reply", () => {
		const before = snapshot({
			transcript: [user, reply("hi", "streaming")],
			phase: "turn",
			revision: 4,
		});
		const after = snapshot({
			transcript: [user, reply("hi t", "streaming")],
			phase: "turn",
			revision: 5,
		});
		const push = nextPush(before, after);
		assert.strictEqual(push._tag, "Delta");
		if (push._tag !== "Delta") return;
		assert.deepStrictEqual(push.delta.items, [reply("hi t", "streaming")]);
		assert.strictEqual(push.delta.revision, 5);
		assert.strictEqual(
			push.delta.phase,
			undefined,
			"an unchanged scalar rode along, which is the cost the delta exists to avoid",
		);
	});

	it("names a scalar that moved and leaves the transcript out when it did not", () => {
		const before = snapshot({transcript: [user], phase: "turn", revision: 4});
		const after = snapshot({transcript: [user], phase: "idle", revision: 5});
		const push = nextPush(before, after);
		assert.strictEqual(push._tag, "Delta");
		if (push._tag !== "Delta") return;
		assert.strictEqual(push.delta.phase, "idle");
		assert.strictEqual(push.delta.items, undefined);
	});

	/**
	 * A delta is a change set over ids and the wire's ids are positional, so a transcript that no
	 * longer extends the last one is a rewrite — a compaction, or a branch. There is nothing to
	 * patch, and guessing would leave the viewer reading a transcript the session does not have.
	 */
	it("falls back to the whole value when the transcript stopped extending", () => {
		const before = snapshot({transcript: [user, reply("hi back", "complete")], revision: 4});
		const compacted = snapshot({transcript: [reply("summary", "complete")], revision: 5});
		assert.deepStrictEqual(nextPush(before, compacted), {
			_tag: "Snapshot",
			snapshot: compacted,
		});
	});

	/**
	 * A compaction's boundary row (#8588) lands under `compactionId(position)` —
	 * `item-<n>:compaction`, deliberately *not* the plain `item-<n>` an ordinary message at that
	 * position takes (`./compaction.ts`, `../server/transcript.ts`). That distinctness is what makes
	 * the prefix test see a boundary substituted into the transcript as a rewrite, and it is an
	 * invariant across two modules that nothing else pins.
	 */
	it("falls back to the whole value when a boundary row replaces a row mid-transcript", () => {
		const before = snapshot({transcript: [user, reply("hi back", "complete")], revision: 4});
		const compacted = snapshot({
			transcript: [boundary(0), reply("hi back", "complete")],
			revision: 5,
		});
		assert.strictEqual(boundary(0).id, compactionId(0));
		assert.notStrictEqual(boundary(0).id, user.id);
		assert.deepStrictEqual(nextPush(before, compacted), {
			_tag: "Snapshot",
			snapshot: compacted,
		});
	});

	it("carries a boundary row appended past the last one as an ordinary delta item", () => {
		const before = snapshot({transcript: [user, reply("hi back", "complete")], revision: 4});
		const after = snapshot({
			transcript: [user, reply("hi back", "complete"), boundary(2)],
			revision: 5,
		});
		const push = nextPush(before, after);
		assert.strictEqual(push._tag, "Delta");
		if (push._tag !== "Delta") return;
		assert.deepStrictEqual(push.delta.items, [boundary(2)]);
		assert.deepStrictEqual(applyDelta(before, push.delta), after);
	});

	it("falls back to the whole value when the session lost its name", () => {
		const before = snapshot({transcript: [user], revision: 4, name: "kefil"});
		const after = snapshot({transcript: [user], revision: 5});
		assert.strictEqual(nextPush(before, after)._tag, "Snapshot");
	});

	it("sends nothing when the revision moved but nothing a viewer reads did", () => {
		const before = snapshot({transcript: [user], revision: 4});
		const after = snapshot({transcript: [user], revision: 5});
		assert.deepStrictEqual(nextPush(before, after), {_tag: "Unchanged"});
	});
});

describe("applying one delta to the value it was diffed from", () => {
	const roundTrip = (before: SessionSnapshot, after: SessionSnapshot): SessionSnapshot => {
		const push = nextPush(before, after);
		if (push._tag === "Snapshot") return push.snapshot;
		if (push._tag === "Unchanged") return before;
		return applyDelta(before, push.delta);
	};

	it("lands on the snapshot the server diffed, for a token, a settle and a new turn", () => {
		const opened = snapshot({transcript: [user], phase: "turn", revision: 1});
		const writing = snapshot({
			transcript: [user, reply("hi", "streaming")],
			phase: "turn",
			revision: 2,
		});
		const settled = snapshot({
			transcript: [user, reply("hi back", "complete")],
			phase: "idle",
			revision: 3,
		});
		assert.deepStrictEqual(roundTrip(opened, writing), writing);
		assert.deepStrictEqual(roundTrip(writing, settled), settled);
	});

	it("replaces a row by id rather than appending a second copy of it", () => {
		const writing = snapshot({
			transcript: [user, reply("hi", "streaming")],
			phase: "turn",
			revision: 2,
		});
		const settled = snapshot({
			transcript: [user, reply("hi back", "complete")],
			phase: "turn",
			revision: 3,
		});
		const applied = roundTrip(writing, settled);
		assert.lengthOf(applied.transcript, 2);
		assert.deepStrictEqual(applied.transcript[1], reply("hi back", "complete"));
	});
});
