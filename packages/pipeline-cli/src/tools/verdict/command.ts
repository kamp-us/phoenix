/**
 * The `verdict` tool — `pipeline-cli verdict read` / `post` / `validate`.
 *
 * The ADR-0058 SHA-bound verdict read/post glue, extracted from the inline `jq` the
 * `review-*` / `ship-it` / `write-code`-repair / `heal-ci` skills each hand-rolled (#2102).
 *
 * `read --pr N --gate <g> [--expect PASS|FAIL] [--head <sha>]` resolves the (PR, gate)
 * verdict against the PR's current head (author-gated to write+ collaborators, ADR 0055) and
 * **exits 0 only when HEAD is reviewed with the expected polarity** (default PASS) — every
 * refusal (`none`/`sha-less`/`stale`, or a current verdict of the wrong polarity) prints its
 * reason on stderr and exits non-zero, so a caller branches on exit status. The resolved
 * outcome is printed as JSON on stdout for a caller that wants the detail (comment id, sha).
 *
 * `post --pr N --gate <g> [--body-file <f>]` upserts a SHA-bound verdict comment (ADR 0058
 * rule 2): it reads the composed verdict body from `--body-file` (or stdin), refuses fail-closed
 * on any `emissionDefect` (wrong namespace, unbindable `@ <sha>`, or a non-full-40-hex/path-glued
 * SHA field), then PATCHes our own prior marker in the namespace if one exists, else POSTs —
 * exactly one verdict comment per (PR, gate). It prints `patched <id>` / `posted <id>` on stdout.
 *
 * `validate --gate <g> [--body-file <f>]` runs that same `emissionDefect` gate WITHOUT posting —
 * the read-back assertion an emit path (review-code's native `APPROVE`) runs before a channel
 * `post` can't guard, exiting non-zero on a malformed marker (the mktemp-path leak, #2683).
 *
 * `GithubLive` is baked in with `Command.provide(...)` so the registered command's residual
 * requirement is the Node platform union (the registry seam, epic #994).
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
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
		// The resolved detail goes to stdout as JSON (a caller may want the comment id / bound sha);
		// the human-readable verdict + refusal reason goes to stderr, mirroring resume-policy.
		yield* Console.log(JSON.stringify({...result.outcome, headSha: result.headSha, gate: g}));
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

const readBody = (bodyFile: Option.Option<string>): Effect.Effect<string, never> =>
	Effect.sync(() =>
		Option.match(bodyFile, {
			onNone: () => readFileSync(0, "utf8"),
			onSome: (path) => readFileSync(path, "utf8"),
		}),
	);

const post = Command.make(
	"post",
	{pr: prFlag, gate: gateFlag, bodyFile: bodyFileFlag},
	Effect.fn(function* ({pr, gate, bodyFile}) {
		const g = yield* parseGate(gate);
		const body = (yield* readBody(bodyFile)).replace(/\s+$/, "");
		if (body.length === 0) {
			return yield* fail(
				"empty verdict body — nothing to post (pass --body-file or pipe the body on stdin)",
			);
		}
		const result = yield* (yield* Github)
			.post(pr, g, body)
			.pipe(Effect.catchTag("@kampus/verdict/VerdictInputError", (error) => fail(error.message)));
		yield* Console.log(`${result._tag} ${result.commentId}`);
	}),
).pipe(
	Command.withDescription(
		"Upsert a SHA-bound verdict comment for a PR gate (PATCH own prior marker, else POST — one per gate, ADR 0058 rule 2)",
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
	Command.withSubcommands([read, post, validate]),
	Command.withDescription(
		"Read/post ADR-0058 SHA-bound gate verdicts (review-code/doc/skill/design) — the shared verdict-match glue",
	),
	Command.provide(GithubLive),
);
