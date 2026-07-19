/**
 * The `tracker` tool — `pipeline-cli tracker claim <target>` /
 * `pipeline-cli tracker read-back <target>` / `pipeline-cli tracker apply-triage <target>`.
 *
 * The CLI surface of the Wave-1 `Tracker` service (ADR 0190): `claim` posts the ADR-0115
 * agent-distinguishable claim and exits 0 only when the claim is ours; `read-back` resolves
 * and prints the current owner; `apply-triage` applies a type/priority/status classification
 * and drops the entity out of the needs-triage queue (#3263). Judgment-as-parameter: the
 * claiming identity and the classification are supplied, not decided by the tool — the claim
 * session id defaults to `$CLAUDE_CODE_SESSION_ID` (the only agent-distinguishable signal
 * under the shared `usirin` login) and `--session` overrides it for the orchestrated/
 * delegated-token path and for tests; an absent value fails closed.
 *
 * `GithubTrackerLive` is baked in with `Command.provide(...)` so the registered command's
 * residual requirement is the Node platform union (the registry seam, epic #994).
 */
import {Console, Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {
	type ClaimResult,
	GithubTrackerLive,
	type ReadBackResult,
	Tracker,
	type TriageResult,
} from "./tracker.ts";

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

// Judgment-as-parameter (#3252): the classification is supplied, not decided by the tool.
// `--status` defaults to the `triaged` lifecycle stage — the common triage transition.
const typeFlag = Flag.string("type").pipe(
	Flag.withDescription("the domain type classification (e.g. feature, bug, chore)"),
);

const priorityFlag = Flag.string("p").pipe(
	Flag.withDescription("the domain priority (e.g. p0, p1, p2)"),
);

const statusFlag = Flag.string("status").pipe(
	Flag.optional,
	Flag.withDescription("the target lifecycle stage (default: triaged)"),
);

const reportTriage = (target: number, result: TriageResult): Effect.Effect<void> =>
	Console.log(
		`tracker: triaged #${target} — type:${result.type} ${result.priority} status:${result.status}.`,
	);

const applyTriage = Command.make(
	"apply-triage",
	{target: targetArg, type: typeFlag, p: priorityFlag, status: statusFlag},
	Effect.fn(function* ({target, type, p, status}) {
		const result = yield* (yield* Tracker).applyTriage(target, {
			type,
			priority: p,
			status: Option.getOrElse(status, () => "triaged"),
		});
		yield* reportTriage(target, result);
	}),
).pipe(
	Command.withDescription(
		"Apply a triage classification (type / priority / status) to a tracker entity, leaving the needs-triage queue",
	),
);

export const trackerCommand = Command.make("tracker").pipe(
	Command.withSubcommands([claim, readBack, applyTriage]),
	Command.withDescription(
		"The crew tracker service (ADR 0190): claim a tracker entity, read back its owner, apply a triage classification",
	),
	Command.provide(GithubTrackerLive),
);
