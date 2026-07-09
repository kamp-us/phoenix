/**
 * The `epic-lock` tool — `pipeline-cli epic-lock acquire <epic>` /
 * `pipeline-cli epic-lock release <epic>`.
 *
 * The ADR-0059 `status:planning` epic-lock, extracted from the ~50-line inline jq
 * glue the `plan-epic` / `review-plan` / `write-code` skills each hand-rolled (#2098).
 * `acquire` runs the two-layer coarse-label + agent-distinguishable-claim protocol
 * (ADR 0115) and **exits 0 only when the lock is ours**; every fail-closed back-off —
 * a held label, a 422 missing label, a failed claim post, a lost co-acquire, a missing
 * session id — prints a reason on stderr and **exits non-zero**, so a caller branches
 * on exit status (`epic-lock acquire N && <mutate>`) rather than parsing prose.
 * `release` retracts our own claim comment(s) and drops the label (404-benign, loud on
 * any other DELETE failure), exiting 0.
 *
 * The session id is our `CLAUDE_CODE_SESSION_ID` (the only agent-distinguishable signal
 * under the shared `usirin` login) — an absent value fails closed. `--session` overrides
 * it for the orchestrated/delegated-token path and for tests.
 *
 * `GithubLive` is baked in with `Command.provide(...)` so the registered command's
 * residual requirement is the Node platform union (the registry seam, epic #994).
 */
import {Console, Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {type AcquireResult, Github, GithubLive} from "./github.ts";

const BACKOFF_EXIT_CODE = 1;

const epicArg = Argument.integer("epic").pipe(
	Argument.withDescription("the epic issue number to lock/unlock"),
);

const sessionFlag = Flag.string("session").pipe(
	Flag.optional,
	Flag.withDescription(
		"the claiming session id (default: $CLAUDE_CODE_SESSION_ID); the delegated token on the orchestrated path",
	),
);

const resolveSession = (session: Option.Option<string>): string =>
	Option.getOrElse(session, () => process.env.CLAUDE_CODE_SESSION_ID ?? "").trim();

/** Print the back-off reason on stderr and exit non-zero — the "did not acquire" signal. */
const backOff = (reason: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`epic-lock: ${reason}\n`);
		process.exit(BACKOFF_EXIT_CODE);
	});

const reportAcquire = (epic: number, result: AcquireResult): Effect.Effect<void> => {
	switch (result._tag) {
		case "acquired":
			return Console.log(
				`epic-lock: acquired status:planning on epic #${epic} — proceed to mutate.`,
			);
		case "held-by-other":
			return backOff(
				`epic #${epic} is being planned by another run (status:planning held) — BACK OFF, do not mutate.`,
			);
		case "label-missing":
			return backOff(
				`could not acquire status:planning on epic #${epic} (422 missing label? transient gh fault?) — BACK OFF, do not mutate. (${result.stderr.trim()})`,
			);
		case "claim-post-failed":
			return backOff(
				`failed to post the planning claim on epic #${epic} — BACK OFF, do not mutate (the status:planning label may be leaked; a human clears it). (${result.stderr.trim()})`,
			);
		case "lost":
			return backOff(
				`lost the status:planning co-acquire on epic #${epic} (earliest authorized claim is ${result.winner}) — BACK OFF, do not mutate.`,
			);
	}
};

const acquire = Command.make(
	"acquire",
	{epic: epicArg, session: sessionFlag},
	Effect.fn(function* ({epic, session}) {
		const sessionId = resolveSession(session);
		if (sessionId === "") {
			yield* backOff(
				"no CLAUDE_CODE_SESSION_ID (and no --session) — cannot post an agent-distinguishable planning claim. BACK OFF, do not mutate.",
			);
			return;
		}
		const result = yield* (yield* Github).acquire(epic, sessionId);
		yield* reportAcquire(epic, result);
	}),
).pipe(
	Command.withDescription(
		"Acquire the status:planning epic-lock (exit 0 = held by us; non-zero = backed off, do not mutate)",
	),
);

const release = Command.make(
	"release",
	{epic: epicArg, session: sessionFlag},
	Effect.fn(function* ({epic, session}) {
		const sessionId = resolveSession(session);
		if (sessionId === "") {
			// Release with no session id can only retract by session — nothing to do, but the label
			// may still be held. Surface it loudly and exit non-zero rather than silently no-op.
			yield* backOff(
				"no CLAUDE_CODE_SESSION_ID (and no --session) — cannot identify our own claim to retract. Clear status:planning by hand if leaked.",
			);
			return;
		}
		const result = yield* (yield* Github).release(epic, sessionId);
		yield* Console.log(
			`epic-lock: released epic #${epic} — retracted ${result.retracted} claim comment(s), ` +
				(result.labelRemoved
					? "removed status:planning."
					: "status:planning was already absent (404-benign)."),
		);
	}),
).pipe(
	Command.withDescription(
		"Release the status:planning epic-lock: retract our claim comment(s) + drop the label (404-benign)",
	),
);

export const epicLockCommand = Command.make("epic-lock").pipe(
	Command.withSubcommands([acquire, release]),
	Command.withDescription(
		"Acquire/release the ADR-0059 status:planning epic-lock (ADR 0115 claim protocol)",
	),
	Command.provide(GithubLive),
);
