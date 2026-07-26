/**
 * The `claim` tool — `pipeline-cli claim is-mine|release|status|audit`.
 *
 * The issue-scoped "is this claim mine?" resolver (#3687): resolve the earliest
 * authorized claim on an arbitrary issue (ADR 0115 §2 / gh-issue-intake-formats.md
 * §7) and decide whether it is ours — the decision `write-code`'s Step-3.5
 * mis-attribution guard and the orchestrator's pre-spawn check each hand-rolled
 * inline. The pure resolution core is epic-lock's `resolveClaim`, reused, not copied;
 * this verb adds the **default-deny** projection over it (`claim-is-mine.ts`).
 *
 * `is-mine` **exits 0 only when the earliest authorized claim is ours** — every
 * un-resolvable outcome (no authorized claim, a foreign owner, a missing session id)
 * prints its reason on stderr and **exits non-zero**, so a caller branches on exit
 * status (`pipeline-cli claim is-mine --issue N && <mutate>`) and backs off fail-safe
 * toward the expensive-but-correct path (the #3250 license) rather than parsing
 * prose. The resolved verdict is printed as JSON on stdout for a caller that wants
 * the detail (the resolved owner, the outcome reason).
 *
 * `release` is the other end of the same claim's life (#3780): a finished run retracts its
 * **own** marker so the lane stops reading `lost` forever. It is affirmative — the owner gives
 * the claim up — never inferred from staleness, so it can retract only markers carrying the
 * token the caller presents and leaves every other claim standing. `status` is the read-only
 * inventory (every marker, its authorization, its ADR-0191 liveness, the resolved owner) — the
 * surface that makes a claim no release ever retracted visible instead of silently stranding a
 * lane. Neither verb evicts a claim it cannot prove is ours.
 *
 * `audit` closes the one lifetime hole neither can reach (#4031): a marker written before every
 * writer stamped presence (#3987) carries nothing for ADR 0191 liveness to evaluate, so it holds
 * its lane forever and re-claiming cannot help. It names that bounded population across the open
 * issues and, under `--execute`, retires each member through `release` under the marker's own
 * token — reusing the one retraction mechanism rather than growing a second. The resolution rule
 * is untouched: a stamped claim is never a candidate, whatever its age (`claim-audit.ts`).
 *
 * The session id defaults to `$CLAUDE_CODE_SESSION_ID` (the only agent-distinguishable
 * signal under the shared `usirin` login); `--session` overrides it for the
 * orchestrated/delegated-token path (`MY_CLAIM`) and for tests. An absent session id
 * is itself a default-deny outcome — not-mine — never a false win.
 *
 * `GithubLive` is baked in with `Command.provide(...)` so the registered command's
 * residual requirement is the Node platform union (the registry seam, epic #994).
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {DEFAULT_MIN_AGE_HOURS, type LockedLane, STAMPING_CUTOFF} from "./claim-audit.ts";
import type {ClaimVerdict} from "./claim-is-mine.ts";
import {Github, GithubLive} from "./github.ts";

/** Both refusals — `is-mine` not-mine and `release` with no provable token — exit non-zero. */
const REFUSE_EXIT_CODE = 1;

const issueFlag = Flag.integer("issue").pipe(
	Flag.withDescription("the issue (or PR) number whose claim to resolve"),
);

const sessionFlag = Flag.string("session").pipe(
	Flag.optional,
	Flag.withDescription(
		"the session id to act under (default: $CLAUDE_CODE_SESSION_ID); the delegated MY_CLAIM token on the orchestrated path, and — for `release` — the token the claim was POSTED under, which a session-id rotation (#4045) leaves unchanged on the marker",
	),
);

/** The resolving session id: `--session` if given, else `$CLAUDE_CODE_SESSION_ID`, else null (a default-deny input). */
const resolveSession = (session: Option.Option<string>): string | null => {
	const raw = Option.getOrElse(session, () => process.env.CLAUDE_CODE_SESSION_ID ?? "").trim();
	return raw === "" ? null : raw;
};

