/**
 * The `verdict` tool — `pipeline-cli verdict read` / `gate` / `post` / `validate`.
 *
 * The ADR-0058 SHA-bound verdict read/post glue, extracted from the inline `jq` the
 * `review-*` / `ship-it` / `write-code`-repair / `heal-ci` skills each hand-rolled (#2102).
 *
 * `read --pr N --gate <g> [--expect PASS|FAIL] [--head <sha>]` resolves the (PR, gate)
 * verdict against the PR's current head (author-gated to write+ collaborators, ADR 0055) and
 * **exits 0 only when HEAD is reviewed with the expected polarity** (default PASS) — every
 * refusal (`none`/`sha-less`/`stale`, or a current verdict of the wrong polarity) prints its
 * reason on stderr and exits non-zero, so a caller branches on exit status. The resolved
 * outcome is printed as JSON on stdout for a caller that wants the detail (comment id, sha, and
 * `writtenAt` — when the resolving verdict was WRITTEN, which is what a skill's review-vs-marker
 * fold must compare against a review's `submitted_at`, never the comment's `created_at`, #4200).
 *
 * `gate --pr N --require <namespaces> [--cp]` is the SET-level counterpart `read` cannot be: it
 * folds the same resolution over EVERY namespace the diff requires and exits 0 only when each one
 * carries a current-head pass, so a namespace with no verdict at all is a named refusal instead of
 * an unnoticed gap (#3982 — PR #3944 enqueued with nothing bound to its live head). On a §CP PR
 * (`--cp`) the pass is the canonical SHA-less advisory bound by its body `Reviewed-head` line, never
 * a bindable first-line PASS (ADR 0111/0151).
 *
 * `post --pr N --gate <g> [--body-file <f>] [--run-id <id>]` upserts a SHA-bound verdict comment
 * (ADR 0058 rule 2 as refined by ADR 0213): it reads the composed verdict body from `--body-file`
 * (or stdin), refuses fail-closed
 * on any `emissionDefect` (wrong namespace, unbindable `@ <sha>`, or a non-full-40-hex/path-glued
 * SHA field), then PATCHes the prior marker THIS RUN posted in the namespace AT THIS HEAD if one
 * exists, else POSTs — one verdict comment per (PR, gate, run, head).
 *
 * The upsert-vs-append semantics in one line: **a re-post at the same head upserts (a correction of
 * the same fact); anything else appends.** So re-gating a PR at a NEW head leaves the prior head's
 * verdict intact, and no reviewer has to hand-roll a marker to preserve the record (#4007).
 * The run dimension (`--run-id`, defaulting to `$CLAUDE_CODE_SESSION_ID`) is
 * what keeps a concurrent reviewer sharing our GitHub login from overwriting our verdict (#4016);
 * with no run id the post appends rather than upserts. It then re-fetches the landed comment and re-runs
 * `emissionDefect` on its body (the folded-in self-verify, #3019), failing non-zero if the marker
 * didn't land clean rather than reporting a false success. It prints `patched <id>` / `posted <id>`.
 *
 * `validate --gate <g> [--body-file <f>]` runs that same `emissionDefect` gate WITHOUT posting —
 * the read-back assertion an emit path (review-code's native `APPROVE`) runs before a channel
 * `post` can't guard, exiting non-zero on a malformed marker (the mktemp-path leak, #2683).
 *
 * `GithubLive` is baked in with `Command.provide(...)` so the registered command's residual
 * requirement is the Node platform union (the registry seam, epic #994).
 */
import {Console, Effect, FileSystem, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {readStdinTextOrExit} from "../../read-stdin.ts";
import {Github, GithubLive} from "./github.ts";
import {
	emissionDefect,
	GATES,
	outcomeReason,
	type Polarity,
	type VerdictGate,
} from "./verdict-match.ts";

const FAIL_EXIT_CODE = 1;

const prFlag = Flag.integer("pr").pipe(Flag.withDescription("the pull request number"));

const gateFlag = Flag.string("gate").pipe(
	Flag.withDescription(`the gate namespace: one of ${GATES.join(" | ")} (review-<gate>)`),
);

const headFlag = Flag.string("head").pipe(
	Flag.optional,
	Flag.withDescription(
		"override the head SHA to bind against (default: the PR's current head via REST)",
	),
);

const expectFlag = Flag.string("expect").pipe(
	Flag.optional,
	Flag.withDescription("the polarity a `read` treats as satisfied: PASS (default) or FAIL"),
);

const runIdFlag = Flag.string("run-id").pipe(
	Flag.optional,
	Flag.withDescription(
		"the posting run's identity, the upsert key's run dimension (default: $CLAUDE_CODE_SESSION_ID; absent ⇒ append, never overwrite another run's verdict)",
	),
);

const bodyFileFlag = Flag.string("body-file").pipe(
	Flag.optional,
	Flag.withDescription("path to the composed verdict body (default: read the body from stdin)"),
);

/** Print `reason` on stderr and exit non-zero — the "not satisfied / bad input" signal a caller branches on. */
const fail = (reason: string): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`verdict: ${reason}\n`);
		process.exit(FAIL_EXIT_CODE);
	});

