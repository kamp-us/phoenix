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
import {OFF_VOCABULARY} from "./codes.ts";
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
import {runTree} from "./tree-verb.ts";
import {runChildVerdicts, runVerdicts} from "./verdicts-verb.ts";

const repoFlag = Flag.string("repo").pipe(
	Flag.optional,
	Flag.withDescription(
		"the target owner/name (default: $CLAUDE_PIPELINE_REPO, else $GITHUB_REPOSITORY, else the origin remote)",
	),
);

/**
 * Required, and deliberately not defaulted: it is how a verb learns WHICH lane is asking, and the
 * session id it could otherwise fall back to names every lane of the session at once.
 */
/** Where this run's session id is read from, for the flags whose token must carry it. */
const sessionSource = `${SESSION_ID_VARS.join(" → ")}, unset a usage error`;

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
			yield* runPick({repo: Option.getOrNull(repo), limit, cwd: process.cwd(), env: process.env}),
		);
	}),
).pipe(
	Command.withShortDescription("The ranked pool of issues this lane may pick up."),
	Command.withDescription(
		[
			"Prints the ranked pool of issues a lane may claim, with every exclusion counted by reason.",
			'  {"pool":[…],"excluded":{"<reason>":n},"scanned":{"p0","p1","p2"},"campaigns":{…}}',
			"  4: the ## Campaigns table does not parse",
			"  11: a bucket or the campaigns table could not be read (UNKNOWN)",
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
				"claim an issue the admission test refused on the scope or audience axis, naming why; requires --override-lane, and both are written into the claim marker. A type-axis refusal is not overridable — a decision cites its ruling, an epic changes its --purpose",
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
				cwd: process.cwd(),
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
			"  7: the issue is absent",
			"  8: the salvage or a removal failed (UNKNOWN)",
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
		yield* emit(yield* runReap({execute, limit: Option.getOrNull(limit)}));
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
		'The claimed issue\'s body and acceptance criteria, through the content gate. Prints one JSON object with number, title, state, labels, body and criteria; criteria.state is found | absent | malformed — three facts the imported wire read keeps apart, so a drifted heading never reads as "no acceptance criteria". Each criterion carries its outside-diff evidence source as evidence, or null where the row is unmarked, and a marked contract also prints a stderr line quoting those rows — the evidence belongs in the PR body, because review post refuses a PASS that cites none of it (19). Exits 7 (issue proven absent or closed), 11 (the issue could not be read — its content is UNKNOWN). Example: fabrika build issue 4312',
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
			Flag.optional,
			Flag.withDescription(
				"the base ref, FETCHED from a remote before the branch is cut; honoured verbatim on every lane. A ref with no <remote>/ half is qualified against origin, never read locally. Omit it and create mode DERIVES the base: epic/<parent> for a child of an epic, origin/main for a proven-standalone issue",
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
		"Cut (or resume) the lane's nonce branch off a FRESHLY FETCHED base, never a stale local ref. Prints the checked-out branch name: build/<number>-<slug>-<nonce> in create mode, build/pr-<pr>-<nonce> in resume mode, where <nonce> is the first 8 hex of --token's UUID — the token THIS lane holds, proven against the live claim before the name is composed, so a lane cannot cut a branch on a nonce that holds nothing. The branch name IS the lane record — there is no stamp file. CREATE MODE DERIVES THE BASE when --base is absent: it reads <number>'s parent through GitHub's issue-parent endpoint and, on a parent, cuts off that epic's assembly branch epic/<parent>, fetched like any other base; a proven-standalone issue cuts off origin/main. An explicit --base is honoured verbatim on every lane, epic child included, and suppresses the derivation. It NEVER falls back to origin/main on a read it could not make — that fallback is the silent wrong base that had an epic child graded against a fork point its assembly branch never contained. EVERY BASE IS FETCHED FROM A REMOTE: a base naming no configured remote (--base main, --base epic/7497) is qualified against origin and read off FETCH_HEAD, so no spelling reaches a bare git fetch plus a rev-parse of an unmoved local ref; the one arm that reads refs/heads/ is a derived assembly branch origin is PROVEN to hold none of. Every run names the base it used and where it came from on stderr, and a create-mode success names the base COMMIT it ended on, so the cut is provable off this verb's own output. A re-run that finds the lane branch already there proves that branch carries the base this run resolved before switching to it, and refuses on 36 when it does not — the idempotent re-run is not a way for a wrong first cut to survive. --resume-lane is resume mode for an epic child, which opens no PR: it finds the one local branch this grammar says was cut for <number>, RE-KEYS it to this claim's nonce and checks it out, so the child's commits carry forward and exactly one branch keeps naming it — cutting a second is the underivable range lane prove refuses on. It fetches nothing, takes no --slug, and re-keys nothing when the name already matches. IN EVERY MODE, before any fetch, switch, rename or create, it refuses a tree it would carry work off or take from another lane — location-neutral, reading what the tree holds and never where it sits: 13 when the tree is dirty and the checkout would move HEAD (a tree already on the branch the verb ends on is admitted), 14 when the tree stands on another issue's or PR's lane branch. Exits 1 (--token is not a claim token of this session), 7 (--resume's PR is proven absent, closed or merged; --resume-lane found no local branch cut for <number>; or the derived assembly branch epic/<parent> is proven absent from both origin and this clone), 10 (--slug is not kebab-case, exceeds 5 words, or is flag-shaped, --resume-lane was combined with --resume or --slug, or --base names no configured remote and this clone has no origin to qualify it against — spelled one way when the clone has no remotes at all, another when it has several and none of them is origin), 11 (the fetch failed, the tree root, the branch it holds or the claim state could not be read, the parent read or the assembly-branch read failed so which base this lane belongs on is UNKNOWN, an existing lane branch's merge base with the resolved base could not be read, or --resume-lane found several candidate branches or could not re-key the one it found — the prior lane's worktree is likely still on it, which only an operator can release), 13 (uncommitted changes the checkout would carry onto the lane branch, or a status read that failed — UNKNOWN, never clean; nothing was changed), 14 (proven: this tree stands on another issue's or PR's lane branch; nothing was changed), 15 (proven: the claim is held by another lane), 36 (proven: the lane branch already exists and does not carry the base this run resolved, or shares no history with it at all — the refusal spells out the one git command that moves it onto the base, and deleting it is the other way out; build retire-branch does NOT clear this, because the branch a 36 names is never the superseded one it retires). Why the nonce, the derivation and the re-key are shaped this way is in claude-plugins/fabrika/skills/build/contract.md. Example: fabrika build branch 4312 --slug editor-focus-loss --token build:s-9f2e:c1a4d6f8-…",
	),
);

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
				`the founder ruling comment a ${DECISION_TYPE_LABEL} child's repair transcribes, as ${CITATION_GRAMMAR} — forwarded unchanged to the claim step, which is the only step that reads it; needed on a first entry, never on a --token continuation`,
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
		`Open the repair lane of an epic child carrying a standing FAIL, running the five ordered steps as one operation so their order is not a builder's to preserve (see claude-plugins/fabrika/skills/build/contract.md): "build claim <n> --resume" (which refuses on 31 unless a gate holds a standing FAIL over the child, or the --lane ledger holds a standing integrate FAIL for it), "build confirm", the UNARMED "build tree --require-clean" over the generic checkout, "build branch <n> --resume-lane" — the one mutation, which re-keys the single prior build/<n>-<slug>-<nonce> branch to this claim's nonce and checks it out — and finally the ARMED "build tree --issue <n>". Each step is the verb itself, so its refusal keeps its own exit code and its own words, and no step after a refusal runs; the branch is re-keyed only once the claim and cleanliness steps have passed. Prints {"answer":"resumed","issue":n,"token":"…","branch":"build/<n>-<slug>-<nonce>","root":"<absolute>","claim":{"number":n,"nonce":"…"}}, plus "integrate":{"exit","head"} when the claim step admitted the repair on an integrate FAIL. --lane <key> --lane-root <root> — the brief's lane and root — are carried to the claim step unchanged: an integrate FAIL writes no verdict on the child, so a child that passed review and failed lane integrate is repairable only when the claim can read its epic lane's ledger. --cites ${CITATION_GRAMMAR} is carried to the claim step unchanged and read by no other step: it opens that step's type axis on a ${DECISION_TYPE_LABEL} child whose choice a founder already recorded on it, so the one type a ruled child can carry is repairable through this entry rather than only by hand. It judges nothing itself — the URL must name this repository and this child, an omitted one on a decision is still 30, and a citation admits no other type. On any stop past the claim it prints the won token and the exact continuation, "fabrika build resume-child <n> --token <token>"; that is the whole way to continue the same lane, it needs no second citation because the claim answers off the standing marker, and a re-run WITHOUT --token mints a second claim, loses the earliest-wins tiebreak to this lane's own prior one and refuses on 15. Exits are the stopping step's: 1 (--cites is malformed, or names another repository or issue), 7 (the child is absent or closed, or no local branch was cut for it), 10 (a composed usage refusal), 11 (a read is UNKNOWN, several prior branches exist, or another worktree holds the branch — an operator's act to release), 13 (the generic checkout is dirty), 14 (the armed proof reads the wrong lane, or the --lane ledger holds no task for this child), 15 (the claim is foreign), 20/21/30/32 (the admission test), 31 (the child holds no standing FAIL and no standing integrate FAIL, so there is nothing to repair). Example: fabrika build resume-child 7162`,
	),
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
		"The per-lane scratch path, allocated fail-closed: <temp root>/fabrika-build/<session-id>/<issue>-<claim-nonce>/<slug>, one absolute path on stdout, the directory created if absent. --token's nonce is what keys the namespace per LANE rather than per session, so two lanes of one session cannot clobber each other. The printed path is machine-local and must never reach a posted artifact. Exits 1 (the directory could not be created, no session id is set — FABRIKA_SESSION_ID, CLAUDE_CODE_SESSION_ID and PI_SUBAGENT_PARENT_SESSION consulted, or --token is not a claim token of this session), 10 (--slug carries a path separator or is not kebab-case), 11 (the claim state could not be read), 15 (proven: the claim is held by another lane). Example: fabrika build scratch 4312 --slug notes --token build:s-9f2e:c1a4d6f8-…",
	),
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
		'Create this lane\'s commit from the message on STDIN, then READ THE MESSAGE BACK off the created commit and refuse if it is not the one this lane authored — the refusal prints both. The message may name only numbers this lane holds a confirmed claim on. The carrying path is prescribed, not improvised: stdin (file-free), or --message-file pointing at a leaf under "fabrika build scratch"\'s claim-nonce-keyed directory; any other path is refused. No refusal repeats a machine-local path. Prints {"answer":"committed","sha":"…","subject":"…","carried":"stdin"|"scratch-leaf"}. Exits 3 (stdin held nothing), 4 (the message names an issue this lane does not hold, or --message-file is empty), 5 (machine-local path in the message), 6 (bare @ reference), 7 (nothing is staged), 8 (the commit ran but HEAD or its message could not be read back — UNKNOWN), 9 (proven: the created commit carries a message this lane did not author), 10 (--message-file is not a leaf in this lane\'s scratch directory), 11 (a precondition read failed — nothing was committed), 14 (the checked-out branch is not this lane\'s), 15 (this session does not hold the claim), 24 (proven: git commit ran and HEAD did not move). Example: fabrika build commit < message.txt',
	),
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
	},
	Effect.fn(function* ({surface, repo}) {
		yield* emit(
			yield* runCheck({
				surface,
				repo: Option.getOrNull(repo),
				env: process.env,
				guards: localTreeGuards,
			}),
		);
	}),
).pipe(
	Command.withShortDescription(
		"Run this surface's validators and the local-tree guards, in this tree.",
	),
	Command.withDescription(
		'Run this surface\'s validators IN THIS TREE — a green borrowed from another checkout has been another tree\'s answer. Whether a validator reads a build cache is the repo\'s own declaration, not this verb\'s. EVERY surface additionally sweeps the shipped local-tree guards — the ones that are argument-free and read only the checked-out tree — so a guard that reds in CI reds here first; membership is declared beside each guard\'s registration and the sweep is not anchored by --surface. Prints {"verdict":"green","surface":"…","tree":"…","ran":[…,"guard <name> <leaf>",…],"skipped":[…],"unvalidated":[…]}; red and unknown print nothing. A guard that exited 7 (zero scope) or 11 (UNKNOWN) is reported in `skipped` as "<name> (<reason>)" and is never folded into the green — CI\'s own gate answers that one. A workflows-only diff (.github/workflows/**) is --surface workflows: actionlint over the changed files when the tree has it, plus the commands `.fabrika.jsonc` declares under `workflowValidators` (each naming the files it `reads`); a changed workflow nothing opened is reported in `unvalidated`, and a run that opened none of them is UNKNOWN. EVERY surface also spawns each `.fabrika.jsonc` `configValidators` entry whose `reads` names a changed file no surface owns (a root config file such as lefthook.yml, or non-JS source such as a .java file), so a diff of such files alone greens or reds under any --surface. This verb predicts; the repo\'s CI gate decides, and supersedes it where they disagree. Exits 7 (the diff against the base is empty — zero scope), 10 (--surface is off-enum or provably mismatches the diff), 11 (the tree root could not be read, a validator could not be executed, `.fabrika.jsonc` could not be read, or the lane\'s claim could not be read — UNKNOWN, never green), 14 (the checked-out branch is not this lane\'s), 15 (the lane\'s claim is held by another session), 18 (proven red — a validator or a local-tree guard failed, and the failing line names it), 22 (no surface and no declared config validator covers any changed file). Example: fabrika build check --surface code',
	),
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
		"Publish the lane's branch and INDEPENDENTLY confirm the remote ref moved, by reading it back with git ls-remote. The whole report is stdout, single-stream, so `tail -1` of stdout on exit 0 is always `PUSH-VERDICT: MOVED`. Before pushing, the local head must CONTAIN the published remote head — on the force path too, where --force-with-lease proves nothing about this lane's own dropped commits. Exits 8 (pushed, but the remote ref could not be re-read — the outcome is UNKNOWN), 11 (the tree root or the lane's claim could not be read, or containment could not be proven — nothing was pushed), 14 (the checked-out branch is not this lane's), 15 (the claim is held by another session), 17 (proven: the remote ref did not move), 19 (refused before pushing: detached HEAD, or non-fast-forward without --force-with-lease), 23 (proven: the local head drops the remote head's commits — rebase, or pass --drop-remote-commits). Example: fabrika build push",
	),
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
		'Open the PR from the body on STDIN, refusing the known defect shapes before any write, with a read-back through normalizeForReadback. Prints {"answer":"opened",…}, or {"answer":"existing",…} on exit 0 when this head branch already has an open PR — an idempotent re-run is an answer, not a duplicate. Exits 3 (stdin held nothing), 4 ("## Deviations" missing or empty, or the closing-keyword line is absent, duplicated, mistargeted, or contradicts --partial), 5 (machine-local path), 6 (bare @ reference), 7 (issue proven absent or closed), 8 (the create failed — UNKNOWN; re-run), 9 (landed but does not read back), 10 (the body asserts a control-plane, type or priority classification — those verdicts are the gate\'s and triage\'s), 11 (a precondition read failed), 14 (the head branch is not this lane\'s), 15 (this session does not hold the claim). Example: fabrika build pr 4312 < body.md',
	),
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
		'Replace an open pull request\'s body with the one on STDIN, running the same pre-write guards `build pr` runs on a create — leak scan, "## Deviations" shape, closing-keyword target, classification claim — and reading the body back through normalizeForReadback. Nothing but the body moves: no commit, no push, no branch. This is the route for a review FAIL whose whole fix is a body edit. The issue the closing keyword must name is read off the PR\'s own head branch, never off the body. Prints {"answer":"updated","number":n,"url":"…"}. Exits 3 (stdin held nothing), 4 ("## Deviations" missing or empty, or the closing-keyword line is absent, duplicated, mistargeted, or contradicts --partial), 5 (machine-local path), 6 (bare @ reference), 7 (the PR is proven absent, closed or merged), 8 (the update failed — UNKNOWN; re-read the PR before retrying), 9 (replaced but does not read back), 10 (the body asserts a control-plane, type or priority classification), 11 (a precondition read failed), 14 (the PR\'s head is not a lane branch, or the checked-out branch does not serve this PR), 15 (this session does not hold the claim). Example: fabrika build pr-body 4318 < body.md',
	),
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
		'Post the progress or handoff note on STDIN, leak-guarded and read back. When the number resolves to a PR the note is stamped with that PR\'s head SHA at post time, so a reader can see a note predates a later push. Runs ONLY the posting guards — never the tree assertions — so a stop-report stays postable from a refused tree. Prints {"answer":"posted","number":n,"commentId":n,"head":"…"|null}. Exits 1 (--token is not a claim token of this session), 3 (stdin held nothing), 5 (machine-local path), 6 (bare @ reference), 7 (target proven absent or closed), 8 (the write failed — UNKNOWN), 9 (posted but does not read back), 11 (a precondition read failed), 15 (this LANE does not hold the claim). Example: fabrika build note 4310 --token build:s-9f2e:c1a4d6f8-… < round-2.md',
	),
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
		'Post the "## Deviations" section on STDIN as the epic child\'s build-deviations marker comment — the disclosure surface a child has instead of a PR body. ONE marker per issue: the standing marker is edited in place and every superseded one of this account\'s is retracted, so `fabrika wire read --format build-deviations` never meets two conforming headings. That marker discloses the WHOLE reviewed range, so the replacement is compared against the standing disclosure and refused when it drops an entry — an entry leaves only by restating it with a **Disposition:** saying what became of it. With --standing the verb reads instead: stdin is not read, nothing is written, and the standing section is printed for the round to carry forward (empty when the child carries no marker yet). The marker line is composed from the positional, so a disclosure cannot name an issue other than the one it sits on. The section is validated through the wire format before anything is written, and the landed comment is read back from live issue state. Prints {"answer":"posted","issue":n,"commentId":n,"upsert":"created"|"edited","retracted":n,"url":"…"}. Exits 1 (--token is not a claim token of this session), 3 (stdin held nothing), 4 (the "## Deviations" section is missing or malformed), 5 (machine-local path), 6 (bare @ reference), 7 (the issue is proven absent or closed), 8 (the write failed, or a superseded marker could not be retracted — UNKNOWN), 9 (posted but does not read back), 10 (the number is a pull request, which discloses in its body), 11 (a precondition read failed), 15 (this LANE does not hold the claim), 35 (the replacement drops a standing entry). Example: fabrika build deviations 6566 --token build:s-9f2e:c1a4d6f8-… < deviations.md',
	),
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
		'The paginated, per-gate verdict fold on a PR: every comment and every review, the latest marker per gate namespace judged against the live head through bindToContent — head equality first, then the marker\'s content: digest, so a rebase that changed no content keeps its verdicts and this verb cannot disagree with ship gate; a digest that could not be derived is Unbindable and reports current:false. Native reviews are their OWN row kind (never coerced), the per-head FAIL round count, capReached, the criteria frozen at or past the declared cap round, and the findings the freeze turned away entirely — escalatedFindings folds the tagged escalation comments review append-criterion posts on the linked issue when it may no longer append, each {round, commentId, body} with the body through the content gate, so a repair round past the freeze reads the finding through this verb instead of a comment id in a spawn prompt. The child arm folds the child issue\'s own escalations the same way. Prints one JSON object with head, mergeability, rows, rounds, capReached, frozenCriteria and escalatedFindings; {"rows":[]} on exit 0 is a proven "no verdicts" about the gates, readable against the scope line. mergeability is mergeable / conflicting / unknown, read off the same single-PR GET as the head, with GitHub\'s lazily computed null kept as unknown and never as clean: a PR conflicting against its base is repair work no gate emits a FAIL for, so an all-PASS fold over one is not a no-work answer. A stale marker prints as stale, never dropped. --issue <n> folds an epic child instead, whose verdicts are range-bound comments on the issue because a child opens no PR: each row names the range it was formed over rather than a head, a round is one graded tip, and clearances are empty with the reason on stderr — a clearance is recorded against a PR\'s base branch, and a child has none. Exits 7 (PR or issue proven absent or closed, or --issue names a PR), 10 (neither or both of --pr and --issue), 11 (the head, any comment page, any review page or the linked issue\'s comment page could not be read — UNKNOWN, never "none"). Example: fabrika build verdicts --pr 4310',
	),
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
		'Record one founder-cleared repair round on a PR, refusing without a verbatim dated authorization and an invoking account inside `.fabrika.jsonc`\'s `capClearAuthors` at the PR\'s base ref. Writes the authorization comment FIRST, the `cap-cleared` marker second, then carries the grant into the local lane so `build verdicts` and the lane guard spend the same round. One grant buys exactly the round it names: it survives the push it permits and expires when the next FAIL round lands. Prints {"pr":n,"round":n,"at":"…","by":"…","authorization":n,"marker":n,"cap":n,"lane":"…","resolvesTo":"cleared"}. Exits 5 (machine-local path), 6 (bare @ reference), 7 (PR proven absent or closed, or the budget is not spent — there is no round to clear), 8 (a write failed — UNKNOWN), 9 (read-back mismatch), 11 (a precondition read failed), 25 (the invoking account may not clear a round here), 26 (--authorization missing, empty or undated), 29 (recorded on the PR, and the local lane did not take it — re-run to reconcile). Example: fabrika build clear --pr 5953 --authorization authorization.md',
	),
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
	]),
	Command.withShortDescription("Drive one construction lane from issue pick to open PR."),
	Command.withDescription(
		"Drive one construction lane end to end — prove the tree, pick and claim the issue, cut the branch, validate the tree, push, open the PR, and read the verdicts back",
	),
);
