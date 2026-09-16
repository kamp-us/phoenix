/**
 * The stop claim, driven at its own seam (#8940).
 *
 * This is where the interleaved second press is covered. The layer-level version of that case drove
 * the race through the real `interrupt` and cut the run loop's yield budget to 3 to force it, which
 * is a value one op away from starving the fibers outright — on a loaded CI runner it starved and
 * the case timed out on a PR that touched no Tuval code. Nothing replaces that budget: in the
 * read-then-write shape #8883 describes, the window between the read and the write is two adjacent
 * *synchronous* ops, so no rendezvous a test owns can suspend a fiber inside it, and a budget of 1 —
 * the one value that would split the pair by construction rather than by timing — starves the two
 * fibers outright (measured here: the case hung to its 5000ms budget).
 *
 * So the race is not what defends the claim, and two other things are. The concurrent case below
 * asserts "exactly one owner", which holds under every interleaving and can therefore never red
 * falsely. The last case reads this module's own source, because the one property no behavioural
 * test can reach is that the read and the write are a single op — a claim re-spelled as two would
 * answer every other case here identically.
 */

import {readFileSync} from "node:fs";
import {assert, describe, it} from "@effect/vitest";
import {Effect, Sink, Stream} from "effect";
import {ChildProcessSpawner} from "effect/unstable/process";
import {makeStopClaim} from "./stop-claim.ts";

/** A handle that does nothing: the claim reads identity and nothing else. */
const handle = (pid: number): ChildProcessSpawner.ChildProcessHandle =>
	ChildProcessSpawner.makeHandle({
		pid: ChildProcessSpawner.ProcessId(pid),
		exitCode: Effect.never,
		isRunning: Effect.succeed(true),
		kill: () => Effect.void,
		stdin: Sink.drain,
		stdout: Stream.empty,
		stderr: Stream.empty,
		all: Stream.empty,
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		unref: Effect.succeed(Effect.void),
	});

describe("the claim a stop takes on one child", () => {
	it.effect("answers the press that owns it, and tells a second press no", () =>
		Effect.gen(function* () {
			const stop = yield* makeStopClaim;
			const child = handle(1);

			assert.isTrue(yield* stop.claim(child), "the first press did not own the stop it sent");
			assert.isFalse(
				yield* stop.claim(child),
				"a second press was told to send a signal of its own",
			);
			assert.isTrue(yield* stop.heldBy(child), "the stop in flight named no child");
		}),
	);

	it.effect("leaves one owner when two presses claim it at once", () =>
		Effect.gen(function* () {
			const stop = yield* makeStopClaim;
			const child = handle(1);

			const answers = yield* Effect.all([stop.claim(child), stop.claim(child)], {
				concurrency: "unbounded",
			});

			assert.deepStrictEqual(
				answers.filter((owned) => owned),
				[true],
				"both presses claimed the stop, so both would have signalled and both relaunched",
			);
		}),
	);

	it.effect("gives the claim back for a signal the backend refused", () =>
		Effect.gen(function* () {
			const stop = yield* makeStopClaim;
			const child = handle(1);

			yield* stop.claim(child);
			yield* stop.release(child);

			assert.isFalse(yield* stop.heldBy(child), "a refused signal went on speaking for the child");
			assert.isTrue(
				yield* stop.claim(child),
				"the press after a refusal was locked out of a stop that was never sent",
			);
		}),
	);

	// The claim names the child, not the layer: a relaunch whose `openSession` failed must not leave
	// the next child's own death reading as a stop nobody sent (#8709).
	it.effect("names the child, so the next child's stop is its own", () =>
		Effect.gen(function* () {
			const stop = yield* makeStopClaim;
			const first = handle(1);
			const second = handle(2);

			yield* stop.claim(first);
			assert.isTrue(yield* stop.claim(second), "the relaunched child could not be stopped");
			assert.isFalse(
				yield* stop.heldBy(first),
				"the stopped child still held the claim after the relaunch took it",
			);
		}),
	);

	it.effect("releases its own child only, leaving a later claim standing", () =>
		Effect.gen(function* () {
			const stop = yield* makeStopClaim;
			const first = handle(1);
			const second = handle(2);

			yield* stop.claim(first);
			yield* stop.claim(second);
			yield* stop.release(first);

			assert.isTrue(
				yield* stop.heldBy(second),
				"a release named to the stopped child took the relaunched child's claim with it",
			);

			yield* stop.release(second);
			assert.isFalse(
				yield* stop.heldBy(second),
				"the release named to the child that held the stop left it in flight",
			);
		}),
	);

	/**
	 * A `claim` re-spelled as a `Ref.get` and a `Ref.set` answers every case above identically and is
	 * the #8883 defect back, so the single step is read off the source instead — the same probe idiom
	 * `boundary.unit.test.ts` uses in this directory for a property no call can observe.
	 */
	it("takes the stop in one step", () => {
		const source = readFileSync(new URL("./stop-claim.ts", import.meta.url), "utf8");
		const from = source.indexOf("\t\tclaim: (");
		const to = source.indexOf("\t\theldBy: (");
		assert.isTrue(from > -1 && to > from, "stop-claim.ts no longer spells `claim` before `heldBy`");

		const claim = source.slice(from, to);
		assert.include(claim, "Ref.modify(", "the claim is no longer one atomic step");
		assert.notInclude(claim, "Ref.get(", "the claim reads the memory in a step of its own");
		assert.notInclude(claim, "Ref.set(", "the claim writes the memory in a step of its own");
	});
});