const parseGate = (raw: string): Effect.Effect<VerdictGate, never> => {
	const gate = raw.trim().toLowerCase();
	return (GATES as ReadonlyArray<string>).includes(gate)
		? Effect.succeed(gate as VerdictGate)
		: fail(`unknown gate '${raw}' — expected one of ${GATES.join(" | ")}`);
};

const parseExpect = (raw: Option.Option<string>): Effect.Effect<Polarity, never> => {
	const value = Option.getOrElse(raw, () => "PASS")
		.trim()
		.toUpperCase();
	if (value === "PASS" || value === "FAIL") return Effect.succeed(value);
	return fail(`invalid --expect '${Option.getOrElse(raw, () => "")}' — expected PASS or FAIL`);
};

const read = Command.make(
	"read",
	{pr: prFlag, gate: gateFlag, head: headFlag, expect: expectFlag},
	Effect.fn(function* ({pr, gate, head, expect}) {
		const g = yield* parseGate(gate);
		const polarity = yield* parseExpect(expect);
		const result = yield* (yield* Github).read(pr, g, polarity, Option.getOrUndefined(head));
		// The resolved detail goes to stdout as JSON (a caller may want the comment id / bound sha /
		// write time); the human-readable verdict + refusal reason goes to stderr, mirroring resume-policy.
		yield* Console.log(
			JSON.stringify({
				...result.outcome,
				headSha: result.headSha,
				gate: g,
				writtenAt: result.writtenAt,
			}),
		);
		if (result.satisfied) {
			process.stderr.write(`verdict: ${outcomeReason(result.outcome, polarity)}\n`);
			return;
		}
		return yield* fail(outcomeReason(result.outcome, polarity));
	}),
).pipe(
	Command.withDescription(
		"Resolve a PR's SHA-bound gate verdict against its current head (exit 0 = reviewed with --expect polarity)",
	),
);

/**
 * Deliberately REQUIRED, not stdin-defaulted: the required-namespace set is the load-bearing input,
 * and a piped set that arrives empty (a dropped/undelivered stdin) is indistinguishable from "this
 * PR needs no gates" — the #3786 zero-input class. An explicit flag makes the omission a usage
 * error instead, and an explicitly-empty value still refuses on zero scope below.
 */
const requireFlag = Flag.string("require").pipe(
	Flag.withDescription(
		"the required review namespaces, comma/space separated (`review-code,review-doc` or `code,doc`) — derive with `pipeline-cli class-probe classify --namespaces`",
	),
);

const cpFlag = Flag.boolean("cp").pipe(
	Flag.withDescription(
		"this is a §CP (control-plane / blocking-set) PR: accept the canonical SHA-less advisory + body `Reviewed-head` as the pass (ADR 0111/0151)",
	),
);

/**
 * Parse the required-namespace set, tolerating both shapes the producer emits: the
 * `class-probe classify --namespaces` output (`review-code`) and a bare gate name (`code`). An
 * unrecognized token is a hard input error, never a silently-dropped requirement — dropping one
 * would shrink the conjunction, the exact fail-open this verb exists to prevent.
 */
const parseRequired = (raw: string): Effect.Effect<ReadonlyArray<VerdictGate>, never> => {
	const tokens = raw
		.split(/[\s,]+/)
		.map((t) => t.trim().toLowerCase())
		.filter((t) => t.length > 0);
	const gates: VerdictGate[] = [];
	for (const token of tokens) {
		const name = token.startsWith("review-") ? token.slice("review-".length) : token;
		if (!(GATES as ReadonlyArray<string>).includes(name)) {
			return fail(
				`unrecognized required namespace '${token}' — expected review-<gate> or <gate>, one of ${GATES.join(" | ")}. Refusing to drop it from the required set (that would shrink the gate conjunction).`,
			);
		}
		gates.push(name as VerdictGate);
	}
	return Effect.succeed(gates);
};

/**
 * `gate --pr N --require <namespaces> [--cp] [--head <sha>]` — the merge authority's structural
 * enqueue check (#3982). Exit 0 **only** when EVERY required namespace carries a verdict that is
 * affirmatively read, bound to the PR's live head, and a pass; every other state — including "no
 * verdict found at all", the hole PR #3944 enqueued through — exits non-zero with the named reason.
 *
 * This is deliberately not expressible as N × `verdict read`: absence is a property of the required
 * SET, so it can only be decided where the set is known. `--require` takes the same set
 * `class-probe classify --namespaces` derives, so a PR spanning an ADR plus a `.glossary/**` row
 * (which rides has-code) needs BOTH review-doc and review-code, not either.
 */