/**
 * The superseded-claims note appended to the reason line: naming the dead claimants that dropped
 * out of the tiebreak is what makes "why is a later claim the owner?" answerable from the log.
 */
const supersededNote = (verdict: ClaimVerdict): string =>
	verdict.superseded.length === 0
		? ""
		: ` (superseded ${verdict.superseded.length} dead-claimant claim(s): ${verdict.superseded
				.map((claim) => claim.session)
				.join(", ")} — ADR 0191 presence liveness)`;

/** The stderr reason line for a resolved verdict — the human-readable "why" a caller logs. */
const reasonLine = (issue: number, verdict: ClaimVerdict): string => {
	switch (verdict.reason) {
		case "won":
			return `#${issue}: earliest authorized claim is mine (${verdict.winner?.session}) — proceeding.`;
		case "lost":
			return `#${issue}: claimed by another agent (earliest authorized claim ${verdict.winner?.session}) — NOT mine, back off.`;
		case "no-winner":
			return `#${issue}: no authorized claim resolves — NOT mine, back off (default-deny, never a false win).`;
		case "no-session":
			return `#${issue}: no session id to resolve ownership under (CLAUDE_CODE_SESSION_ID absent and no --session) — NOT mine, back off (default-deny).`;
	}
};

const isMine = Command.make(
	"is-mine",
	{issue: issueFlag, session: sessionFlag},
	Effect.fn(function* ({issue, session}) {
		const sessionId = resolveSession(session);
		const verdict = yield* (yield* Github).isMine(issue, sessionId);
		// The resolved detail goes to stdout as JSON (a caller may want the owner / reason);
		// the human-readable verdict + back-off reason goes to stderr, mirroring verdict/epic-lock.
		yield* Console.log(JSON.stringify({issue, ...verdict}));
		process.stderr.write(`claim: ${reasonLine(issue, verdict)}${supersededNote(verdict)}\n`);
		if (!verdict.mine) process.exit(REFUSE_EXIT_CODE);
	}),
).pipe(
	Command.withDescription(
		"Resolve whether an issue's earliest authorized claim is mine (exit 0 = mine; non-zero = not-mine, default-deny)",
	),
);

const release = Command.make(
	"release",
	{issue: issueFlag, session: sessionFlag},
	Effect.fn(function* ({issue, session}) {
		const sessionId = resolveSession(session);
		if (sessionId === null) {
			// Fail closed, loudly: with no token we cannot prove which marker is ours, and a release
			// that guessed would be an eviction. Exiting non-zero (rather than no-op'ing quietly) is
			// what makes a leaked claim a routed blocker instead of a silently stranded lane.
			process.stderr.write(
				`claim: #${issue}: no session id to release under (CLAUDE_CODE_SESSION_ID absent and no --session) — refusing to retract a claim we cannot prove is ours. Re-run with --session <the token the claim was posted under>.\n`,
			);
			process.exit(REFUSE_EXIT_CODE);
			return;
		}
		const plan = yield* (yield* Github).release(issue, sessionId);
		yield* Console.log(JSON.stringify({issue, session: sessionId, ...plan}));
		process.stderr.write(
			`claim: #${issue}: released — retracted ${plan.retract.length} own claim comment(s)` +
				(plan.kept.length === 0
					? "; no other claim remains."
					: `; left ${plan.kept.length} claim(s) by other sessions standing (${plan.kept
							.map((claim) => claim.session)
							.join(", ")}) — release never evicts a claim that is not ours.`) +
				"\n",
		);
	}),
).pipe(
	Command.withDescription(
		"Retract our OWN claim comment(s) on an issue when the run is done (affirmative release; never evicts another session's claim)",
	),
);

