/**
 * The `triage` verb group — `fabrika triage <verb>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives
 * in the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * This is the group's foundation slice: the shared exit table (`codes.ts`), the scanned-count
 * convention (`scope.ts`) and the GitHub reads and writes in `../io/issues.ts` land here, ahead of
 * the verbs that consume them. Later slices append their leaves below and add one line each to the
 * `withSubcommands` list at the end of the file, which is why that list is one entry per line.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form
 * silently opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {runApply} from "./apply-verb.ts";
import {DEFAULT_TTL_MINUTES, runClaim} from "./claim-verb.ts";
import {runCodes} from "./codes-verb.ts";
import {runEnrich} from "./enrich-verb.ts";
import {AUDIENCES, PRIORITIES, STANDING_LANES, TYPES} from "./facets.ts";
import {DEFAULT_ROADMAP, runHomes} from "./homes-verb.ts";
import {runKill} from "./kill-verb.ts";
import {runPark} from "./park-verb.ts";
import {runProvenance} from "./provenance-verb.ts";
import {DEFAULT_QUEUE_LABEL, DEFAULT_QUEUE_LIMIT, runQueue} from "./queue-verb.ts";
import {runRepairCriteria} from "./repair-criteria-verb.ts";
import {runSplit} from "./split-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

/**
 * The two flags every verb in this group shares, declared once here.
 *
 * They are not imported from `../report/command.ts`: that module is an adapter, and a group reaching
 * into a sibling group's adapter for a flag couples their `--help` text together. The wording is
 * shared because the contract states it, not because the declaration is.
 */
export const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

export const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

const codes = leafCommand(
	"codes",
	{json: jsonFlag},
	Effect.fn(function* ({json}) {
		yield* emit(runCodes({json}));
	}),
).pipe(
	Command.withShortDescription("Print the exit taxonomy this group allocates from."),
	Command.withDescription(
		"Print the exit taxonomy every verb in this group allocates from, one `<code>\\t<meaning>` line per code. Reads nothing and always exits 0. Example: fabrika triage codes",
	),
);

