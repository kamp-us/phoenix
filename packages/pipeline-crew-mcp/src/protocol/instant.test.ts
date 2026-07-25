/**
 * The observed-instant core (#3895, ADR 0211): a clock reading becomes a typed instant or a typed
 * unknown — never a fabricated or defaulted time.
 */
import {assert, describe, it} from "@effect/vitest";
import {Clock, Effect, Schema} from "effect";
import {
	Iso8601Utc,
	MAX_PLAUSIBLE_EPOCH_MILLIS,
	MIN_PLAUSIBLE_EPOCH_MILLIS,
	renderInstant,
	StampedInstant,
	stampFromMillis,
	stampNow,
} from "./instant.ts";

describe("protocol/instant — stampFromMillis", () => {
	it("a plausible reading becomes an ObservedInstant rendered ISO-8601 UTC", () => {
		const stamped = stampFromMillis(Date.parse("2026-07-24T17:30:05.123Z"));
		assert.deepStrictEqual(stamped, {
			_tag: "ObservedInstant",
			iso: "2026-07-24T17:30:05.123Z",
		});
	});

	it("the rendered form satisfies the Iso8601Utc check", () => {
		const stamped = stampFromMillis(Date.parse("2026-07-24T17:30:05.123Z"));
		assert.strictEqual(stamped._tag, "ObservedInstant");
		if (stamped._tag !== "ObservedInstant") return;
		assert.strictEqual(Schema.decodeUnknownSync(Iso8601Utc)(stamped.iso), stamped.iso);
	});

	// A leaked TestClock starts at 0. Rendering it would produce a confident `1970-01-01T00:00:00.000Z`
	// — the indeterminate-read-as-confident-value defect this module exists to remove.
	it("an epoch-0 reading resolves UNKNOWN, never a confident 1970 instant", () => {
		const stamped = stampFromMillis(0);
		assert.strictEqual(stamped._tag, "UnknownInstant");
		assert.notInclude(JSON.stringify(stamped), "1970");
	});

	it("a non-finite reading resolves UNKNOWN", () => {
		for (const bogus of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			assert.strictEqual(stampFromMillis(bogus)._tag, "UnknownInstant", `for ${bogus}`);
		}
	});

	it("a reading outside the plausible window resolves UNKNOWN at both ends", () => {
		assert.strictEqual(stampFromMillis(MIN_PLAUSIBLE_EPOCH_MILLIS - 1)._tag, "UnknownInstant");
		assert.strictEqual(stampFromMillis(MAX_PLAUSIBLE_EPOCH_MILLIS + 1)._tag, "UnknownInstant");
		assert.strictEqual(stampFromMillis(MIN_PLAUSIBLE_EPOCH_MILLIS)._tag, "ObservedInstant");
		assert.strictEqual(stampFromMillis(MAX_PLAUSIBLE_EPOCH_MILLIS)._tag, "ObservedInstant");
	});

	it("an UnknownInstant carries a reason and NO time field to misread", () => {
		const stamped = stampFromMillis(Number.NaN);
		assert.strictEqual(stamped._tag, "UnknownInstant");
		assert.notProperty(stamped, "iso");
		if (stamped._tag !== "UnknownInstant") return;
		assert.isAbove(stamped.reason.length, 0);
	});

	it("every outcome decodes as the wire StampedInstant", () => {
		for (const millis of [Date.now(), 0, Number.NaN]) {
			const stamped = stampFromMillis(millis);
			assert.deepStrictEqual(Schema.decodeUnknownSync(StampedInstant)(stamped), stamped);
		}
	});
});

describe("protocol/instant — stampNow reads the ambient clock", () => {
	it.live("stamps the ambient clock's own reading, not a caller-supplied value", () =>
		Effect.gen(function* () {
			const stamped = yield* stampNow;
			const reading = yield* Clock.currentTimeMillis;
			assert.strictEqual(stamped._tag, "ObservedInstant");
			if (stamped._tag !== "ObservedInstant") return;
			assert.isAtMost(Math.abs(Date.parse(stamped.iso) - reading), 5_000);
		}),
	);

	// `it.effect` runs under the TestClock, which starts parked at epoch 0 — the synthetic time
	// source the investigation raised as a candidate. It stamps UNKNOWN, so a leaked test clock can
	// never surface as a confident instant.
	it.effect("a synthetic clock parked at epoch 0 stamps UNKNOWN, never a 1970 instant", () =>
		Effect.gen(function* () {
			const stamped = yield* stampNow;
			assert.strictEqual(stamped._tag, "UnknownInstant");
		}),
	);
});

describe("protocol/instant — renderInstant", () => {
	it("renders an observation as its ISO instant", () => {
		assert.strictEqual(
			renderInstant(stampFromMillis(Date.parse("2026-07-24T17:30:05.000Z"))),
			"2026-07-24T17:30:05.000Z",
		);
	});

	it("renders an unknown as the literal word unknown, unmistakable as a time", () => {
		const rendered = renderInstant(stampFromMillis(Number.NaN));
		assert.match(rendered, /^unknown \(/);
		assert.notMatch(rendered, /\d{4}-\d{2}-\d{2}T/);
	});
});
