/**
 * The `review` verb group — `fabrika review <verb>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives in
 * the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */
import {tmpdir} from "node:os";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {CAP_ROUND} from "../retry-budget.ts";
import {runAppendCriterion} from "./append-criterion-verb.ts";
import {runCi} from "./ci-verb.ts";
import {runCriteria} from "./criteria-verb.ts";
import {runDeviations} from "./deviations-verb.ts";
import {runDiff} from "./diff-verb.ts";
import {runPost} from "./post-verb.ts";
import {runScope} from "./scope-verb.ts";
import {runScratch} from "./scratch-verb.ts";
import {runVerdicts} from "./verdicts-verb.ts";

/**
 * The two flags every verb in this group shares, declared once here.
 *
 * They are not imported from a sibling group's adapter: that would couple two groups' `--help` text
 * together. The wording is shared because the contract states it, not because the declaration is.
 */
const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the full result object on stdout instead of the line grammar"),
);

const prArg = Argument.integer("pr").pipe(
	Argument.withDescription("the pull-request number to read"),
);

/**
 * The read verbs' `--sha`: the head the caller scoped, asserted so the answer's provenance is the
 * caller's claim and not whatever the endpoint happened to serve. Omitted, the verb binds to the
 * PR's live head — which is still read out of the object database, so the answer names its commit
 * either way.
 */
const boundShaFlag = Flag.string("sha").pipe(
	Flag.optional,
	Flag.withDescription(
		"the head to read the artifact at (default: the PR's live head); the verb reads it out of the object database and refuses when it is not the PR's head",
	),
);

