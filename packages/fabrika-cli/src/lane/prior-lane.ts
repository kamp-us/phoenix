/**
 * Whether the board says this issue has already been driven by a lane — the read `lane open`
 * refuses an issue-keyed re-boot on.
 *
 * A lane's ledger IS its state, and `.fabrika/` is gitignored, so a deleted directory leaves the
 * repository holding nothing at all: the boot that follows mints a lane at a full repair budget with
 * no record anywhere that a round was granted. That is how one lane came back from `frozen` at its
 * cap reading like a first boot.
 *
 * **The fact comes off the board because there is nowhere else to read it.** No durable on-disk
 * trace of a retired lane is built — the ruling parked that with the ledger-provider decision — and
 * the two markers a lane posts on its own issue are both retracted: `lane claim` and `build claim`
 * each *delete* their comment on release, so a released claim proves nothing and a standing one is
 * as likely to be this very drive's. What survives a lane is what its builder published: a pull
 * request declaring it closes the issue. A wrong-template retire — the one retire the driver's own
 * skill sanctions — happens at the boot step, before any builder is spawned, so it carries none and
 * boots.
 *
 * A reader a caller passes rather than a seam `lane open` reaches through on its own, the shape
 * [`expectation.ts`](expectation.ts) established: handed `null`, the verb boots provably offline.
 *
 * An unreadable answer is `Unknown`, never `Fresh`. Reading a failed read as "no prior lane" is the
 * permissive arm the whole refusal exists to close.
 */
import {Effect} from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {resolveRepo} from "../io/issues.ts";
import {pullsClosing} from "../io/pulls.ts";

export type PriorLane =
	/** The board carries work a lane published on this issue — every pull request that proves it. */
	| {readonly _tag: "Prior"; readonly pulls: ReadonlyArray<number>}
	/** The board carries none, so nothing here says this issue was ever driven. */
	| {readonly _tag: "Fresh"}
	| {readonly _tag: "Unknown"; readonly reason: string};

export type PriorLaneReader<R> = (issue: number) => Effect.Effect<PriorLane, never, R>;

/**
 * The live reader: the pull requests GitHub's own closing-issue edge hangs off this issue.
 *
 * `open-or-merged` is the scope, which is `pullsClosing`'s widest: an open PR is the frozen lane's
 * own, and a merged one is a lane that already landed. A PR that closed without landing is outside
 * every scope that read offers, so a lane whose only PR was abandoned reads `Fresh` — under-reading,
 * which leaves the boot exactly where it stands today rather than refusing on a fact nothing proved.
 */
export const priorLaneReader = (
	repo: string | null,
	env: Readonly<Record<string, string | undefined>>,
): PriorLaneReader<ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient> => {
	let resolved: string | null = null;
	return (issue) =>
		Effect.gen(function* () {
			if (resolved === null) {
				const attempt = yield* resolveRepo(repo, env);
				if (attempt._tag === "Failure") {
					return {
						_tag: "Unknown" as const,
						reason: "no target repo resolves — set CLAUDE_PIPELINE_REPO, or pass --repo owner/name",
					};
				}
				resolved = attempt.value;
			}
			const closers = yield* pullsClosing(resolved, issue, "open-or-merged");
			if (closers._tag === "Failure") {
				return {
					_tag: "Unknown" as const,
					reason: `cannot read the pull requests closing #${issue}: ${closers.reason}`,
				};
			}
			return closers.value.length === 0
				? ({_tag: "Fresh"} as const)
				: ({_tag: "Prior", pulls: closers.value.map((pull) => pull.number)} as const);
		});
};