const status = Command.make(
	"status",
	{issue: issueFlag},
	Effect.fn(function* ({issue}) {
		const report = yield* (yield* Github).status(issue);
		yield* Console.log(JSON.stringify({issue, ...report}));
		process.stderr.write(
			`claim: #${issue}: ${report.claims.length} claim marker(s); owner ${
				report.owner?.session ?? "(none — the lane is claimable)"
			}. A claim reading liveness=unknown is INDETERMINATE and stands; clearing one is a human's call.\n`,
		);
	}),
).pipe(
	Command.withDescription(
		"Print an issue's claim inventory — every marker, its authorization, its ADR-0191 liveness, and the resolved owner (read-only)",
	),
);

const auditIssueFlag = Flag.integer("issue").pipe(
	Flag.optional,
	Flag.withDescription(
		"audit this one lane instead of scanning every open issue (the cheap path when a stall is already known)",
	),
);

const executeFlag = Flag.boolean("execute").pipe(
	Flag.withDescription(
		"retire the retirable markers through `claim release` (default: dry-run, report only)",
	),
);

const minAgeFlag = Flag.integer("min-age-hours").pipe(
	Flag.withDefault(DEFAULT_MIN_AGE_HOURS),
	Flag.withDescription(
		"how old a pre-cutoff marker must be before retirement will touch it — lower it for a claimant you have confirmed is gone, never to widen a bulk sweep",
	),
);

const cutoffFlag = Flag.string("cutoff").pipe(
	Flag.withDefault(STAMPING_CUTOFF),
	Flag.withDescription(
		"ISO-8601 UTC instant after which every claim writer stamps presence (default: this repo's stamping era)",
	),
);

/** One report row: the lane, the marker holding it, its disposition, and what it is shadowing. */
const laneLine = (lane: LockedLane): string =>
	`  #${lane.issue}\t${lane.disposition === "retire" ? "RETIRE" : "hold  "}\t${lane.reason}\t` +
	`marker ${lane.owner.id} (${lane.owner.session}, ${lane.owner.createdAt})` +
	(lane.shadowed.length === 0 ? "" : `\tshadowing ${lane.shadowed.length} later claim(s)`);

const audit = Command.make(
	"audit",
	{issue: auditIssueFlag, execute: executeFlag, minAgeHours: minAgeFlag, cutoff: cutoffFlag},
	Effect.fn(function* ({issue, execute, minAgeHours, cutoff}) {
		const scoped = Option.getOrNull(issue);
		const {report, retired} = yield* (yield* Github).audit({
			issues: scoped === null ? null : [scoped],
			policy: {cutoff, minAgeMs: minAgeHours * 60 * 60 * 1000, now: new Date().toISOString()},
			execute,
		});
		yield* Console.log(
			JSON.stringify({cutoff, minAgeHours, executed: execute, ...report, retired}),
		);
		if (report.scanned === 0) {
			// Fail closed on an empty scan (ADR 0092): "no lane is locked" and "the scan read nothing"
			// are the same output otherwise, and the second is a broken read reported as a clean bill.
			process.stderr.write(
				"claim: audit scanned ZERO lanes — refusing to report a clean audit off an empty scan. Check `gh` auth and the resolved repo.\n",
			);
			process.exit(REFUSE_EXIT_CODE);
			return;
		}
		for (const lane of report.locked) process.stderr.write(`${laneLine(lane)}\n`);
		process.stderr.write(
			`claim: audit scanned ${report.scanned} lane(s): ${report.locked.length} held by an unstamped marker, ` +
				`${report.retirable.length} retirable (pre-stamping, aged past ${minAgeHours}h). ` +
				(execute
					? `Retired ${retired.length} through \`claim release\`.\n`
					: "Dry run — re-run with --execute to retire them.\n"),
		);
	}),
).pipe(
	Command.withDescription(
		"Audit open lanes for pre-stamping claim markers no liveness can supersede, and retire the bounded legacy population through `claim release`",
	),
);

export const claimCommand = Command.make("claim").pipe(
	Command.withSubcommands([isMine, release, status, audit]),
	Command.withDescription(
		"Resolve, release, and inspect issue claims (ADR 0115 earliest-authorized-claim): default-deny 'is this mine', affirmative self-release, the stale-claim inventory, and the pre-stamping legacy audit",
	),
	Command.provide(GithubLive),
);
