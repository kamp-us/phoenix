/**
 * The `tracker` tool — `pipeline-cli tracker claim <target>` /
 * `pipeline-cli tracker read-back <target>`.
 *
 * The seed surface of the Wave-1 `Tracker` service (ADR 0190): `claim` posts the ADR-0115
 * agent-distinguishable claim and exits 0 only when the claim is ours; `read-back` resolves
 * and prints the current owner. Judgment-as-parameter: the claiming identity is supplied,
 * not decided by the tool — the session id defaults to `$CLAUDE_CODE_SESSION_ID` (the only
 * agent-distinguishable signal under the shared `usirin` login) and `--session` overrides it
 * for the orchestrated/delegated-token path and for tests; an absent value fails closed.
 *
 * `GithubTrackerLive` is baked in with `Command.provide(...)` so the registered command's
 * residual requirement is the Node platform union (the registry seam, epic #994).
 */
import {Console, Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {type ClaimResult, GithubTrackerLive, type ReadBackResult, Tracker} from "./tracker.ts";

const BACKOFF_EXIT_CODE = 1;

const targetArg = Argument.integer("target").pipe(
	Argument.withDescription("the tracker entity (issue) number to claim / read back"),
);

const sessionFlag = Flag.string("session").pipe(
	Flag.optional,
	Flag.withDescription(
		"the claiming session id (default: $CLAUDE_CODE_SESSION_ID); the delegated token on the orchestrated path",
	),
);

const resolveSession = (session: Option.Option<string>): string =>
	Option.getOrElse(session, () => process.env.CLAUDE_CODE_SESSION_ID ?? "").trim();

/** Print the back-off reason on stderr and exit non-zero — the "did not claim" signal. */
const backOff = (reason: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`tracker: ${reason}\n`);
		process.exit(BACKOFF_EXIT_CODE);
	});

const reportClaim = (target: number, result: ClaimResult): Effect.Effect<void> => {
	switch (result._tag) {
		case "claimed":
			return Console.log(`tracker: claimed #${target} (session ${result.session}) — proceed.`);
		case "held-by-other":
			return backOff(
				`#${target} is already claimed by another agent (session ${result.owner.session}, at ${result.owner.claimedAt}) — BACK OFF, do not mutate.`,
			);
		case "lost":
			return backOff(
				`lost the co-claim on #${target}` +
					(result.owner !== null
						? ` (earliest authorized claim is session ${result.owner.session})`
						: " (our claim is not authorized — a write+ collaborator must post it)") +
					" — BACK OFF, do not mutate.",
			);
	}
};

const claim = Command.make(
	"claim",
	{target: targetArg, session: sessionFlag},
	Effect.fn(function* ({target, session}) {
		const sessionId = resolveSession(session);
		if (sessionId === "") {
			return yield* backOff(
				"no CLAUDE_CODE_SESSION_ID (and no --session) — cannot post an agent-distinguishable claim. BACK OFF, do not mutate.",
			);
		}
		const result = yield* (yield* Tracker).claim(target, {session: sessionId});
		yield* reportClaim(target, result);
	}),
).pipe(
	Command.withDescription(
		"Claim a tracker entity (exit 0 = held by us; non-zero = backed off, do not mutate)",
	),
);

const reportReadBack = (target: number, result: ReadBackResult): Effect.Effect<void> =>
	result._tag === "owned"
		? Console.log(
				`tracker: #${target} is claimed by session ${result.owner.session} (at ${result.owner.claimedAt}).`,
			)
		: Console.log(`tracker: #${target} is unclaimed.`);

const readBack = Command.make(
	"read-back",
	{target: targetArg},
	Effect.fn(function* ({target}) {
		const result = yield* (yield* Tracker).readBack(target);
		yield* reportReadBack(target, result);
	}),
).pipe(Command.withDescription("Read back and print the current claim owner of a tracker entity"));

export const trackerCommand = Command.make("tracker").pipe(
	Command.withSubcommands([claim, readBack]),
	Command.withDescription(
		"The crew tracker service (ADR 0190): claim a tracker entity + read back its owner",
	),
	Command.provide(GithubTrackerLive),
);