const gate = Command.make(
	"gate",
	{pr: prFlag, require: requireFlag, cp: cpFlag, head: headFlag},
	Effect.fn(function* ({pr, require: required, cp, head}) {
		const requiredGates = yield* parseRequired(required);
		const decision = yield* (yield* Github).gate(
			pr,
			requiredGates,
			cp,
			Option.getOrUndefined(head),
		);
		// The full per-namespace decision goes to stdout as JSON (a caller may want to name which
		// namespace blocked); the single named outcome line goes to stderr, mirroring `read`.
		yield* Console.log(JSON.stringify(decision));
		if (decision.enqueueable) {
			process.stderr.write(`verdict gate: ${decision.reason}\n`);
			return;
		}
		return yield* fail(decision.reason);
	}),
).pipe(
	Command.withDescription(
		"Assert EVERY required review namespace carries a current-head pass before an enqueue (exit 0 = enqueueable) — the fail-closed absence check (#3982)",
	),
);

/**
 * Read the composed verdict body: from `--body-file` over the `FileSystem` seam, else from
 * stdin through the shared fail-closed reader, which exits non-zero on a failed read rather
 * than reporting an unread body as the empty one below (#3924). An unreadable `--body-file`
 * stays a defect (`Effect.orDie`), preserving the pre-migration crash-out.
 */
const readBody = Effect.fn(function* (bodyFile: Option.Option<string>) {
	if (Option.isNone(bodyFile)) return yield* readStdinTextOrExit();
	const fs = yield* FileSystem.FileSystem;
	return yield* Effect.orDie(fs.readFileString(bodyFile.value));
});

const post = Command.make(
	"post",
	{pr: prFlag, gate: gateFlag, bodyFile: bodyFileFlag, runId: runIdFlag},
	Effect.fn(function* ({pr, gate, bodyFile, runId}) {
		const g = yield* parseGate(gate);
		const body = (yield* readBody(bodyFile)).replace(/\s+$/, "");
		if (body.length === 0) {
			return yield* fail(
				"empty verdict body — nothing to post (pass --body-file or pipe the body on stdin)",
			);
		}
		// The posting run's identity, defaulted from the agent runtime's per-run session id — the
		// dimension the shared `usirin` login cannot supply (#4016, the same token ADR 0115 claims
		// under). Absent ⇒ this post appends instead of upserting; it never overwrites blind.
		const run = Option.getOrUndefined(runId) ?? process.env.CLAUDE_CODE_SESSION_ID;
		const result = yield* (yield* Github).post(pr, g, body, run).pipe(
			Effect.catchTag("@kampus/verdict/VerdictInputError", (error) => fail(error.message)),
			// The post-time head cross-check (#3801): a well-formed body bound to a DIFFERENT PR's head
			// (a cross-PR scratchpad clobber, or a stale/rebased binding) is refused before it lands.
			Effect.catchTag("@kampus/verdict/VerdictHeadMismatchError", (error) => fail(error.message)),
			// The landed-comment self-verify (#3019): a body that passed the input gate but did not
			// land as a clean in-namespace, leak-free marker fails the post — never a false success.
			Effect.catchTag("@kampus/verdict/VerdictVerifyError", (error) => fail(error.message)),
		);
		yield* Console.log(`${result._tag} ${result.commentId}`);
	}),
).pipe(
	Command.withDescription(
		"Upsert a SHA-bound verdict comment for a PR gate (PATCH this run's own prior marker AT THIS HEAD, else POST — one per (gate, run, head): a re-post at the same head upserts, a re-gate at a new head appends and leaves the prior head's verdict intact; ADR 0058 rule 2 + ADR 0213, #4007)",
	),
);

/**
 * `validate --gate <g> [--body-file <f>]` — the read-back assertion a marker-emit path runs on a
 * composed body BEFORE posting it through a channel `post` can't guard (review-code's native
 * `APPROVE` review). It runs the SAME `emissionDefect` gate `post` enforces and exits non-zero on
 * any defect — so a malformed `@ <sha>` (the mktemp-path leak, #2683) fails loud at emission rather
 * than landing in a public comment. Does no IO: pure body-shape validation, so it needs no `Github`.
 */
const validate = Command.make(
	"validate",
	{gate: gateFlag, bodyFile: bodyFileFlag},
	Effect.fn(function* ({gate, bodyFile}) {
		const g = yield* parseGate(gate);
		const body = (yield* readBody(bodyFile)).replace(/\s+$/, "");
		if (body.length === 0) {
			return yield* fail(
				"empty verdict body — nothing to validate (pass --body-file or pipe on stdin)",
			);
		}
		const defect = emissionDefect(body, g);
		if (defect !== null) return yield* fail(defect);
		yield* Console.log("ok");
	}),
).pipe(
	Command.withDescription(
		"Assert a composed verdict body is postable (clean full-40-hex @ <sha>, right namespace) — exit 0 = ok, non-zero = malformed",
	),
);

export const verdictCommand = Command.make("verdict").pipe(
	Command.withSubcommands([read, gate, post, validate]),
	Command.withDescription(
		"Read/post ADR-0058 SHA-bound gate verdicts (review-code/doc/skill/design), and gate an enqueue on a current-head pass in EVERY required namespace",
	),
	Command.provide(GithubLive),
);
