/**
 * Lane admission — the one step between a `lane` argument and any verb that acts on it.
 *
 * Every keyed verb enters through here, so a key is read, canonicalized and refused in one place
 * rather than re-interpreted by each verb's own body. That is the whole guard: a malformed key is
 * seated before a board read is sent or a lanes root is touched, and a padded spelling is one
 * identity by the time any verb sees it.
 *
 * It lives beside the verbs rather than inside [`command.ts`](command.ts) because the admission is
 * the behaviour under test — a refusal that reaches neither the board nor the filesystem is only
 * provable where the run it refuses can be substituted.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/8853
 */
import {Effect, type FileSystem, Path} from "effect";
import type {VerbOutcome} from "../verb.ts";
import {deriveRepoRoot, onGround, repoGroundRefusal} from "./ground.ts";
import {defaultRoot, type LaneKey, laneRef, parseKey} from "./key.ts";
import {keyRefusal} from "./refusals.ts";
import type {LaneRef} from "./store.ts";

/**
 * Resolve the `lane` argument to a key and its directory, or refuse it — the one step every keyed
 * verb shares, so a malformed key is caught before any verb reads or writes anything, and the ground
 * under the resolved root is proven before either. An explicit `root` wins; otherwise the root is
 * derived off the repository the cwd belongs to, so a linked worktree reads the same ledger
 * as the primary checkout instead of proving the lane absent against its own empty one.
 */
export const admitKey = <R>(
	verb: string,
	raw: string,
	root: string | null,
	cwd: string,
	run: (key: LaneKey, ref: LaneRef) => Effect.Effect<VerbOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, R | FileSystem.FileSystem | Path.Path> => {
	const parsed = parseKey(raw);
	if (parsed._tag === "Malformed") return Effect.succeed(keyRefusal(parsed));
	if (root !== null) {
		const ref = laneRef(parsed.key, root);
		return onGround(verb, [ref.root], cwd, () => run(parsed.key, ref));
	}
	return Effect.gen(function* () {
		const path = yield* Path.Path;
		const ground = yield* deriveRepoRoot(cwd);
		if (ground._tag !== "Derived") {
			return repoGroundRefusal(`fabrika lane ${verb}`, ground);
		}
		const ref = laneRef(parsed.key, path.join(ground.repoRoot, defaultRoot(parsed.key)));
		return yield* onGround(verb, [ref.root], cwd, () => run(parsed.key, ref));
	});
};

/**
 * Resolve the `lane` argument for a verb whose ground is the **board**, not the disk — `claim` and
 * `release`, which race a marker on the issue a lane drives and read no lanes root at all. They take
 * the key alone rather than a ref, so neither can reach a root the cwd would decide, and neither owes
 * the repo probe {@link admitKey} makes.
 */
export const admitBoardKey = <R>(
	raw: string,
	run: (key: LaneKey) => Effect.Effect<VerbOutcome, never, R>,
): Effect.Effect<VerbOutcome, never, R> => {
	const parsed = parseKey(raw);
	return parsed._tag === "Malformed" ? Effect.succeed(keyRefusal(parsed)) : run(parsed.key);
};
