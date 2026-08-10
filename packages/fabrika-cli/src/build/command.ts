/**
 * The `build` verb group — `fabrika build <verb>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), runs the pure verb, and emits its outcome. Every decision lives in
 * the `*-verb.ts` modules beside it, which is what makes each refusal testable without spawning a
 * process.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 *
 * `build push` is the group's one deviant on the channel rule and the emitter honours it: its whole
 * report is stdout, so `tail -1` of stdout on exit 0 is always the verdict line.
 */
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import type {VerbOutcome} from "../verb.ts";
import {runBranch} from "./branch-verb.ts";
import {runCheck} from "./check-verb.ts";
import {runClaim, runConfirm, runRelease} from "./claim-verb.ts";
import {runEligible} from "./eligible-verb.ts";
import {runIssue} from "./issue-verb.ts";
import {runNote} from "./note-verb.ts";
import {runPick} from "./pick-verb.ts";
import {runPr} from "./pr-verb.ts";
import {runPush} from "./push-verb.ts";
import {
	ADMISSION_EXIT_CODES,
	CLAIM_PURPOSES,
	DEFAULT_CLAIM_PURPOSE,
	READY_FOR_AGENT,
} from "./scope-admission.ts";
import {runScratch} from "./scratch-verb.ts";
import {runTree} from "./tree-verb.ts";
import {runVerdicts} from "./verdicts-verb.ts";

/** Write the outcome and exit on its code — stdout is the answer, everything else is stderr. */
const emit = (outcome: VerbOutcome): Effect.Effect<void> =>
	Effect.sync(() => {
		for (const line of outcome.stderr) process.stderr.write(`${line}\n`);
		if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
		process.exit(outcome.code);
	});

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

const issueArg = Argument.integer("number").pipe(
	Argument.withDescription("the issue this lane serves"),
);