const kill = leafCommand(
	"kill",
	{
		issue: Argument.integer("issue").pipe(
			Argument.withDescription("the issue to close not-planned"),
		),
		// Optional at the parser and refused at the verb, deliberately: a parser-required flag's
		// absence is a usage error indistinguishable from a typo, and ADR 0159's confirmation is a
		// decision whose absence must be a proven refusal (exit 13).
		confirm: Flag.boolean("confirm").pipe(
			Flag.withDescription(
				"assert that salvage was attempted and this filing is genuinely unsalvageable (ADR 0159); its absence is a refusal on 13, not a usage error",
			),
		),
		duplicateOf: Flag.integer("duplicate-of").pipe(
			Flag.optional,
			Flag.withDescription(
				"the surviving issue; this issue's body is folded into it, leak-redacted, before the close",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, confirm, duplicateOf, repo, json}) {
		yield* emit(
			yield* runKill({
				issue,
				confirm,
				duplicateOf: Option.getOrNull(duplicateOf),
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Close an agent-filed issue not-planned, with a reason."),
	Command.withDescription(
		"Close an agent-filed issue not-planned over four gated writes — the optional redacted duplicate fold, the reason from STDIN, the closed-by-triage label, then the close — and read back that it says not_planned. Prints `killed\\t<number>\\t<foldedInto|none>`. Exits 3 (empty stdin), 5 (machine-local path in the reason), 6 (bare @ reference), 7 (issue absent or closed, duplicate absent or closed, or no closed-by-triage label), 8 (a write failed — UNKNOWN), 9 (read-back is not a not-planned close), 11 (a precondition read failed), 12 (human-filed — no agent footer and no operator author, see $FABRIKA_OPERATOR_ACCOUNTS), 13 (unconfirmed). Example: fabrika triage kill 4312 --confirm --duplicate-of 4290 < reason.md",
	),
);

/**
 * The child body arrives on **stdin only**. There is deliberately no `--body` and no `--body-file`: a
 * flag that takes a path turns the body into a string the verb could post verbatim, which is how a
 * machine-local path reaches a public issue while the poster reads success. A shell redirect is
 * expected — the *shell* reads the file, so what reaches the verb is already bytes.
 */
const split = leafCommand(
	"split",
	{
		parent: Argument.integer("parent").pipe(
			Argument.withDescription("the parent issue this unit is split from"),
		),
		title: Flag.string("title").pipe(
			Flag.withDescription("the child's single-unit title; also half the create-once key"),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({parent, title, repo, json}) {
		yield* emit(
			yield* runSplit({
				parent,
				title,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Create one child of a bundled report, exactly once."),
	Command.withDescription(
		'Create one child of a bundled report from the body on STDIN, exactly once, and cross-link the parent. Prints `<created|reused>\\t<number>\\t<url>`; both outcomes exit 0. Exits 3 (empty stdin), 5 (machine-local path), 6 (bare @ reference), 7 (parent absent, or the queue label does not exist), 8 (create failed — UNKNOWN), 9 (read-back mismatch), 11 (a precondition read failed — never a silent create). Example: fabrika triage split 4312 --title "Editor loses focus after save" < child.md',
	),
);

/**
 * The classification flags are declared as free strings, not as CLI-level enums, so an off-vocabulary
 * value reaches the verb and is refused there on `10` with the message the contract states. A
 * parser-level rejection would seat it on `1`, fusing "you named a priority that does not exist" with
 * "the binary is broken".
 */
const issueArg = Argument.integer("issue").pipe(
	Argument.withDescription("the issue number to stamp"),
);

const apply = leafCommand(
	"apply",
	{
		issue: issueArg,
		type: Flag.string("type").pipe(
			Flag.withDescription(`the issue's type: one of ${TYPES.join(", ")}`),
		),
		priority: Flag.string("priority").pipe(
			Flag.withDescription(`the priority bucket: one of ${PRIORITIES.join(", ")}`),
		),
		readyFor: Flag.string("ready-for").pipe(
			Flag.withDescription(`who picks it up: ${AUDIENCES.join(" or ")}`),
		),
		home: Flag.integer("home").pipe(
			Flag.optional,
			Flag.withDescription("the number of an open milestone to home the issue in"),
		),
		lane: Flag.string("lane").pipe(
			Flag.optional,
			Flag.withDescription(
				`a standing lane instead of a milestone: ${STANDING_LANES.join(" or ")}`,
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, type, priority, readyFor, home, lane, repo, json}) {
		yield* emit(
			yield* runApply({
				issue,
				type,
				priority,
				readyFor,
				home: Option.getOrNull(home),
				lane: Option.getOrNull(lane),
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Stamp the whole triaged transition as one reconcile."),
	Command.withDescription(
		"Stamp the whole triaged transition — type, priority, audience, status and home — as ONE owned-facet reconcile, then read the end state back positively. Exactly one of --home / --lane. Prints `triaged\\t<n>\\t<type>\\t<priority>\\t<ready-for>\\t<home>`. Exits 7 (no such issue, or a label this run would write does not exist), 8 (a write failed — UNKNOWN), 9 (read-back mismatch), 10 (off-vocabulary value, or a non-open milestone), 11 (a precondition read failed), 16 (--ready-for agent over a body with no readable acceptance-criteria block — every type but epic). Example: fabrika triage apply 4312 --type bug --priority p2 --ready-for agent --home 47",
	),
);

const park = leafCommand(
	"park",
	{issue: issueArg, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({issue, repo, json}) {
		yield* emit(
			yield* runPark({
				issue,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Demote an issue to needs-info with the questions on stdin."),
	Command.withDescription(
		"Demote an issue to status:needs-info with the questions on STDIN, clearing every priced facet — type, priority, audience, lane and milestone. The comment is posted BEFORE the labels move. Prints `parked\\t<n>\\t<comment-url>`. Exits 3 (empty stdin), 5 (machine-local path), 6 (bare @ reference), 7 (no such issue, or status:needs-info does not exist), 8 (a write failed — UNKNOWN), 9 (read-back mismatch), 11 (a precondition read failed). Example: fabrika triage park 4290 < questions.md",
	),
);

const claim = leafCommand(
	"claim",
	{
		issue: Argument.integer("issue").pipe(Argument.withDescription("the issue number to claim")),
		ttlMinutes: Flag.integer("ttl-minutes").pipe(
			Flag.withDefault(DEFAULT_TTL_MINUTES),
			Flag.withDescription(
				`how long an existing claim marker stays binding before it is treated as abandoned (default: ${DEFAULT_TTL_MINUTES})`,
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, ttlMinutes, repo, json}) {
		yield* emit(
			yield* runClaim({
				issue,
				ttlMinutes,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Take a session-scoped claim on one issue."),
	Command.withDescription(
		'Take a session-scoped claim on one issue, proven by re-reading the markers back. Prints `won` or `lost\\t<holder-session-id>` — both are proven answers and both exit 0. Exits 1 (CLAUDE_CODE_SESSION_ID unset), 7 (no such issue, or it is closed), 8 (marker POST failed — UNKNOWN), 9 (marker absent on read-back, or a conceded marker could not be deleted), 11 (the issue or its comments could not be read — never "won"). Example: fabrika triage claim 4312',
	),
);

const queue = leafCommand(
	"queue",
	{
		label: Flag.string("label").pipe(
			Flag.withDefault(DEFAULT_QUEUE_LABEL),
			Flag.withDescription(
				`the intake-queue label whose open issues form the queue (default: ${DEFAULT_QUEUE_LABEL})`,
			),
		),
		limit: Flag.integer("limit").pipe(
			Flag.withDefault(DEFAULT_QUEUE_LIMIT),
			Flag.withDescription(`the maximum number of rows to print (default: ${DEFAULT_QUEUE_LIMIT})`),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({label, limit, repo, json}) {
		yield* emit(
			yield* runQueue({
				label,
				limit,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The claimable intake queue, oldest first."),
	Command.withDescription(
		"List the claimable intake queue, oldest first. First stdout line is the outcome token — queued | empty — and a queued list adds one `<number>\\t<age-days>\\t<title>` line per issue; the scanned count is on stderr. Exits 7 (--label does not exist, so the queue would scan nothing), 11 (the queue read failed — UNKNOWN, never `empty`). Example: fabrika triage queue --limit 20",
	),
);

const provenance = leafCommand(
	"provenance",
	{
		issue: Argument.integer("issue").pipe(Argument.withDescription("the issue number to inspect")),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, repo, json}) {
		yield* emit(
			yield* runProvenance({issue, repo: Option.getOrNull(repo), json, env: process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("Whether an issue was reported by an agent or a human."),
	Command.withDescription(
		"Say whether an issue was reported by an agent or typed by a human. Two agent signals: the anchored `Filed by an agent` footer (ADR 0159), or an author in the operator set named by $FABRIKA_OPERATOR_ACCOUNTS — an operator's own filing is agent-reported footer or not (#4619 ruling). Prints `agent` or `human`; with no operator set configured this is the footer-only rule, a footerless non-operator filing answers `human`, an empty body answers `human` fail-closed, an unreadable one refuses. Exits 7 (issue proven absent), 11 (unreadable — the provenance is UNKNOWN, never `human`). Example: fabrika triage provenance 4312",
	),
);

const homes = leafCommand(
	"homes",
	{
		roadmap: Flag.string("roadmap").pipe(
			Flag.withDefault(DEFAULT_ROADMAP),
			Flag.withDescription(
				`the roadmap file whose ## Arcs and ## Campaigns tables the open milestones join to (default: ${DEFAULT_ROADMAP})`,
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({roadmap, repo, json}) {
		yield* emit(yield* runHomes({roadmap, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("The assignable homes: open milestones and standing lanes."),
	Command.withDescription(
		"List the assignable homes: every OPEN milestone joined to its roadmap arc/campaign row by `#<number>`, plus the two standing lanes. First stdout line is `homes`, then one `<kind>\\t<key>\\t<label>` line per candidate. Exits 7 (zero open milestones, or the roadmap parsed to 0 arc rows), 11 (the milestone list or the roadmap could not be read). Example: fabrika triage homes",
	),
);

/**
 * The rewrite — or, with `--epic`, the pitch — arrives on **stdin only**, for `split`'s reason above.
 * `--epic` is a mode on this verb rather than a second verb because both compose the same envelope
 * around the same preserved original; only the authored region above the marker differs.
 */
const enrich = leafCommand(
	"enrich",
	{
		issue: Argument.integer("issue").pipe(Argument.withDescription("the issue to enrich")),
		epic: Flag.boolean("epic").pipe(
			Flag.withDescription(
				"wrap the original under a fixed header and head a pitch above it; stdin carries the pitch's five field lines, not a rewrite",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, epic, repo, json}) {
		yield* emit(
			yield* runEnrich({
				issue,
				epic,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Replace an issue body with the rewrite on stdin."),
	Command.withDescription(
		"Replace an issue body with the rewrite on STDIN above the preserved, leak-redacted original — or with --epic, a pitch above the original under a fixed header. A prior enrichment is recognised by the marker this verb writes, bound to this issue number, so a re-run in EITHER mode replaces the authored region instead of nesting a second envelope. Prints `enriched\\t<number>\\t<redactions>`. Exits 3 (empty stdin), 5 (machine-local path in the authored text), 6 (bare @ reference), 7 (issue absent, or its body is empty — no original to preserve), 8 (the PATCH failed — UNKNOWN), 9 (read-back mismatch), 11 (the issue could not be read). Example: fabrika triage enrich 4312 < enriched.md",
	),
);

const repairCriteria = leafCommand(
	"repair-criteria",
	{
		issue: Argument.integer("issue").pipe(
			Argument.optional,
			Argument.withDescription("the one issue whose drifted heading to repair"),
		),
		sweep: Flag.boolean("sweep").pipe(
			Flag.withDescription(
				"repair every drifted open issue in one run instead of one issue, with a per-issue outcome line",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, sweep, repo, json}) {
		yield* emit(
			yield* runRepairCriteria({
				issue: Option.getOrNull(issue),
				sweep,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Repair a drifted acceptance-criteria heading, mechanically."),
	Command.withDescription(
		'Rewrite a level-drifted "## Acceptance criteria" heading to the conforming "### Acceptance criteria" — authored region only, preserved originals byte-for-byte untouched, the repair pre-verified through the wire read before anything is written. One issue by number, or --sweep for every open issue with one `<repaired|conforming|no-block|refused|moved>\\t<number>` line each; a sweep re-reads each issue immediately before its write and answers `moved` instead of writing when the body changed after the board snapshot. Only a pure level drift on the exact heading text is repaired; every other Malformed answer is refused, never guessed. Exits 7 (issue absent, closed, or a pull request), 8 (the PATCH failed — UNKNOWN), 9 (read-back mismatch), 11 (an issue or the open-issue list could not be read), 14 (not mechanically repairable — the refusal names what it read). Example: fabrika triage repair-criteria 5726',
	),
);

export const triageCommand = Command.make("triage").pipe(
	Command.withSubcommands([
		// One leaf per line, so five in-flight slices append at five distinct lines rather than all
		// editing one. The comment is what keeps the formatter from collapsing the list back.
		codes,
		kill,
		split,
		apply,
		park,
		claim,
		queue,
		provenance,
		homes,
		enrich,
		repairCriteria,
	]),
	Command.withShortDescription("Take one intake-queue issue from arrival to triaged."),
	Command.withDescription(
		"Take one intake-queue issue from arrival to a triaged, homed transition — or park it, split it, or close it not-planned — over reads that page and writes that are read back",
	),
);
