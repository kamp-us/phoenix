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
 */
import {randomUUID} from "node:crypto";
import {tmpdir} from "node:os";
import {Effect, type FileSystem, Option, Result} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {localTreeGuards} from "../guard/command.ts";
import {readFile} from "../io/fs.ts";
import {SESSION_ID_VARS} from "../io/session-id.ts";
import {readStdin} from "../io/stdin.ts";
import {DEFAULT_LANES_ROOT} from "../lane/store.ts";
import {refuse} from "../verb.ts";
import {runBranch} from "./branch-verb.ts";
import {runCheck} from "./check-verb.ts";
import {runAdopt, runClaim, runConfirm, runRelease} from "./claim-verb.ts";
import {runClaimants} from "./claimants-verb.ts";
import {type DocumentRead, runClear} from "./clear-verb.ts";
import {NO_SERVED_ISSUE, OFF_VOCABULARY} from "./codes.ts";
import {runCommit} from "./commit-verb.ts";
import {runDeviations} from "./deviations-verb.ts";
import {runEligible} from "./eligible-verb.ts";
import {runIssue} from "./issue-verb.ts";
import {runNote} from "./note-verb.ts";
import {runPick} from "./pick-verb.ts";
import {runPr, runPrBody} from "./pr-verb.ts";
import {runPush} from "./push-verb.ts";
import {runReap} from "./reap-verb.ts";
import {runResumeChild} from "./resume-child-verb.ts";
import {runRetireBranch} from "./retire-branch-verb.ts";
import {runRetire} from "./retire-verb.ts";
import {
	ADMISSION_EXIT_CODES,
	CITATION_GRAMMAR,
	CLAIM_PURPOSES,
	DECISION_TYPE_LABEL,
	DEFAULT_CLAIM_PURPOSE,
	READY_FOR_AGENT,
} from "./scope-admission.ts";
import {runScratch} from "./scratch-verb.ts";
import {DEFAULT_OLDER_THAN_MINUTES, runStaleClaims} from "./stale-claims-verb.ts";
import {runTakeover} from "./takeover-verb.ts";
import {runTree} from "./tree-verb.ts";
import {runChildVerdicts, runVerdicts} from "./verdicts-verb.ts";

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

/** Where this run's session id is read from, for the flags whose token must carry it. */
const sessionSource = `${SESSION_ID_VARS.join(" → ")}, unset a usage error`;

/**
 * Required, and deliberately not defaulted: it is how a verb learns WHICH lane is asking, and the
 * session id it could otherwise fall back to names every lane of the session at once.
 */
const tokenFlag = Flag.string("token").pipe(
	Flag.withDescription(
		`the claim token \`build claim\` handed this lane — its identity; its session must be this run's (${sessionSource})`,
	),
);

const issueArg = Argument.integer("number").pipe(
	Argument.withDescription("the issue this lane serves"),
);