const tree = leafCommand(
	"tree",
	{
		requireClean: Flag.boolean("require-clean").pipe(
			Flag.withDescription(
				"additionally refuse a tree with any uncommitted change — the lane-open posture (default: false)",
			),
		),
		issue: Flag.integer("issue").pipe(
			Flag.optional,
			Flag.withDescription(
				"additionally prove the checked-out branch carries this claim's nonce — the pre-mutation posture",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({requireClean, issue, repo}) {
		yield* emit(
			yield* runTree({
				requireClean,
				issue: Option.getOrNull(issue),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withDescription(
		"Prove the ground: a linked worktree, optionally clean, optionally this lane's. Prints the tree root's absolute path on stdout. Verifies and NEVER provisions — it creates, locks, unlocks and removes nothing (the spawner owns the tree's lifecycle). Exits 11 (with --issue: the claim state could not be read — the lane is UNKNOWN), 12 (proven: not in a linked worktree), 13 (proven: uncommitted changes at a --require-clean open), 14 (proven: the checked-out branch does not carry this claim's nonce), 15 (proven: the claim on --issue is foreign). Example: fabrika build tree --require-clean",
	),
);

const pick = leafCommand(
	"pick",
	{
		repo: repoFlag,
		limit: Flag.integer("limit").pipe(
			Flag.withDefault(20),
			Flag.withDescription("maximum candidates to emit, after ranking (default: 20)"),
		),
	},
	Effect.fn(function* ({repo, limit}) {
		yield* emit(yield* runPick({repo: Option.getOrNull(repo), limit, env: process.env}));
	}),
).pipe(
	Command.withDescription(
		'The ranked candidate pool: status:triaged + unassigned + admitted by the shared admission test (scope axis against the ROADMAP.md "## Focus" declaration, audience axis on ready-for:agent), every bucket paginated in full. Prints {"pool":[…],"excluded":[{"number","home","reason"}],"scanned":{"p0":n,"p1":n,"p2":n},"focus":{…}}; each excluded issue names which axis refused it, and an empty pool is a fact on exit 0, readable against the scanned counts. Exits 1 (--limit is not a positive integer), 4 (the "## Focus" declaration reads but does not parse — never read as "no focus"), 11 (any bucket read failed or came back truncated, or the declaration could not be read — the pool is UNKNOWN, never partial and never unfiltered). Example: fabrika build pick --limit 5',
	),
);

const eligible = leafCommand(
	"eligible",
	{number: issueArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(yield* runEligible({number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withDescription(
		'One issue\'s dependency gate, derived from the parent ledger\'s "## Dependencies" topology and never read off a label. Prints {"answer":"eligible","number":n,"parent":n|null}; blocked and unknown print nothing. Every predecessor is read before the answer is seated, so the verdict does not depend on the order the topology lists them in, and a predecessor that could not be read is named on stderr as its own row rather than counted closed. Exits 4 (the parent\'s "## Dependencies" block is absent or unparseable — "no parseable edges" is never "no edges"), 7 (the issue is proven absent or closed), 11 (the issue, parent or a predecessor could not be read, with nothing proven open — UNKNOWN, never "eligible"), 16 (proven blocked — EVERY open edge is named on stderr, alongside any predecessor that could not be read). Example: fabrika build eligible 4312',
	),
);

/** The admission codes as `--help` prose, enumerated from the module rather than restated (ADR 0245). */
const admissionExits = ADMISSION_EXIT_CODES.map(
	({code, condition}) => `${code} (${condition})`,
).join(", ");

const claim = leafCommand(
	"claim",
	{
		number: issueArg,
		purpose: Flag.string("purpose").pipe(
			Flag.withDefault(DEFAULT_CLAIM_PURPOSE),
			Flag.withDescription(
				`why this lane claims: ${CLAIM_PURPOSES.join(" | ")} — the audience fence (${READY_FOR_AGENT}) binds build only (default: ${DEFAULT_CLAIM_PURPOSE})`,
			),
		),
		override: Flag.string("override").pipe(
			Flag.optional,
			Flag.withDescription(
				"claim an issue the admission test refused on either axis, naming why; requires --override-lane, and both are written into the claim marker",
			),
		),
		overrideLane: Flag.string("override-lane").pipe(
			Flag.optional,
			Flag.withDescription(
				"the lane an --override is taken for; required with it, refused without it",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({number, purpose, override, overrideLane, repo}) {
		yield* emit(
			yield* runClaim({
				number,
				repo: Option.getOrNull(repo),
				env: process.env,
				uuid: randomUUID(),
				at: new Date().toISOString(),
				purpose,
				override: Option.getOrNull(override),
				overrideLane: Option.getOrNull(overrideLane),
			}),
		);
	}),
).pipe(
	Command.withDescription(
		`Race the earliest AUTHORIZED claim marker on an issue: post this session's token (build:<CLAUDE_CODE_SESSION_ID>:<uuid>), re-read, and win or name the winner. Authorization is the author's repository permission (ADR 0055) — marker text confers nothing. The admission test runs FIRST, before any marker is written, so a refused claim leaves no trace to retract. --purpose says why this lane claims (${CLAIM_PURPOSES.join(" | ")}, default ${DEFAULT_CLAIM_PURPOSE}): the audience axis (${READY_FOR_AGENT}) binds a build claim only, because an epic earns that label AFTER it is planned and gated (#5175); the scope axis binds every purpose, and an off-enum --purpose refuses on 10 rather than falling back. --override "<reason>" admits a proven refusal and REQUIRES --override-lane "<lane>"; both are recorded on the marker, and an UNKNOWN admission is never overridable. Prints {"answer":"won","number":n,"token":"…","purpose":"…"}, plus "override":{"lane","reason"} when one was used. A lost race retracts this run's own marker and exits 15, never 0; an unset CLAUDE_CODE_SESSION_ID, an empty --override reason, an --override with no lane, or an --override-lane with no override, is 1. Exits 7 (issue proven absent or closed), 8 (the marker write failed — UNKNOWN; run confirm), 9 (the marker landed but does not read back), 10 (--purpose is off-enum), 15 (proven lost), and from the admission test: ${admissionExits}. Example: fabrika build claim 4312 --purpose gate`,
	),
);

const confirm = leafCommand(
	"confirm",
	{number: issueArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(yield* runConfirm({number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withDescription(
		'Re-prove this session still holds the claim, before a mutation. Prints {"answer":"mine","number":n,"token":"…"}. Exits 1 (CLAUDE_CODE_SESSION_ID unset), 7 (issue proven absent or closed), 11 (the marker set could not be read — UNKNOWN, never "unclaimed"), 15 (proven: held by another session, or no claim exists — the detail is on stderr). Example: fabrika build confirm 4312',
	),
);

const release = leafCommand(
	"release",
	{number: issueArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(yield* runRelease({number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withDescription(
		'Retract this session\'s OWN claim marker, and only its own. Prints {"answer":"released","number":n}. Exits 1 (CLAUDE_CODE_SESSION_ID unset), 7 (issue proven absent or closed), 8 (the retraction failed — UNKNOWN), 11 (the marker set could not be read), 15 (this session holds no claim — refusing to release another lane\'s). Example: fabrika build release 4312',
	),
);

const issue = leafCommand(
	"issue",
	{number: issueArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(yield* runIssue({number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withDescription(
		'The claimed issue\'s body and acceptance criteria, through the content gate. Prints one JSON object with number, title, state, labels, body and criteria; criteria.state is found | absent | malformed — three facts the imported wire read keeps apart, so a drifted heading never reads as "no acceptance criteria". Exits 7 (issue proven absent or closed), 11 (the issue could not be read — its content is UNKNOWN). Example: fabrika build issue 4312',
	),
);

const branch = leafCommand(
	"branch",
	{
		number: Argument.integer("number").pipe(
			Argument.optional,
			Argument.withDescription("create mode: the claimed issue the branch serves"),
		),
		slug: Flag.string("slug").pipe(
			Flag.optional,
			Flag.withDescription("create mode: kebab-case, ≤5 words, must not begin with a hyphen"),
		),
		base: Flag.string("base").pipe(
			Flag.withDefault("origin/main"),
			Flag.withDescription("the base ref, FETCHED before the branch is cut (default: origin/main)"),
		),
		resume: Flag.integer("resume").pipe(
			Flag.optional,
			Flag.withDescription(
				"repair mode: a PR number whose head branch to publish back to; exclusive with <number>",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({number, slug, base, resume, repo}) {
		yield* emit(
			yield* runBranch({
				number: Option.getOrNull(number),
				slug: Option.getOrNull(slug),
				base,
				resume: Option.getOrNull(resume),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withDescription(
		"Cut (or resume) the lane's nonce branch off a FRESHLY FETCHED base, never a stale local ref. Prints the checked-out branch name: build/<number>-<slug>-<nonce> in create mode, build/pr-<pr>-<nonce> in resume mode, where <nonce> is the first 8 hex of the current claim token's UUID. The branch name IS the lane record — there is no stamp file. Exits 7 (--resume's PR is proven absent, closed or merged), 10 (--slug is not kebab-case, exceeds 5 words, or is flag-shaped), 11 (the fetch failed, or the claim state could not be read), 12 (proven: not in a linked worktree), 15 (proven: the claim is foreign). Example: fabrika build branch 4312 --slug editor-focus-loss",
	),
);

const scratch = leafCommand(
	"scratch",
	{
		number: issueArg,
		slug: Flag.string("slug").pipe(
			Flag.withDescription("the file's leaf name: kebab-case, no path separators"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({number, slug, repo}) {
		yield* emit(
			yield* runScratch({
				number,
				slug,
				repo: Option.getOrNull(repo),
				env: process.env,
				tmpRoot: tmpdir(),
			}),
		);
	}),
).pipe(
	Command.withDescription(
		"The per-lane scratch path, allocated fail-closed: <temp root>/fabrika-build/<session-id>/<issue>-<claim-nonce>/<slug>, one absolute path on stdout, the directory created if absent. The claim nonce is what keys the namespace per LANE rather than per session, so two lanes of one session cannot clobber each other. The printed path is machine-local and must never reach a posted artifact. Exits 1 (the directory could not be created, or CLAUDE_CODE_SESSION_ID is unset), 10 (--slug carries a path separator or is not kebab-case), 11 (the claim state could not be read), 15 (proven: the claim is foreign). Example: fabrika build scratch 4312 --slug notes",
	),
);

const check = leafCommand(
	"check",
	{
		surface: Flag.string("surface").pipe(
			Flag.withDescription(
				"code | prose | plan — the surface whose validators run; the skill names it, this verb anchors it against the diff",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({surface, repo}) {
		yield* emit(yield* runCheck({surface, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withDescription(
		'Run this surface\'s validators in this tree, with the build cache BYPASSED — a cache hit from another worktree has returned another tree\'s green. Prints {"verdict":"green","surface":"…","tree":"…","ran":[…]}; red and unknown print nothing. This verb predicts; ci.yml decides, and supersedes it where they disagree. Exits 7 (the diff against the base is empty — zero scope, ADR 0092), 10 (--surface is off-enum or provably mismatches the diff), 11 (a validator could not be executed, or the lane\'s claim could not be read — UNKNOWN, never green), 12 (not in a linked worktree), 14 (the checked-out branch is not this lane\'s), 15 (the lane\'s claim is held by another session), 18 (proven red). Example: fabrika build check --surface code',
	),
);

/**
 * `--force-with-lease` is the only force shape. There is no `--force` and no `--no-verify`: the ban is
 * enforced by the flag not existing rather than by prose (#4159).
 */
const push = leafCommand(
	"push",
	{
		forceWithLease: Flag.boolean("force-with-lease").pipe(
			Flag.withDescription(
				"permit a non-fast-forward update of this lane's own branch — repair resubmission only (default: false)",
			),
		),
		dropRemoteCommits: Flag.boolean("drop-remote-commits").pipe(
			Flag.withDescription(
				"publish a head that does NOT contain the published remote head, dropping its commits — a deliberate history rewrite (default: false)",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({dropRemoteCommits, forceWithLease, repo}) {
		yield* emit(
			yield* runPush({
				forceWithLease,
				dropRemoteCommits,
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withDescription(
		"Publish the lane's branch and INDEPENDENTLY confirm the remote ref moved, by reading it back with git ls-remote. The whole report is stdout, single-stream, so `tail -1` of stdout on exit 0 is always `PUSH-VERDICT: MOVED`. Before pushing, the local head must CONTAIN the published remote head — on the force path too, where --force-with-lease proves nothing about this lane's own dropped commits. Exits 8 (pushed, but the remote ref could not be re-read — the outcome is UNKNOWN), 11 (the lane's claim could not be read, or containment could not be proven — nothing was pushed), 12 (not in a linked worktree), 14 (the checked-out branch is not this lane's), 15 (the claim is held by another session), 17 (proven: the remote ref did not move), 19 (refused before pushing: detached HEAD, or non-fast-forward without --force-with-lease), 23 (proven: the local head drops the remote head's commits — rebase, or pass --drop-remote-commits). Example: fabrika build push",
	),
);

const pr = leafCommand(
	"pr",
	{
		number: issueArg,
		partial: Flag.boolean("partial").pipe(
			Flag.withDescription(
				'the acceptance criteria are not all met: the body must say "Part of #<n>", not "Fixes #<n>" (default: false)',
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({number, partial, repo}) {
		yield* emit(
			yield* runPr({
				number,
				partial,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withDescription(
		'Open the PR from the body on STDIN, refusing the known defect shapes before any write, with a read-back through normalizeForReadback. Prints {"answer":"opened",…}, or {"answer":"existing",…} on exit 0 when this head branch already has an open PR — an idempotent re-run is an answer, not a duplicate. Exits 3 (stdin held nothing), 4 ("## Deviations" missing or empty, or the closing-keyword line is absent, duplicated, mistargeted, or contradicts --partial), 5 (machine-local path), 6 (bare @ reference), 7 (issue proven absent or closed), 8 (the create failed — UNKNOWN; re-run), 9 (landed but does not read back), 10 (the body asserts a control-plane, type or priority classification — those verdicts are the gate\'s and triage\'s), 11 (a precondition read failed), 12 (not in a linked worktree), 14 (the head branch is not this lane\'s), 15 (this session does not hold the claim). Example: fabrika build pr 4312 < body.md',
	),
);

const note = leafCommand(
	"note",
	{
		number: Argument.integer("number").pipe(
			Argument.withDescription("the issue or PR the note posts to"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({number, repo}) {
		yield* emit(
			yield* runNote({
				number,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withDescription(
		'Post the progress or handoff note on STDIN, leak-guarded and read back. When the number resolves to a PR the note is stamped with that PR\'s head SHA at post time, so a reader can see a note predates a later push. Runs ONLY the posting guards — never the tree assertions — so a stop-report stays postable from a refused tree. Prints {"answer":"posted","number":n,"commentId":n,"head":"…"|null}. Exits 3 (stdin held nothing), 5 (machine-local path), 6 (bare @ reference), 7 (target proven absent or closed), 8 (the write failed — UNKNOWN), 9 (posted but does not read back), 11 (a precondition read failed), 15 (this session does not hold the claim). Example: fabrika build note 4310 < round-2.md',
	),
);

const verdicts = leafCommand(
	"verdicts",
	{
		pr: Flag.integer("pr").pipe(
			Flag.withDescription("the pull request whose verdict state is folded"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr: number, repo}) {
		yield* emit(yield* runVerdicts({pr: number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withDescription(
		'The paginated, current-head, per-gate verdict fold on a PR: every comment and every review, the latest marker per gate namespace bound to the live head, native reviews as their OWN row kind (never coerced), the 120-second FAIL round count, capReached, and the criteria frozen after round 2. Prints one JSON object with head, rows, rounds, capReached and frozenCriteria; {"rows":[]} on exit 0 is a proven "no verdicts", readable against the scope line. A stale marker prints as stale, never dropped. Exits 7 (PR proven absent or closed), 11 (the head, any comment page or any review page could not be read — UNKNOWN, never "none"). Example: fabrika build verdicts --pr 4310',
	),
);

export const buildCommand = Command.make("build").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		tree,
		pick,
		eligible,
		claim,
		confirm,
		release,
		issue,
		branch,
		scratch,
		check,
		push,
		pr,
		note,
		verdicts,
	]),
	Command.withDescription(
		"Drive one construction lane end to end — prove the tree, pick and claim the issue, cut the branch, validate the tree, push, open the PR, and read the verdicts back",
	),
);
