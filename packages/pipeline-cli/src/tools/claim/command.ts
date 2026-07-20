/**
 * The `claim` tool — `pipeline-cli claim is-mine --issue <N> [--session <sid>]`.
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
import type {ClaimVerdict} from "./claim-is-mine.ts";
import {Github, GithubLive} from "./github.ts";

const NOT_MINE_EXIT_CODE = 1;

const issueFlag = Flag.integer("issue").pipe(
	Flag.withDescription("the issue (or PR) number whose claim to resolve"),
);

const sessionFlag = Flag.string("session").pipe(
	Flag.optional,
	Flag.withDescription(
		"the session id to resolve ownership against (default: $CLAUDE_CODE_SESSION_ID); the delegated MY_CLAIM token on the orchestrated path",
	),
);

/** The resolving session id: `--session` if given, else `$CLAUDE_CODE_SESSION_ID`, else null (a default-deny input). */
const resolveSession = (session: Option.Option<string>): string | null => {
	const raw = Option.getOrElse(session, () => process.env.CLAUDE_CODE_SESSION_ID ?? "").trim();
	return raw === "" ? null : raw;
};

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
		process.stderr.write(`claim: ${reasonLine(issue, verdict)}\n`);
		if (!verdict.mine) process.exit(NOT_MINE_EXIT_CODE);
	}),
).pipe(
	Command.withDescription(
		"Resolve whether an issue's earliest authorized claim is mine (exit 0 = mine; non-zero = not-mine, default-deny)",
	),
);

export const claimCommand = Command.make("claim").pipe(
	Command.withSubcommands([isMine]),
	Command.withDescription(
		"Resolve issue-claim ownership (ADR 0115 earliest-authorized-claim) — the default-deny 'is this claim mine' verb",
	),
	Command.provide(GithubLive),
);