const tree = leafCommand(
	"tree",
	{
		requireClean: Flag.boolean("require-clean").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"additionally refuse a tree with any uncommitted change — the lane-open posture (default: false)",
			),
		),
		issue: Flag.integer("issue").pipe(
			Flag.optional,
			Flag.withDescription(
				"additionally prove the checked-out branch serves this issue — the pre-mutation posture",
			),
		),
		repair: Flag.integer("repair").pipe(
			Flag.optional,
			Flag.withDescription(
				"the repair PR whose claim, resumed branch, and linkage set must contain --issue",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({requireClean, issue, repair, repo}) {
		yield* emit(
			yield* runTree({
				requireClean,
				issue: Option.getOrNull(issue),
				repair: Option.getOrNull(repair),
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Prove clean ground and the complete fresh or repair lane relationship.",
	),
	Command.withDescription(
		[
			"Prints the tree root, or with --issue the proven lane relationship as one JSON object.",
			'  {"answer":"proven","root","branch","claim":{"number","nonce"},"servedIssue":{"number","kind"}}',
			"  4: the repair PR links no served issue",
			"  7: the repair PR or the served issue is absent or closed",
			"  10: --repair without --issue",
			"  11: the tree, claim, PR or served issue could not be read (UNKNOWN)",
			"  13: uncommitted changes at --require-clean",
			"  14: wrong branch, nonce, PR or served issue",
			"  15: the claim is held by another session",
			`  Derivation: the build skill's contract.md, "build tree"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build tree --require-clean"},
		{command: "fabrika build tree --issue 7181 --repair 7182"},
	]),
);

const pick = leafCommand(
	"pick",
	{
		repo: repoFlag,
		limit: Flag.integer("limit").pipe(
			Flag.withDefault(20),
			Flag.withDescription(
				"maximum candidates to emit, after ranking; a positive integer (default: 20)",
			),
		),
	},
	Effect.fn(function* ({repo, limit}) {
		yield* emit(
			yield* runPick({
				repo: Option.getOrNull(repo),
				limit,
				cwd: process.cwd(),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The ranked pool of issues this lane may pick up."),
	Command.withDescription(
		[
			"Prints the ranked pool of issues a lane may claim, with every exclusion counted by reason.",
			'  {"pool":[{…,"bet"}],"excluded":{"<reason>":n},"unread":n,"scanned":{"p0","p1","p2"},"bets":{…}}',
			"  Stage-bet issues on the table project lead the pool; no campaign state excludes anything.",
			"  blocked_by is read in rank order until --limit survive; unread counts the rest.",
			"  A token without the project scope degrades to the pool's own order and names the fix.",
			"  11: a bucket, or the table when .fabrika.jsonc declares one, was unreadable (UNKNOWN)",
			`  Derivation: the build skill's contract.md, "build pick"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build pick --limit 5"}]),
);

const eligible = leafCommand(
	"eligible",
	{number: issueArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(yield* runEligible({number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Whether one issue's dependency gate is open."),
	Command.withDescription(
		[
			'Prints {"answer":"eligible","number":n,"parent":n|null} when one issue\'s dependency gate is open.',
			"  7: the issue is absent or closed",
			"  11: a read failed and nothing was proven open (UNKNOWN)",
			"  16: blocked; every open edge is named on stderr",
			`  Derivation: the build skill's contract.md, "build eligible"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build eligible 4312"}]),
);

/** `build claim`'s own exits; where one shares a code with the admission test, this row is the one shown. */
const CLAIM_OWN_EXITS: ReadonlyArray<{readonly code: number; readonly condition: string}> = [
	{code: 7, condition: "issue absent or closed"},
	{code: 8, condition: "write failed; run confirm"},
	{code: 9, condition: "marker does not read back"},
	{code: 10, condition: "a flag on the wrong target"},
	{code: 11, condition: "a read failed (UNKNOWN)"},
	{code: 14, condition: "served issue or lane task absent"},
	{code: 15, condition: "lost to another lane"},
	{code: 16, condition: "blocked"},
	{code: 31, condition: "disagrees with a standing verdict"},
	{code: 37, condition: "PR not ours, no takeover grant"},
];

/** The claim's exit lines, merged with the admission codes enumerated from the module rather than restated. */
const claimExitLines = [
	...CLAIM_OWN_EXITS,
	...ADMISSION_EXIT_CODES.filter(({code}) => !CLAIM_OWN_EXITS.some((own) => own.code === code)),
]
	.sort((a, b) => a.code - b.code)
	.map(({code, condition}) => `  ${code}: ${condition}`);

/** The epic lane whose ledger an integrate FAIL is read off — the brief's `lane`, with `--lane-root`. */
const laneFlag = Flag.string("lane").pipe(
	Flag.optional,
	Flag.withDescription(
		"epic child only: the lane key from the brief's ## Task, whose ledger records an integrate FAIL (which writes no verdict on the child); requires --lane-root",
	),
);
const laneRootFlag = Flag.string("lane-root").pipe(
	Flag.optional,
	Flag.withDescription("the lanes root from the brief's ## Task `root:`; requires --lane"),
);

const claim = leafCommand(
	"claim",
	{
		number: issueArg,
		issue: Flag.integer("issue").pipe(
			Flag.optional,
			Flag.withDescription(
				"repair only: the served issue retained from the repair brief, selected from the PR's complete linkage set",
			),
		),
		token: tokenFlag.pipe(
			Flag.optional,
			Flag.withDescription(
				`the token this lane already holds, when it is re-claiming — an already-held number then answers won with that same marker and writes nothing; omit it on a fresh claim, which mints one from this run's session (${sessionSource})`,
			),
		),
		purpose: Flag.string("purpose").pipe(
			Flag.withDefault(DEFAULT_CLAIM_PURPOSE),
			Flag.withDescription(
				`why this lane claims: ${CLAIM_PURPOSES.join(" | ")} — the audience fence (${READY_FOR_AGENT}) binds build only (default: ${DEFAULT_CLAIM_PURPOSE})`,
			),
		),
		override: Flag.string("override").pipe(
			Flag.optional,
			Flag.withDescription(
				"claim an issue the admission test refused on the audience axis, or a PR that names no issue to judge (38), naming why; requires --override-lane, and both are written into the claim marker. A type-axis or criteria-axis refusal is not overridable — a decision cites its ruling, an epic changes its --purpose, a body without criteria is repaired on the issue",
			),
		),
		overrideLane: Flag.string("override-lane").pipe(
			Flag.optional,
			Flag.withDescription(
				"the lane an --override is taken for; required with it, refused without it",
			),
		),
		cites: Flag.string("cites").pipe(
			Flag.optional,
			Flag.withDescription(
				`the founder ruling comment this build transcribes, as ${CITATION_GRAMMAR} — the type axis's one arm, and only on a ${DECISION_TYPE_LABEL}`,
			),
		),
		resume: Flag.boolean("resume").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"take the repair lane of an epic child that already carries a standing range FAIL, or a standing integrate FAIL on the --lane ledger, rather than building it fresh; refused on a child holding neither, exactly as its absence is refused on one that does",
			),
		),
		lane: laneFlag,
		laneRoot: laneRootFlag,
		repo: repoFlag,
	},
	Effect.fn(function* ({
		number,
		issue,
		token,
		purpose,
		override,
		overrideLane,
		cites,
		resume,
		lane,
		laneRoot,
		repo,
	}) {
		yield* emit(
			yield* runClaim({
				number,
				issue: Option.getOrNull(issue),
				repo: Option.getOrNull(repo),
				env: process.env,
				uuid: randomUUID(),
				at: new Date().toISOString(),
				token: Option.getOrNull(token),
				purpose,
				override: Option.getOrNull(override),
				overrideLane: Option.getOrNull(overrideLane),
				cites: Option.getOrNull(cites),
				resume,
				lane: Option.getOrNull(lane),
				laneRoot: Option.getOrNull(laneRoot),
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Race the claim marker on an issue or explicitly selected repair subject.",
	),
	Command.withDescription(
		[
			'Races a claim marker onto an issue and prints {"answer":"won","number","token","purpose"}.',
			...claimExitLines,
			`  Derivation: the build skill's contract.md, "build claim"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build claim 4312"},
		{command: "fabrika build claim 4312 --purpose gate"},
	]),
);

const confirm = leafCommand(
	"confirm",
	{number: issueArg, token: tokenFlag, repo: repoFlag},
	Effect.fn(function* ({number, token, repo}) {
		yield* emit(yield* runConfirm({number, token, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Re-prove this session still holds the claim."),
	Command.withDescription(
		[
			'Prints {"answer":"mine","number","token"} when the lane --token names still holds the claim.',
			"  7: the issue is absent or closed",
			"  11: the marker set could not be read (UNKNOWN)",
			"  15: held by another lane, or not claimed at all",
			`  Derivation: the build skill's contract.md, "build claim"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build confirm 4312 --token build:s-9f2e:c1a4d6f8-…"}]),
);

const claimants = leafCommand(
	"claimants",
	{number: issueArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(yield* runClaimants({number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Which sessions hold live claims on one issue."),
	Command.withDescription(
		[
			"Prints who holds the claim on one issue, and every marker beside the holder, with no token.",
			'  {"answer":"held"|"unclaimed","number","holder":{…}|null,"claimants":[…],"adopts":[…]}',
			"  7: the issue is absent",
			"  11: the issue, its comments or a permission could not be read (UNKNOWN)",
			`  Derivation: the build skill's contract.md, "build claimants"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build claimants 6669"}]),
);

const claimsStale = leafCommand(
	"stale",
	{
		olderThanMinutes: Flag.integer("older-than-minutes").pipe(
			Flag.withDefault(DEFAULT_OLDER_THAN_MINUTES),
			Flag.withDescription(
				`the horizon a marker must have stood past to be a row, in whole minutes, zero or more (default: ${DEFAULT_OLDER_THAN_MINUTES}, a day)`,
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({olderThanMinutes, repo}) {
		yield* emit(
			yield* runStaleClaims({
				olderThanMinutes,
				repo: Option.getOrNull(repo),
				now: new Date().toISOString(),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Which build claims have stood on the board unmoved."),
	Command.withDescription(
		[
			"Prints the authorized build claim markers standing past a horizon, oldest first.",
			'  {"answer":"stranded"|"none","now","scanned":{…},"stranded":[{"issue","token","holder",…}]}',
			"  A row is not proof a session is gone; succession is build adopt, then build release.",
			"  11: the index, a thread, a permission or a posted instant could not be read (UNKNOWN)",
			`  Derivation: the build skill's contract.md, "build claims stale"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build claims stale"},
		{command: "fabrika build claims stale --older-than-minutes 240"},
	]),
);

const claims = Command.make("claims").pipe(
	Command.withSubcommands([claimsStale]),
	Command.withShortDescription("Read build claim markers across the whole board."),
	Command.withDescription(
		"Board-wide reads of the build claim protocol's markers, as against the per-number reads beside them. Every verb here reports and none of them writes.",
	),
);

const release = leafCommand(
	"release",
	{number: issueArg, token: tokenFlag, repo: repoFlag},
	Effect.fn(function* ({number, token, repo}) {
		yield* emit(yield* runRelease({number, token, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Retract this session's own claim marker."),
	Command.withDescription(
		[
			'Retracts this lane\'s own claim marker and prints {"answer":"released","number","freed"}.',
			'  A stranded adopt of this lane\'s alone: {"answer":"released","number","adopted":"<session>"}',
			"  7: the issue is absent or closed",
			"  8: a retraction failed (UNKNOWN)",
			"  11: the marker set could not be read",
			"  15: this lane holds no claim",
			`  Derivation: the build skill's contract.md, "build claim"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build release 4312 --token build:s-9f2e:c1a4d6f8-…"}]),
);

const retire = leafCommand(
	"retire",
	{number: issueArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(yield* runRetire({number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Take back the checkout an orphaned build worktree is holding."),
	Command.withDescription(
		[
			"Removes the worktrees holding an issue's lane branch where a license allows; prints the result.",
			'  {"answer":"retired"|"held"|"none","number","retired":[…],"held":[…]}',
			"  Each retired entry: {path, branch, license, salvaged, unlocked}",
			"  7: the issue is absent",
			"  8: the salvage, an unlock or a removal failed (UNKNOWN)",
			"  9: a removed tree is still registered",
			"  11: a precondition read failed",
			"  33: a tree holds the branch and no license releases it",
			`  Derivation: the build skill's contract.md, "build retire"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build retire 6567"}]),
);

const retireBranch = leafCommand(
	"retire-branch",
	{number: issueArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(yield* runRetireBranch({number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Retire an epic child's superseded lane branches out of build/."),
	Command.withDescription(
		[
			"Renames an epic child's superseded lane branches from build/ to retired/ and prints the result.",
			'  {"answer":"retired"|"none","number","survivor":"<branch>","retired":[{"from","to"}]}',
			"  7: no branch in this clone was cut for the issue",
			"  8: git refused a rename (UNKNOWN)",
			"  9: a rename does not read back",
			"  11: a precondition read failed",
			"  33: a worktree holds a branch to rename; clear it with build retire",
			"  34: the board attests no single survivor",
			`  Derivation: the build skill's contract.md, "build retire-branch"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build retire-branch 6296"}]),
);

const reap = leafCommand(
	"reap",
	{
		execute: Flag.boolean("execute").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"actually remove the trees classified REMOVE (default: false — print the classification and mutate nothing)",
			),
		),
		limit: Flag.integer("limit").pipe(
			Flag.optional,
			Flag.withDescription(
				"attempt at most this many removals, a positive integer; the rest stay registered, are reported UNATTEMPTED and are removable on the next run (default: every removable tree)",
			),
		),
	},
	Effect.fn(function* ({execute, limit}) {
		yield* emit(yield* runReap({execute, limit: Option.getOrNull(limit), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("Reclaim the finished agent worktrees this clone never removed."),
	Command.withDescription(
		[
			"Prints each finished agent worktree as KEEP, REMOVE or PRUNE; --execute removes and prunes.",
			'  {"answer":"planned"|"reaped"|"none","executed","trunk","scanned","journal",…,"kept":[…]}',
			"  8: git refused a removal; the tree stays",
			"  9: a removal did not read back",
			"  11: the tree root, the registrations or the trunk could not be read",
			`  Derivation: the build skill's contract.md, "build reap"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build reap"},
		{command: "fabrika build reap --execute --limit 20"},
	]),
);

const issue = leafCommand(
	"issue",
	{number: issueArg, repo: repoFlag},
	Effect.fn(function* ({number, repo}) {
		yield* emit(yield* runIssue({number, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription("The claimed issue's body and acceptance criteria."),
	Command.withDescription(
		[
			"Prints one issue's body, labels and acceptance criteria as one JSON object.",
			'  {"number","title","state","labels","body","criteria":{"state":"found|absent|malformed","items"}}',
			"  Rows marking evidence outside the diff are quoted on stderr; cite that evidence in the PR body",
			"  7: the issue is absent or closed",
			"  11: the issue could not be read (UNKNOWN)",
			`  Derivation: the build skill's contract.md, "build issue"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build issue 4312"}]),
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
			Flag.optional,
			Flag.withDescription(
				"the base ref, FETCHED from a remote before the branch is cut; honoured verbatim on every lane. A ref with no <remote>/ half is qualified against origin, never read locally. Omit it and create mode DERIVES the base: epic/<parent> for a child of an epic, the trunk (origin/<the repo's GitHub default branch>) for a proven-standalone issue",
			),
		),
		resume: Flag.integer("resume").pipe(
			Flag.optional,
			Flag.withDescription(
				"repair mode: a PR number whose head branch to publish back to; exclusive with <number>",
			),
		),
		resumeLane: Flag.boolean("resume-lane").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"child-repair mode: take over the local branch a prior lane built <number> on, re-keyed to this claim's nonce; for an epic child, which opens no PR — takes no --slug and is exclusive with --resume",
			),
		),
		token: tokenFlag,
		repo: repoFlag,
	},
	Effect.fn(function* ({number, slug, base, resume, resumeLane, token, repo}) {
		yield* emit(
			yield* runBranch({
				number: Option.getOrNull(number),
				slug: Option.getOrNull(slug),
				base: Option.getOrNull(base),
				resume: Option.getOrNull(resume),
				resumeLane,
				token,
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Cut or resume the lane's branch off a freshly fetched base."),
	Command.withDescription(
		[
			"Cuts or resumes this lane's branch off a freshly fetched base and prints the branch name.",
			"  7: the resume PR, prior child branch or derived epic/<parent> is absent",
			"  10: a bad --slug, conflicting flags, or a --base with no remote to qualify",
			"  11: a fetch or read failed, or --resume-lane cannot take the branch (UNKNOWN)",
			"  13: the tree is dirty and the checkout would move HEAD",
			"  14: the tree stands on another lane's branch",
			"  15: the claim is held by another lane",
			"  36: the lane branch exists and does not carry the base; clear it with git",
			`  Derivation: the build skill's contract.md, "build branch"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build branch 4312 --slug editor-focus-loss --token build:s-9f2e:c1a4d6f8-…"},
	]),
);

/** `resume-child`'s exits: each is the stopping step's, with the admission codes read off the module. */
const resumeChildExitLines = [
	{code: 7, condition: "the child or its branch is absent"},
	{code: 10, condition: "a step refused its usage"},
	{code: 11, condition: "a read is UNKNOWN, or the prior branch cannot be taken"},
	{code: 13, condition: "the checkout is dirty"},
	{code: 14, condition: "wrong lane, or no ledger task"},
	{code: 15, condition: "the claim is another lane's"},
	{code: 31, condition: "nothing to repair"},
	...ADMISSION_EXIT_CODES.filter(({code}) => code >= 20 && code !== NO_SERVED_ISSUE),
]
	.sort((a, b) => a.code - b.code)
	.map(({code, condition}) => `  ${code}: ${condition}`);

const resumeChild = leafCommand(
	"resume-child",
	{
		number: Argument.integer("number").pipe(
			Argument.withDescription("the epic child whose standing-FAIL repair lane this opens"),
		),
		token: tokenFlag.pipe(
			Flag.optional,
			Flag.withDescription(
				"the repair claim this lane already holds, when it is re-running — the claim step then answers off the standing marker and writes nothing; omit it on a first entry, but NOT on a re-run, where a tokenless claim mints a second marker and refuses on 15",
			),
		),
		cites: Flag.string("cites").pipe(
			Flag.optional,
			Flag.withDescription(
				`the founder ruling comment a ${DECISION_TYPE_LABEL} child's repair transcribes, as ${CITATION_GRAMMAR} — forwarded unchanged to the claim step, which is the only step that reads it, and a malformed or foreign URL is a usage error there; needed on a first entry, never on a --token continuation`,
			),
		),
		lane: laneFlag,
		laneRoot: laneRootFlag,
		repo: repoFlag,
	},
	Effect.fn(function* ({number, token, cites, lane, laneRoot, repo}) {
		yield* emit(
			yield* runResumeChild({
				issue: number,
				token: Option.getOrNull(token),
				cites: Option.getOrNull(cites),
				lane: Option.getOrNull(lane),
				laneRoot: Option.getOrNull(laneRoot),
				repo: Option.getOrNull(repo),
				cwd: process.cwd(),
				env: process.env,
				uuid: randomUUID(),
				at: new Date().toISOString(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Open an epic child's standing-FAIL repair lane in one operation."),
	Command.withDescription(
		[
			"Opens an epic child's standing-FAIL repair lane in one run and prints the lane as JSON.",
			"  Exits are the stopping step's; re-run a stopped lane with --token <printed token>",
			...resumeChildExitLines,
			`  Derivation: the build skill's contract.md, "build resume-child"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build resume-child 7162"}]),
);

const scratch = leafCommand(
	"scratch",
	{
		number: issueArg,
		slug: Flag.string("slug").pipe(
			Flag.withDescription("the file's leaf name: kebab-case, no path separators"),
		),
		token: tokenFlag,
		repo: repoFlag,
	},
	Effect.fn(function* ({number, slug, token, repo}) {
		yield* emit(
			yield* runScratch({
				number,
				slug,
				token,
				repo: Option.getOrNull(repo),
				env: process.env,
				tmpRoot: tmpdir(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("The per-lane scratch directory path."),
	Command.withDescription(
		[
			"Prints this lane's scratch directory path, creating the directory if absent.",
			"  The path is machine-local; never put it in a posted comment or body",
			"  10: --slug is not a kebab-case leaf",
			"  11: the claim could not be read (UNKNOWN)",
			"  15: the claim is held by another lane",
			`  Derivation: the build skill's contract.md, "build scratch"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build scratch 4312 --slug notes --token build:s-9f2e:c1a4d6f8-…"},
	]),
);

const commit = leafCommand(
	"commit",
	{
		messageFile: Flag.string("message-file").pipe(
			Flag.optional,
			Flag.withDescription(
				"carry the message in a leaf under this lane's `build scratch` directory instead of on stdin; any other path is refused",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({messageFile, repo}) {
		yield* emit(
			yield* runCommit({
				messageFile: Option.getOrNull(messageFile),
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
				tmpRoot: tmpdir(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Commit the staged change and prove the message is this lane's."),
	Command.withDescription(
		[
			"Commits the staged change with the message on stdin and prints the commit read back as JSON.",
			"  3: stdin held nothing",
			"  4: the message names an unclaimed issue, or --message-file is empty",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: nothing is staged",
			"  8: committed, and not read back (UNKNOWN)",
			"  9: the commit's message is not this lane's",
			"  10: --message-file is outside this lane's scratch",
			"  11: a read failed; nothing committed",
			"  14: the branch is not this lane's",
			"  15: the claim is another lane's",
			"  24: HEAD did not move",
			`  Derivation: the build skill's contract.md, "build commit"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build commit < message.txt"}]),
);

const check = leafCommand(
	"check",
	{
		surface: Flag.string("surface").pipe(
			Flag.withDescription(
				"code | prose | plan | workflows — the surface whose validators run; the skill names it, this verb anchors it against the diff. A diff of nothing but .github/workflows/** is the workflows surface",
			),
		),
		repo: repoFlag,
		probe: Flag.boolean("probe").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				'outside a lane: start every declared codeValidators entry once in this tree, naming each result on stderr; no session, diff, guard or config validator, so 7, 14, 15 and 22 never arise; writes nothing; green is {"verdict":"green","mode":"probe","surface","tree","ran"} (--surface code only; default: false)',
			),
		),
	},
	Effect.fn(function* ({surface, repo, probe}) {
		yield* emit(
			yield* runCheck({
				surface,
				repo: Option.getOrNull(repo),
				env: process.env,
				guards: localTreeGuards,
				probe,
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Run this surface's validators and the local-tree guards, in this tree.",
	),
	Command.withDescription(
		[
			"Runs this surface's validators and guards in this tree; --probe runs only codeValidators.",
			'  {"verdict":"green","surface","tree","ran","skipped","unvalidated"}',
			"  7: the diff is empty",
			"  10: --surface is off-enum, contradicts the diff, or is not code under --probe",
			"  11: a validator cannot start, no codeValidators, or a read failed (UNKNOWN)",
			"  14: the branch is not this lane's",
			"  15: the claim is held by another lane",
			"  18: red; the failing validator or guard is named on stderr",
			"  22: no validator covers any changed file",
			`  Derivation: the build skill's contract.md, "build check"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build check --surface code"},
		{command: "fabrika build check --surface code --probe"},
	]),
);

/**
 * `--force-with-lease` is the only force shape. There is no `--force` and no `--no-verify`: the ban is
 * enforced by the flag not existing rather than by prose.
 */
const push = leafCommand(
	"push",
	{
		forceWithLease: Flag.boolean("force-with-lease").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"permit a non-fast-forward update of this lane's own branch — repair resubmission only (default: false)",
			),
		),
		dropRemoteCommits: Flag.boolean("drop-remote-commits").pipe(
			Flag.withDefault(false),
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
	Command.withShortDescription("Push the lane's branch and confirm the remote ref moved."),
	Command.withDescription(
		[
			"Pushes this lane's branch, reads the remote ref back and ends stdout on PUSH-VERDICT: MOVED.",
			"  8: pushed, and the remote ref could not be re-read (UNKNOWN)",
			"  11: the claim or the remote head could not be read; nothing was pushed",
			"  14: the branch is not this lane's",
			"  15: the claim is held by another lane",
			"  17: the remote ref did not move",
			"  19: detached HEAD, or non-fast-forward without --force-with-lease",
			"  23: the push would drop the published head's commits",
			`  Derivation: the build skill's contract.md, "build push"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build push"},
		{command: "fabrika build push --force-with-lease"},
	]),
);

const pr = leafCommand(
	"pr",
	{
		number: issueArg,
		partial: Flag.boolean("partial").pipe(
			Flag.withDefault(false),
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
	Command.withShortDescription("Open the PR from the body on stdin, guarded and read back."),
	Command.withDescription(
		[
			'Opens the PR from the body on stdin and prints {"answer":"opened"|"existing","number","url"}.',
			"  3: stdin held nothing",
			"  4: ## Deviations or the closing-keyword line is missing or malformed",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: the issue is absent or closed",
			"  8: the create failed (UNKNOWN); re-run",
			"  9: the PR landed and its body does not read back",
			"  10: the body claims a control-plane, type or priority verdict",
			"  11: a precondition read failed",
			"  14: the branch is not this lane's",
			"  15: the claim is held by another lane",
			`  Derivation: the build skill's contract.md, "build pr"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build pr 4312 < body.md"}]),
);

const prBody = leafCommand(
	"pr-body",
	{
		pr: Argument.integer("pr").pipe(
			Argument.withDescription("the open pull request whose body is replaced"),
		),
		partial: Flag.boolean("partial").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				'the acceptance criteria are not all met: the body must say "Part of #<n>", not "Fixes #<n>" (default: false)',
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, partial, repo}) {
		yield* emit(
			yield* runPrBody({
				pr,
				partial,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Replace an open PR's body from stdin, guarded and read back."),
	Command.withDescription(
		[
			'Replaces an open PR\'s body from stdin and prints {"answer":"updated","number","url"}.',
			"  3: stdin held nothing",
			"  4: ## Deviations or the closing-keyword line is missing or malformed",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: the PR is absent, closed or merged",
			"  8: the update failed (UNKNOWN); re-read the PR",
			"  9: the body does not read back",
			"  10: the body claims a control-plane, type or priority verdict",
			"  11: a precondition read failed",
			"  14: the PR or this branch is not this lane's",
			"  15: the claim is held by another lane",
			`  Derivation: the build skill's contract.md, "build pr-body"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build pr-body 4318 < body.md"}]),
);

const note = leafCommand(
	"note",
	{
		number: Argument.integer("number").pipe(
			Argument.withDescription("the issue or PR the note posts to"),
		),
		token: tokenFlag,
		repo: repoFlag,
	},
	Effect.fn(function* ({number, token, repo}) {
		yield* emit(
			yield* runNote({
				number,
				token,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the progress or handoff note on stdin."),
	Command.withDescription(
		[
			'Posts the note on stdin and prints {"answer":"posted","number","commentId","head"}.',
			"  head is the PR's head SHA at post time, null on an issue; tree state is never checked",
			"  3: stdin held nothing",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: the target is absent or closed",
			"  8: the write failed (UNKNOWN)",
			"  9: posted, and it does not read back",
			"  11: a precondition read failed",
			"  15: the claim is held by another lane",
			`  Derivation: the build skill's contract.md, "build note"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build note 4310 --token build:s-9f2e:c1a4d6f8-… < round-2.md"},
	]),
);

const deviations = leafCommand(
	"deviations",
	{
		issue: Argument.integer("issue").pipe(
			Argument.withDescription("the epic child the disclosure is for, and sits on"),
		),
		token: tokenFlag,
		standing: Flag.boolean("standing").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"print the standing disclosure and write nothing — the entries this round carries forward (default: false)",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({issue, token, standing, repo}) {
		yield* emit(
			yield* runDeviations({
				issue,
				token,
				standing,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post an epic child's deviation disclosure as its one marker."),
	Command.withDescription(
		[
			"Posts the ## Deviations section on stdin as the epic child's one marker and prints it as JSON.",
			"  3: stdin held nothing",
			"  4: ## Deviations is missing or malformed",
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: the issue is absent or closed",
			"  8: a write or retraction failed (UNKNOWN)",
			"  9: posted, and it does not read back",
			"  10: the number is a pull request",
			"  11: a precondition read failed",
			"  15: the claim is held by another lane",
			"  35: the section drops a standing entry",
			`  Derivation: the build skill's contract.md, "build deviations"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build deviations 6566 --token build:s-9f2e:c1a4d6f8-… < deviations.md"},
		{command: "fabrika build deviations 6566 --token build:s-9f2e:c1a4d6f8-… --standing"},
	]),
);

const verdicts = leafCommand(
	"verdicts",
	{
		pr: Flag.integer("pr").pipe(
			Flag.optional,
			Flag.withDescription("the pull request whose verdict state is folded"),
		),
		issue: Flag.integer("issue").pipe(
			Flag.optional,
			Flag.withDescription(
				"the epic child whose range-scoped verdicts are folded; it opens no PR, so its verdicts live on the issue — exclusive with --pr",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, issue, repo}) {
		const number = Option.getOrNull(pr);
		const child = Option.getOrNull(issue);
		if ((number === null) === (child === null)) {
			yield* emit(
				refuse(
					OFF_VOCABULARY,
					"build verdicts: give either --pr <n> or --issue <n>, never both and never neither.",
				),
			);
			return;
		}
		yield* emit(
			number === null
				? yield* runChildVerdicts({
						issue: child as number,
						repo: Option.getOrNull(repo),
						env: process.env,
					})
				: yield* runVerdicts({pr: number, repo: Option.getOrNull(repo), env: process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("The latest gate verdict per namespace at a PR's live head."),
	Command.withDescription(
		[
			"Prints the latest gate verdict per namespace for a PR's head, or an epic child, as JSON.",
			'  {"head","mergeability","requiredChecks","rows","capReached","escalatedFindings",…}',
			"  requiredChecks.state: green | red (.failing) | pending | unknown; only green is green",
			"  Empty rows is a proven no-verdict answer about the gates, never about mergeability or CI",
			"  7: the PR or issue is absent or closed, or --issue names a PR",
			"  10: neither or both of --pr and --issue",
			"  11: a page, the head or the linked issue could not be read (UNKNOWN)",
			`  Derivation: the build skill's contract.md, "build verdicts"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build verdicts --pr 4310"},
		{command: "fabrika build verdicts --issue 7162"},
	]),
);

/** A file the adapter reads for a verb, so the verb itself touches no filesystem for it. */
const document = (path: string): Effect.Effect<DocumentRead, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const read = yield* Effect.result(readFile(path));
		return Result.isFailure(read)
			? ({_tag: "Failed", reason: read.failure.reason} satisfies DocumentRead)
			: ({_tag: "Text", text: read.success} satisfies DocumentRead);
	});

const clear = leafCommand(
	"clear",
	{
		pr: Flag.integer("pr").pipe(
			Flag.withDescription("the pull request whose repair budget the founder cleared a round on"),
		),
		authorization: Flag.string("authorization").pipe(
			Flag.withDescription(
				"a file quoting the founder's authorization verbatim, carrying an ISO-8601 date; posted as an adjacent comment, never summarized",
			),
		),
		laneRoot: Flag.string("lane-root").pipe(
			Flag.optional,
			Flag.withDescription(
				`the lanes root the local grant is recorded in (default: ${DEFAULT_LANES_ROOT})`,
			),
		),
		task: Flag.string("task").pipe(
			Flag.optional,
			Flag.withDescription("the lane task the grant addresses; omittable on a single-task lane"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, authorization, laneRoot, task, repo}) {
		yield* emit(
			yield* runClear({
				pr,
				authorizationPath: authorization,
				authorization: document(authorization),
				laneRoot: Option.getOrNull(laneRoot),
				task: Option.getOrNull(task),
				repo: Option.getOrNull(repo),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Record the founder's clearance of one extra repair round."),
	Command.withDescription(
		[
			"Records one founder-cleared repair round on a PR and prints the grant as one JSON object.",
			"  5: a machine-local path in the authorization",
			"  6: a bare @ reference",
			"  7: the PR is absent or closed, or its budget is not spent",
			"  8: a write failed (UNKNOWN); read the PR before re-running",
			"  9: the marker does not read back",
			"  11: a precondition read failed",
			"  25: this account may not clear a round here",
			"  26: --authorization is missing, empty or undated",
			"  29: recorded on the PR and not in the local lane; re-run to reconcile",
			`  Derivation: the build skill's contract.md, "build clear"`,
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika build clear --pr 5953 --authorization authorization.md"},
	]),
);

const takeover = leafCommand(
	"takeover",
	{
		pr: Argument.integer("pr").pipe(
			Argument.withDescription(
				"the open pull request another author opened, handed to the pipeline",
			),
		),
		authorization: Flag.string("authorization").pipe(
			Flag.withDescription(
				'a file quoting the "take over #N" authorization verbatim, carrying an ISO-8601 date; posted under the marker, never summarized',
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, authorization, repo}) {
		yield* emit(
			yield* runTakeover({
				pr,
				authorizationPath: authorization,
				authorization: document(authorization),
				repo: Option.getOrNull(repo),
				env: process.env,
				now: () => new Date(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Hand a PR another author opened to the pipeline."),
	Command.withDescription(
		[
			"Posts the grant that hands another author's PR to the pipeline and prints the grant as JSON.",
			'  {"pr","author","by","comment","at","resolvesTo":"granted"|"already-granted"}',
			"  5: a machine-local path",
			"  6: a bare @ reference",
			"  7: the PR is absent, closed or already ours",
			"  8: the write failed (UNKNOWN)",
			"  9: the read-back differs",
			"  11: a precondition read failed (UNKNOWN)",
			"  25: the invoking account may not grant here, or opened the PR",
			"  26: --authorization is missing, empty or undated",
			`  Derivation: the build skill's contract.md, "build takeover"`,
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika build takeover 4321 --authorization authorization.md"}]),
);

const adopt = leafCommand(
	"adopt",
	{
		number: issueArg,
		session: Flag.string("session").pipe(
			Flag.withDescription(
				`the dead session whose claim this run adopts: one word, no whitespace or ·; naming this run's own session (${sessionSource}) refuses`,
			),
		),
		reason: Flag.string("reason").pipe(
			Flag.withDescription(
				"why the succession is taken, on one line — recorded on the marker, required",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({number, session, reason, repo}) {
		yield* emit(
			yield* runAdopt({
				number,
				repo: Option.getOrNull(repo),
				env: process.env,
				session,
				reason,
				uuid: randomUUID(),
				at: new Date().toISOString(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Record on the board that a dead session's claim passes to this one.",
	),
	Command.withDescription(
		[
			'Posts the succession marker on a dead session\'s claim and prints {"answer":"adopted",…,"token"}.',
			"  Then build release with the printed token retracts the adopted claim and this marker.",
			"  7: the issue is absent or closed",
			"  8: the marker write failed (UNKNOWN)",
			"  9: the marker does not read back",
			`  Derivation: the build skill's contract.md, "build claim"`,
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika build adopt 6037 --session 3672779a --reason "driver died in the 2026-08-18 API outage"',
		},
	]),
);

export const buildCommand = Command.make("build").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		tree,
		pick,
		eligible,
		claim,
		confirm,
		claimants,
		claims,
		release,
		adopt,
		retire,
		retireBranch,
		reap,
		issue,
		branch,
		resumeChild,
		scratch,
		commit,
		check,
		push,
		pr,
		prBody,
		note,
		deviations,
		verdicts,
		clear,
		takeover,
	]),
	Command.withShortDescription("Drive one construction lane from issue pick to open PR."),
	Command.withDescription(
		"Drive one construction lane end to end — prove the tree, pick and claim the issue, cut the branch, validate the tree, push, open the PR, and read the verdicts back",
	),
);