const scope = leafCommand(
	"scope",
	{pr: prArg, sha: boundShaFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(
			yield* runScope({
				pr,
				sha: Option.getOrNull(sha),
				repo: Option.getOrNull(repo),
				json,
				cwd: process.cwd(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("A PR's artifact classes, head, issue, flags and governance need."),
	Command.withDescription(
		"Partition a PR's changed files into the code / doc / skill artifact classes and report its head SHA, linked issue, self / harness flags and whether the diff requires the governance namespace. The file list is read out of the object database at the bound commit, so the printed head and the partitioned files are the same tree. First stdout line is `scoped\\t<head-sha>\\t<fixes:n|part-of:n|->` — the same issue-reference token `ship scope` prints, so a `Part of #N` partial split reads as linked here too. Then one `class\\t<name>\\t<files>` line per present class, the two flag lines, and `governance\\t<required|not-required>` — the same derivation `governance scope` prints, over this repo's `governedRoots` rather than a hardcoded list: five roots by default, `.decisions/` and `.fabrika.jsonc` as well as the three `harness` roots; the bound commit and the scanned count are on stderr. Exits 7 (PR absent, closed, or zero changed files — ADR 0092), 10 (--sha is not a head SHA), 11 (the PR could not be read, or the commit could not be bound — the scope is UNKNOWN), 12 (--sha is not the PR's head — re-scope, never re-bind), 13 (the commit carries fewer files than the PR declares). Example: fabrika review scope 4321 --sha 03135b91",
	),
);

const diff = leafCommand(
	"diff",
	{pr: prArg, sha: boundShaFlag, repo: repoFlag},
	Effect.fn(function* ({pr, sha, repo}) {
		yield* emit(
			yield* runDiff({
				pr,
				sha: Option.getOrNull(sha),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Serve a PR's unified diff at the bound commit."),
	Command.withDescription(
		"Serve a PR's unified diff bytes on stdout, read out of the object database at the bound commit and refusing a truncated one rather than passing it through as the whole. Nothing is checked out. No --json: the diff is the object. Exits 7 (PR absent, closed, or zero changed files), 10 (--sha is not a head SHA), 11 (the diff could not be read, or the commit could not be bound — UNKNOWN), 12 (--sha is not the PR's head — re-review, never re-bind), 13 (the diff carries fewer files than the PR declares). Example: fabrika review diff 4321 --sha 03135b91",
	),
);

const criteria = leafCommand(
	"criteria",
	{
		issue: Argument.integer("issue").pipe(
			Argument.withDescription("the issue carrying the acceptance-criteria block"),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, repo, json}) {
		yield* emit(yield* runCriteria({issue, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Read an issue's acceptance-criteria block."),
	Command.withDescription(
		"Read an issue's acceptance-criteria block through the registered `acceptance-criteria` wire format — no second parser. First stdout line is `criteria\\t<count>`, then one `<checked|open>\\t<text>` line per criterion. A closed issue is read anyway, with a notice on stderr. Exits 7 (issue absent, or the block is proven absent or malformed — the two are distinguished on stderr, never invented around), 11 (the issue could not be read — whether a block exists is UNKNOWN). Example: fabrika review criteria 4287",
	),
);

const ci = leafCommand(
	"ci",
	{
		pr: prArg,
		sha: Flag.string("sha").pipe(
			Flag.optional,
			Flag.withDescription(
				"the head to enumerate check runs at (default: the PR's live head); give the inspected head so the answer binds to what is being judged",
			),
		),
		wait: Flag.boolean("wait").pipe(
			Flag.withDescription(
				"poll a `pending` head until CI concludes or the budget expires, instead of answering with this moment's read",
			),
		),
		budgetSeconds: Flag.integer("budget-seconds").pipe(
			Flag.withDefault(600),
			Flag.withDescription("--wait only: total wall-clock budget, gh-call latency included"),
		),
		cadenceSeconds: Flag.integer("cadence-seconds").pipe(
			Flag.withDefault(30),
			Flag.withDescription("--wait only: sleep between polls"),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({pr, sha, wait, budgetSeconds, cadenceSeconds, repo, json}) {
		yield* emit(
			yield* runCi({
				pr,
				sha: Option.getOrNull(sha),
				wait,
				budgetSeconds,
				cadenceSeconds,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				cwd: process.cwd(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Roll up a head's check runs, fail-closed; --wait waits out a pending.",
	),
	Command.withDescription(
		'Enumerate the live check runs at a head and roll them up green / red / pending, fail-closed on the ambiguous rows — a cancelled or unrecognised conclusion is red, never green. First stdout line is `ci\\t<sha>\\t<rollup>`, then `run\\t<count>` and one `check\\t<status>\\t<count>` line per status present — a status tally under ADR 0308, with the failing and still-running runs named on stderr. An empty enumeration asks whether the repo produces CI at all: with zero workflows it refuses, unless `.fabrika.jsonc` declares `ci.noProducer: "degrade"`, which rolls up `no-producer` — never green. A rollup that is not red then asks which gates ran: with at least one run from a workflow this repo authors, the covered-of-declared count is on stderr (and `gates` under `--json`); with none it refuses on 16; a repo that authors no workflow of its own has no gate to have missed and says so on stderr at exit 0. `--wait` turns a `pending` read into a bounded in-verb wait — the verb owns the loop, never the caller (claude-plugins/fabrika/docs/skill-conventions.md §14) — and prepends `settle\\t<settled|budget-exhausted|head-moved|governance-owed>` to the answer (`settle` under `--json`, null without `--wait`). It polls ONLY a `pending`; every refusal and the `no-producer` answer return on the first read. `budget-exhausted` still prints `pending` — the wait ran out and CI did not conclude; `head-moved` says the PR left the head this answer binds; `governance-owed` says the only unfinished check is `governance floor at head` with its `governance-floor` run already completed, so the verdict the caller itself owes is what is missing — it returns at once, while a floor whose run is still in flight is waited on unchanged. Exits 7 (PR or --sha proven absent, zero check runs declared, or zero workflows — ADR 0092), 11 (the enumeration, the workflow inventory, the workflow runs at the head, or `.fabrika.jsonc` could not be read — CI state is UNKNOWN, never green), 13 (received fewer runs than declared), 16 (the enumeration is complete, but no workflow this repo authors produced a run at the head — neither green nor pending). Example: fabrika review ci 4321 --sha 03135b91',
	),
);

const verdicts = leafCommand(
	"verdicts",
	{pr: prArg, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, repo, json}) {
		yield* emit(yield* runVerdicts({pr, repo: Option.getOrNull(repo), json, env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Every verdict marker on a PR, bound to the live head."),
	Command.withDescription(
		"Sweep every verdict marker on a PR and bind each to the live head as one of three outcomes — current / stale / unbindable, never folded (ADR 0058). First stdout line is `verdicts\\t<live-head>\\t<count>`; a count of 0 is a proven answer. Then one `<namespace>\\t<polarity>\\t<sha>\\t<binding>\\t<comment-id>\\t<standing|superseded>` line per marker, newest first; a marker that fails the format prints as a `malformed` row rather than being dropped, and a verdict retired below a comment's supersede fence prints its own `superseded` row rather than being hidden by the one that replaced it (#7247). An unresolvable head prints unbindable on every row. Exits 7 (PR proven absent), 11 (the comment list could not be read — never zero), 13 (the sweep is provably short). Example: fabrika review verdicts 4321",
	),
);

const deviations = leafCommand(
	"deviations",
	{pr: prArg, sha: boundShaFlag, repo: repoFlag, json: jsonFlag},
	Effect.fn(function* ({pr, sha, repo, json}) {
		yield* emit(
			yield* runDeviations({
				pr,
				sha: Option.getOrNull(sha),
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The PR body's Deviations state, entries and token scan."),
	Command.withDescription(
		"Report the PR body's `## Deviations` state — found | none-declared | absent | malformed, three distinct facts — with its entries and the Tier-M token scan over the diff at the bound commit. First stdout line is `deviations\\t<state>`, then one `entry\\t<class-label-or-->\\t<Said>` line per entry and one `tier-m\\t<kind>\\t<file>:<line>\\t<token>` line per hit. Exits 7 (PR proven absent), 10 (--sha is not a head SHA), 11 (the body or diff could not be read, or the commit could not be bound — the disclosure state is UNKNOWN, never `none`), 12 (--sha is not the PR's head — re-scope, never re-bind), 13 (the diff is provably short — no partial scan is printed beside a disclosure claim). Example: fabrika review deviations 4321 --sha 03135b91",
	),
);

/**
 * The verdict body arrives on **stdin only** — no `--body`, no `--body-file`. A flag that takes a
 * path turns the body into a string the verb could post verbatim, which is how a machine-local path
 * reaches a public surface while the poster reads success.
 */
const post = leafCommand(
	"post",
	{
		pr: Argument.integer("pr").pipe(
			Argument.withDescription(
				"the pull request the verdict is posted on — with --base/--tip, the child issue instead",
			),
		),
		namespace: Flag.string("namespace").pipe(
			Flag.withDescription(
				"the namespace this verdict fills; must be one this PR's own diff derived",
			),
		),
		polarity: Flag.string("polarity").pipe(
			Flag.withDescription("PASS or FAIL — a third token is not a polarity"),
		),
		sha: Flag.string("sha").pipe(
			Flag.optional,
			Flag.withDescription(
				"the head the reviewer actually inspected (7–40 lowercase hex); required unless --base/--tip scope the verdict to a range",
			),
		),
		clause: Flag.string("clause").pipe(
			Flag.withDescription("the human clause the marker ends with; blank is not a clause"),
		),
		carrier: Flag.string("carrier").pipe(
			Flag.withDefault("marker"),
			Flag.withDescription(
				"marker (first-line SHA-bound marker) or advisory (§CP: advisory first line, `Reviewed-head: @ <sha>` in the body); advisory is a PASS path only (default: marker)",
			),
		),
		base: Flag.string("base").pipe(
			Flag.optional,
			Flag.withDescription(
				"with --tip: post a range-scoped verdict over <base>..<tip> on the child issue named by the positional (#5935); never combined with --sha",
			),
		),
		tip: Flag.string("tip").pipe(
			Flag.optional,
			Flag.withDescription("the range's tip revision — the other half of --base"),
		),
		supersede: Flag.boolean("supersede").pipe(
			Flag.withDescription(
				"acknowledge that this verdict retires a standing one of the OPPOSITE polarity at the same head, or ranged, over the same range; without it that post is refused at 17",
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({
		pr,
		namespace,
		polarity,
		sha,
		clause,
		carrier,
		base,
		tip,
		supersede,
		repo,
		json,
	}) {
		yield* emit(
			yield* runPost({
				pr,
				namespace,
				polarity,
				sha: Option.getOrNull(sha),
				clause,
				carrier,
				base: Option.getOrNull(base),
				tip: Option.getOrNull(tip),
				supersede,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
				now: Effect.sync(() => Date.now()),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the verdict on stdin as this namespace's one comment."),
	Command.withDescription(
		'Post the verdict on STDIN as ONE comment for this namespace — re-resolve the live head, recompute the class set at the bound commit, compose the first line through the `verdict-marker` wire format, leak-scan the assembled comment, APPEND into this head\'s own comment, and read it back from live state. The prior verdict is never replaced: it survives verbatim under a dated `## Superseded verdict` heading below the fence, while the fresh verdict takes the first line, so every marker reader resolves the newest one (#7247). With --base and --tip the verdict is RANGE-scoped instead (ADR 0285): the positional names the child issue, the class set is recomputed over what `<base>...<tip>` changed in this checkout, the first line goes through the `range-verdict-marker` format `lane prove` reads, and the answer\'s third field is `<base>..<tip>`; --sha and --carrier advisory are refused in this mode. That path appends the same way, keyed on the range rather than a head (#7411). Prints `posted\\t<namespace>\\t<polarity>\\t<sha|base..tip>\\t<content>\\t<created|superseded>\\t<comment-url>`, where `<content>` is the content digest the verdict binds (ADR 0276). Exits 3 (empty stdin — an empty verdict reads as UNGATED), 5 (machine-local path in the assembled comment), 6 (bare @ reference), 7 (PR absent or closed; or, ranged, the issue is absent, closed, or a pull request), 8 (the create/edit failed — UNKNOWN), 9 (read-back does not yield this marker), 10 (namespace the diff or range did not derive, bad polarity, advisory with FAIL or with a range, a lone --base/--tip, or --sha beside a range), 11 (a precondition read failed, or the commit could not be bound — nothing was posted), 12 (the live head moved past --sha — re-review, never re-bind), 17 (a standing verdict of the OPPOSITE polarity at this head — ranged, over this range — would be retired and --supersede was not passed; nothing posted). Examples: fabrika review post 4321 --namespace review-doc --polarity PASS --sha 03135b91 --clause "guide matches shipped behavior" < verdict.md; fabrika review post 5830 --namespace review --polarity PASS --base 9f2c1ab --tip 03135b9 --clause "every criterion met" < verdict.md',
	),
);

/** The criterion text arrives on **stdin**, for the same reason `post`'s body does. */
const appendCriterion = leafCommand(
	"append-criterion",
	{
		issue: Argument.integer("issue").pipe(
			Argument.withDescription("the linked issue receiving the criterion"),
		),
		pr: Flag.integer("pr").pipe(
			Flag.withDescription(
				"the PR whose review round produced the finding — half the provenance tag",
			),
		),
		round: Flag.integer("round").pipe(
			Flag.withDescription(
				`this review round's number; at or past the freeze (${CAP_ROUND}) the verb escalates instead of appending`,
			),
		),
		repo: repoFlag,
		json: jsonFlag,
	},
	Effect.fn(function* ({issue, pr, round, repo, json}) {
		yield* emit(
			yield* runAppendCriterion({
				issue,
				pr,
				round,
				repo: Option.getOrNull(repo),
				json,
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Append one reviewer-authored acceptance criterion."),
	Command.withDescription(
		"Append one reviewer-authored acceptance criterion from STDIN under ADR 0079's four fences — ACL-gated fail-closed, append-only, provenance-tagged, frozen at round 3. Prints `appended\\t<issue>\\t<rows-after>`, or `escalated-frozen\\t<issue>\\t<round>` at the freeze; both are proven answers at exit 0. Exits 3 (empty stdin), 5 (machine-local path), 6 (bare @ reference), 7 (issue absent or closed, or no conforming acceptance-criteria block), 8 (the PATCH or the escalation comment failed — UNKNOWN), 9 (read-back does not show the prior rows plus this one), 11 (a precondition read failed), 14 (token below write or the ACL lookup failed — ADR 0055), 15 (the write is not provably the prior rows plus one — the append-only fence). Example: printf 'a regression test covers qty > 1' | fabrika review append-criterion 4287 --pr 4321 --round 1",
	),
);

const scratch = leafCommand(
	"scratch",
	{
		pr: Argument.integer("pr").pipe(
			Argument.withDescription("the pull request this lane is reviewing"),
		),
		slug: Flag.string("slug").pipe(
			Flag.withDescription("the file's leaf name: kebab-case, no path separators"),
		),
		lane: Flag.string("lane").pipe(
			Flag.withDescription(
				"the lane key from this reviewer's spawn brief — what tells two reviewers of ONE session apart",
			),
		),
		sha: Flag.string("sha").pipe(
			Flag.withDescription(
				"the head `review scope` bound (7–40 hex) — what tells two review ROUNDS of one lane apart",
			),
		),
	},
	Effect.fn(function* ({pr, slug, lane, sha}) {
		yield* emit(yield* runScratch({pr, slug, lane, sha, env: process.env, tmpRoot: tmpdir()}));
	}),
).pipe(
	Command.withShortDescription("The per-lane scratch path a reviewer's staged files go under."),
	Command.withDescription(
		"The per-lane scratch path, allocated fail-closed: <temp root>/fabrika-review/<session-id>/<pr>-<lane-nonce>/<slug>, one absolute path on stdout, the directory created if absent. The nonce is twelve hex of sha256(--lane, --sha): --lane keys the path per LANE rather than per session, --sha keys it per ROUND, and both are required. The printed path is machine-local and must never reach a posted artifact; `review post` and `review append-criterion` red on it at 5. Exits 1 (the directory could not be created, --lane is blank, the positional is not a PR number, or no session id is set (the FABRIKA_SESSION_ID → CLAUDE_CODE_SESSION_ID → PI_SUBAGENT_PARENT_SESSION chain) or the id is not one path segment), 10 (--slug carries a path separator or is not kebab-case, or --sha is not a head SHA). Example: fabrika review scratch 4321 --slug diff --lane 4287 --sha 03135b91",
	),
);

export const reviewCommand = Command.make("review").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		scope,
		diff,
		criteria,
		ci,
		verdicts,
		deviations,
		post,
		appendCriterion,
		scratch,
	]),
	Command.withShortDescription("Read what a text review needs off one pull request."),
	Command.withDescription(
		"Read everything a text review needs off one pull request — scope, diff, criteria, CI, verdicts, deviations — allocate the per-lane scratch path its staged reads go under, and emit the verdict or a reviewer-authored criterion through the one sanctioned write path",
	),
);
