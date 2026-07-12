/**
 * `translateVoteMiss` unit pins — the inline voter's "a Vote miss is this
 * caller's not-found" rule has one home now (extracted from the byte-identical
 * `catchTags` blocks in Sozluk/Pano). These prove both Vote miss tags collapse
 * to the supplied not-found, a fresh error is raised per failure, and success
 * passes through untouched — the no-behavior-change contract.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {TargetId} from "../../lib/ids.ts";
import {VoteTargetNotFound, VoteTargetSandboxed} from "./errors.ts";
import {translateVoteMiss} from "./translate-vote-miss.ts";

class FeatureNotFound extends Schema.TaggedErrorClass<FeatureNotFound>()("test/FeatureNotFound", {
	id: Schema.String,
	message: Schema.String,
}) {}

const makeNotFound = () => new FeatureNotFound({id: "x", message: "x not found"});

const notFound = new VoteTargetNotFound({
	targetKind: "post",
	targetId: TargetId.make("x"),
	message: "gone",
});
const sandboxed = new VoteTargetSandboxed({
	targetKind: "post",
	targetId: TargetId.make("x"),
	message: "sandboxed",
});

describe("translateVoteMiss", () => {
	it.effect("collapses VoteTargetNotFound to the caller's not-found", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(Effect.fail(notFound).pipe(translateVoteMiss(makeNotFound)));
			assert.isTrue(exit._tag === "Failure");
			const err = exit._tag === "Failure" ? exit.cause : null;
			assert.match(String(err), /test\/FeatureNotFound/);
			assert.match(String(err), /x not found/);
		}),
	);

	it.effect("collapses VoteTargetSandboxed to the same caller's not-found", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(Effect.fail(sandboxed).pipe(translateVoteMiss(makeNotFound)));
			assert.isTrue(exit._tag === "Failure");
			assert.match(String(exit._tag === "Failure" ? exit.cause : ""), /test\/FeatureNotFound/);
		}),
	);

	it.effect("raises a fresh error instance per failure (thunk, not a shared value)", () =>
		Effect.gen(function* () {
			const a = yield* Effect.flip(Effect.fail(notFound).pipe(translateVoteMiss(makeNotFound)));
			const b = yield* Effect.flip(Effect.fail(sandboxed).pipe(translateVoteMiss(makeNotFound)));
			assert.notStrictEqual(a, b);
			assert.strictEqual(a._tag, "test/FeatureNotFound");
			assert.strictEqual(b._tag, "test/FeatureNotFound");
		}),
	);

	it.effect("passes success through untouched", () =>
		Effect.gen(function* () {
			const value = yield* Effect.succeed(42).pipe(translateVoteMiss(makeNotFound));
			assert.strictEqual(value, 42);
		}),
	);
});
