/**
 * protocol/instant — the observed-instant type, and the only sanctioned way to produce one.
 *
 * A crew message's time field used to be a bare `Schema.String` the SENDER filled in. On this
 * substrate the sender is a language model composing JSON, so that field was authored prose that
 * merely looked like a reading: it could be plausibly wrong, or a hand-written placeholder, with
 * nothing distinguishing either from a real observation (#3895). The fix is a type, not a warning —
 * `StampedInstant` is producible only from a clock reading, and an unusable reading resolves to a
 * typed `UnknownInstant` rather than a fabricated or defaulted time.
 */
import {Clock, Effect, Schema} from "effect";

/**
 * The lower sanity bound on a clock reading, as epoch millis (2020-01-01T00:00:00Z). A reading at
 * or near the epoch is the signature of an uninitialized or synthetic time source — a leaked
 * `TestClock` starts at 0 — and rendering it would produce a confident `1970-01-01T00:00:00.000Z`,
 * the exact indeterminate-read-as-confident-value defect this module exists to remove.
 */
export const MIN_PLAUSIBLE_EPOCH_MILLIS = Date.UTC(2020, 0, 1);

/** The upper sanity bound on a clock reading, as epoch millis (2100-01-01T00:00:00Z). */
export const MAX_PLAUSIBLE_EPOCH_MILLIS = Date.UTC(2100, 0, 1);

/** An ISO-8601 UTC instant, `Z`-suffixed — the rendered form of an observed reading. */
const ISO_8601_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const Iso8601Utc = Schema.String.check(
	Schema.isPattern(ISO_8601_UTC_RE, {
		title: "Iso8601Utc",
		description: "an ISO-8601 UTC instant, e.g. 2026-07-24T17:30:05.123Z",
	}),
);

/** A time actually read off a clock, rendered ISO-8601 UTC. */
export const ObservedInstant = Schema.Struct({
	_tag: Schema.Literal("ObservedInstant"),
	iso: Iso8601Utc,
});

/**
 * The clock could not be read into a usable instant. It carries the `reason` and NO time field at
 * all, so there is no slot a consumer could read a fabricated instant out of.
 */
export const UnknownInstant = Schema.Struct({
	_tag: Schema.Literal("UnknownInstant"),
	reason: Schema.NonEmptyString,
});

/**
 * Every time a crew message carries. The union is the invariant: a consumer must branch on the tag,
 * so "the clock was unreadable" can never be silently read as an instant.
 */
export const StampedInstant = Schema.Union([ObservedInstant, UnknownInstant]);
export type StampedInstant = typeof StampedInstant.Type;

/**
 * The pure core: an epoch-millis reading becomes an observed instant, or a typed unknown naming why.
 * Fail-closed — only a finite reading inside the plausible window renders.
 */
export const stampFromMillis = (millis: number): StampedInstant => {
	if (!Number.isFinite(millis)) {
		return {_tag: "UnknownInstant", reason: "the clock read a non-finite value"};
	}
	if (millis < MIN_PLAUSIBLE_EPOCH_MILLIS || millis > MAX_PLAUSIBLE_EPOCH_MILLIS) {
		return {
			_tag: "UnknownInstant",
			reason: `the clock read ${millis}, outside the plausible epoch-millis window [${MIN_PLAUSIBLE_EPOCH_MILLIS}, ${MAX_PLAUSIBLE_EPOCH_MILLIS}]`,
		};
	}
	// The window check above is what makes this render total: `Date#toISOString` throws only outside
	// the representable range, which the bounds exclude by a wide margin.
	return {_tag: "ObservedInstant", iso: new Date(millis).toISOString()};
};

/**
 * Read the ambient clock and stamp it. This — never a caller-supplied value — is how every
 * transport- and receiver-stamped time in the package is produced. `Clock.currentTimeMillis` rather
 * than a raw `new Date()` so the reading goes through the one time source the runtime governs.
 */
export const stampNow: Effect.Effect<StampedInstant> = Clock.currentTimeMillis.pipe(
	Effect.map(stampFromMillis),
);

/** Whether a stamp carries a real reading — the one predicate a consumer needs before trusting it. */
export const isObserved = (instant: StampedInstant): boolean => instant._tag === "ObservedInstant";

/**
 * Render a stamp for a surface a human or a model reads. An unknown renders as the literal word
 * `unknown` plus its reason: unmistakable as a time, so no reader can mistake it for one.
 */
export const renderInstant = (instant: StampedInstant): string =>
	instant._tag === "ObservedInstant" ? instant.iso : `unknown (${instant.reason})`;
