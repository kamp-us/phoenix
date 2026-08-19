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
import {Effect, type FileSystem, Option, Result} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import {readFile} from "../io/fs.ts";
import {readStdin} from "../io/stdin.ts";
import {DEFAULT_LANES_ROOT} from "../lane/store.ts";
import type {VerbOutcome} from "../verb.ts";
import {runBranch} from "./branch-verb.ts";
import {runCheck} from "./check-verb.ts";
import {runAdopt, runClaim, runConfirm, runRelease} from "./claim-verb.ts";
import {type DocumentRead, runClear} from "./clear-verb.ts";
import {runCommit} from "./commit-verb.ts";
import {runEligible} from "./eligible-verb.ts";
import {runIssue} from "./issue-verb.ts";
import {runNote} from "./note-verb.ts";
import {runPick} from "./pick-verb.ts";
import {runPr, runPrBody} from "./pr-verb.ts";
import {runPush} from "./push-verb.ts";
import {
	ADMISSION_EXIT_CODES,
	CITATION_GRAMMAR,
	CLAIM_PURPOSES,
	DECISION_TYPE_LABEL,
	DEFAULT_CLAIM_PURPOSE,
	EPIC_TYPE_LABEL,
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

/**
 * Required, and deliberately not defaulted: it is how a verb learns WHICH lane is asking, and the
 * session id it could otherwise fall back to names every lane of the session at once (#6037).
 */
const tokenFlag = Flag.string("token").pipe(
	Flag.withDescription("the claim token `build claim` handed this lane — its identity"),
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
	Command.withShortDescription("Prove the ground is clean and this lane's, wherever it sits."),
	Command.withDescription(
		"Prove the ground: optionally clean, optionally this lane's. Where the tree sits is not asserted — isolation is the operator's call, not fabrika's. Prints the tree root's absolute path on stdout. Reads and NEVER repairs — it cleans, creates and removes nothing. Exits 11 (the tree root could not be read, or with --issue the claim state could not be read — UNKNOWN), 13 (proven: uncommitted changes at a --require-clean open), 14 (proven: the checked-out branch is not a lane branch, or does not carry the winning claim's nonce), 15 (proven: the claim on --issue is held by another session). Example: fabrika build tree --require-clean",
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
	Command.withShortDescription("The ranked pool of issues this lane may pick up."),
	Command.withDescription(
		'The ranked candidate pool: status:triaged + unassigned + admitted by the shared admission test (scope axis against the ROADMAP.md "## Campaigns" table\'s active rows, audience axis on ready-for:agent), then filtered by this verb\'s own acceptance-criteria axis — a body the wire reader does not answer Found on is excluded as no-acceptance-criteria, an axis the shared admission test does not carry because build claim reaches it over an epic, and finally by the native blocked_by graph (ADR 0301) — a candidate with any blocker still open is excluded as blocked, and one whose edge list could not be read is excluded as unreadable with its reason on stderr. Every bucket paginated in full. Prints {"pool":[…],"excluded":[{"number","home","reason"}],"scanned":{"p0":n,"p1":n,"p2":n},"campaigns":{…}}; each excluded issue names which axis refused it, and an empty pool is a fact on exit 0, readable against the scanned counts. Exits 1 (--limit is not a positive integer), 4 (the "## Campaigns" table reads but does not parse — never read as "nothing is active"), 11 (any bucket read failed or came back truncated, or the table could not be read — the pool is UNKNOWN, never partial and never unfiltered). Example: fabrika build pick --limit 5',
	),
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
		'One issue\'s dependency gate, derived from GitHub\'s native blocked_by graph and nothing else (ADR 0301) — never off a label, and never off the epic ledger\'s prose "## Dependencies" block, which is a rendering rather than an input. Prints {"answer":"eligible","number":n,"parent":n|null}; blocked and unknown print nothing. Every blocker is read before the answer is seated, so the verdict does not depend on the order the graph lists them in, and a blocker that could not be read is named on stderr as its own row rather than counted closed. Exits 7 (the issue is proven absent or closed), 11 (the issue, its parent, its edge list or a blocker could not be read, with nothing proven open — UNKNOWN, never "eligible"), 16 (proven blocked — EVERY open edge is named on stderr, alongside any blocker that could not be read). Example: fabrika build eligible 4312',
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
		token: tokenFlag.pipe(
			Flag.optional,
			Flag.withDescription(
				"the token this lane already holds, when it is re-claiming — an already-held number then answers won with that same marker and writes nothing; omit it on a fresh claim",
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
		repo: repoFlag,
	},
	Effect.fn(function* ({number, token, purpose, override, overrideLane, cites, repo}) {
		yield* emit(
			yield* runClaim({
				number,
				repo: Option.getOrNull(repo),
				env: process.env,
				uuid: randomUUID(),
				at: new Date().toISOString(),
				token: Option.getOrNull(token),
				purpose,
				override: Option.getOrNull(override),
				overrideLane: Option.getOrNull(overrideLane),
				cites: Option.getOrNull(cites),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Race the claim marker on an issue and win it or name the winner."),
	Command.withDescription(
		`Race the earliest AUTHORIZED claim marker on an issue: post this session's token (build:<CLAUDE_CODE_SESSION_ID>:<uuid>), re-read, and win or name the winner. Authorization is the author's repository permission (ADR 0055) — marker text confers nothing. The admission test runs FIRST, before any marker is written, so a refused claim leaves no trace to retract. --purpose says why this lane claims (${CLAIM_PURPOSES.join(" | ")}, default ${DEFAULT_CLAIM_PURPOSE}): the audience axis (${READY_FOR_AGENT}) binds a build claim only, because an epic earns that label AFTER it is planned and gated (#5175); the scope axis binds every purpose, and an off-enum --purpose refuses on 10 rather than falling back. --override "<reason>" admits a proven refusal and REQUIRES --override-lane "<lane>"; both are recorded on the marker, and an UNKNOWN admission is never overridable. The type axis binds a build claim against an ISSUE only, so ${DECISION_TYPE_LABEL} and ${EPIC_TYPE_LABEL} refuse before any marker is written; --cites ${CITATION_GRAMMAR} opens it on a decision whose choice a founder already recorded on that issue, and the URL must name this repository and the issue being judged. It is not an override: it says the refusal does not apply, and it is never accepted for an epic. Prints {"answer":"won","number":n,"token":"…","purpose":"…"}, plus "override":{"lane","reason"} when one was used and "cites" when a ruling was cited. --token makes the re-claim idempotent per LANE: handed the token this lane already holds, a number that lane already owns answers won with that same marker and writes nothing (#5782), while a same-session marker under another nonce is a sibling lane and races normally. A lost race retracts this run's own marker and exits 15, never 0 — including when the winner is another lane of THIS session, since ownership turns on the whole token and never the session id (#6037); an unset CLAUDE_CODE_SESSION_ID, a --token that is not a claim token of this session, an empty --override reason, an --override with no lane, or an --override-lane with no override, is 1. After the admission test, and only against an ISSUE, a blockedness gate reads the native blocked_by graph (ADR 0301): a number with any blocker still open refuses on 16 naming every one of them, and an edge list that could not be read is 11 — never "not blocked". It is not overridable, because the remedy is waiting rather than an edit. Exits 7 (issue proven absent or closed), 8 (the marker write failed — UNKNOWN; run confirm), 9 (the marker landed but does not read back), 10 (--purpose is off-enum), 15 (proven lost), 16 (proven blocked), and from the admission test: ${admissionExits}. Example: fabrika build claim 4312 --purpose gate`,
	),
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
		'Re-prove THIS LANE still holds the claim, before a mutation. --token is the lane asking: one session runs many lanes, so ownership turns on the whole token and a same-session marker under another nonce is a proven loss (#6037). Prints {"answer":"mine","number":n,"token":"…"}. Exits 1 (CLAUDE_CODE_SESSION_ID unset, or --token is not a claim token of this session), 7 (issue proven absent or closed), 11 (the marker set could not be read — UNKNOWN, never "unclaimed"), 15 (proven: held by another lane, or no claim exists — the detail is on stderr, naming both tokens). Example: fabrika build confirm 4312 --token build:s-9f2e:c1a4d6f8-…',
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
		'Retract this LANE\'s OWN claim marker, and only its own — --token says which lane that is. Prints {"answer":"released","number":n}. Exits 1 (CLAUDE_CODE_SESSION_ID unset, or --token is not a claim token of this session), 7 (issue proven absent or closed), 8 (the retraction failed — UNKNOWN), 11 (the marker set could not be read), 15 (this lane holds no claim — refusing to release another lane\'s). Example: fabrika build release 4312 --token build:s-9f2e:c1a4d6f8-…',
	),
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
		token: tokenFlag,
		repo: repoFlag,
	},
	Effect.fn(function* ({number, slug, base, resume, token, repo}) {
		yield* emit(
			yield* runBranch({
				number: Option.getOrNull(number),
				slug: Option.getOrNull(slug),
				base,
				resume: Option.getOrNull(resume),
				token,
				repo: Option.getOrNull(repo),
				env: process.env,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Cut or resume the lane's branch off a freshly fetched base."),
	Command.withDescription(
		"Cut (or resume) the lane's nonce branch off a FRESHLY FETCHED base, never a stale local ref. Prints the checked-out branch name: build/<number>-<slug>-<nonce> in create mode, build/pr-<pr>-<nonce> in resume mode, where <nonce> is the first 8 hex of --token's UUID — the token THIS lane holds, proven against the live claim before the name is composed, so a lane cannot cut a branch on a nonce that holds nothing (#6037). The branch name IS the lane record — there is no stamp file. Exits 1 (--token is not a claim token of this session), 7 (--resume's PR is proven absent, closed or merged), 10 (--slug is not kebab-case, exceeds 5 words, or is flag-shaped), 11 (the fetch failed, or the tree root or claim state could not be read), 15 (proven: the claim is held by another lane). Example: fabrika build branch 4312 --slug editor-focus-loss --token build:s-9f2e:c1a4d6f8-…",
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
		"The per-lane scratch path, allocated fail-closed: <temp root>/fabrika-build/<session-id>/<issue>-<claim-nonce>/<slug>, one absolute path on stdout, the directory created if absent. --token's nonce is what keys the namespace per LANE rather than per session, so two lanes of one session cannot clobber each other. The printed path is machine-local and must never reach a posted artifact. Exits 1 (the directory could not be created, CLAUDE_CODE_SESSION_ID is unset, or --token is not a claim token of this session), 10 (--slug carries a path separator or is not kebab-case), 11 (the claim state could not be read), 15 (proven: the claim is held by another lane). Example: fabrika build scratch 4312 --slug notes --token build:s-9f2e:c1a4d6f8-…",
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
		yield* emit(yield* runCheck({surface, repo: Option.getOrNull(repo), env: process.env}));
	}),
).pipe(
	Command.withShortDescription(
		"Run this surface's validators here, with the build cache bypassed.",
	),
	Command.withDescription(
		'Run this surface\'s validators in this tree, with the build cache BYPASSED — a cache hit from another checkout has returned another tree\'s green. Prints {"verdict":"green","surface":"…","tree":"…","ran":[…]}; red and unknown print nothing. A workflows-only diff (.github/workflows/**) is --surface workflows: actionlint over the changed files when the tree has it, plus the commands `.fabrika.jsonc` declares under `workflowValidators` (each naming the files it `reads`); a changed workflow nothing opened is reported in `unvalidated`, and a run that opened none of them is UNKNOWN. This verb predicts; the repo\'s CI gate decides, and supersedes it where they disagree. Exits 7 (the diff against the base is empty — zero scope, ADR 0092), 10 (--surface is off-enum or provably mismatches the diff), 11 (the tree root could not be read, a validator could not be executed, `.fabrika.jsonc` could not be read, or the lane\'s claim could not be read — UNKNOWN, never green), 14 (the checked-out branch is not this lane\'s), 15 (the lane\'s claim is held by another session), 18 (proven red), 22 (no surface validates any changed file). Example: fabrika build check --surface code',
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
	Command.withShortDescription("The latest gate verdict per namespace at a PR's live head."),
	Command.withDescription(
		'The paginated, current-head, per-gate verdict fold on a PR: every comment and every review, the latest marker per gate namespace bound to the live head, native reviews as their OWN row kind (never coerced), the per-head FAIL round count, capReached, and the criteria frozen after round 2. Prints one JSON object with head, rows, rounds, capReached and frozenCriteria; {"rows":[]} on exit 0 is a proven "no verdicts", readable against the scope line. A stale marker prints as stale, never dropped. Exits 7 (PR proven absent or closed), 11 (the head, any comment page or any review page could not be read — UNKNOWN, never "none"). Example: fabrika build verdicts --pr 4310',
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
				"the dead session whose claim this run adopts; naming this session refuses",
			),
		),
		reason: Flag.string("reason").pipe(
			Flag.withDescription("why the succession is taken — recorded on the marker, required"),
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
		'Post the succession marker a dead session\'s stranded claim needs: build-adopt: <dead-session> by build:<this-session>:<uuid> · <ISO> · reason: <text>. It writes ONE comment and posts no claim marker — "fabrika build release <n>" then resolves that claim as this session\'s and retracts both comments (ADR 0295). The adopted claim answers mine to confirm and admits branch/note/scratch/tree, so the successor inherits the lane; build claim over it refuses on 15, because a second marker would outlive the release. Authority is the poster\'s repository permission, read at release time (ADR 0055): an adopt from an account below write is counted, reported, and never a succession. Prints {"answer":"adopted","number":n,"session":"<dead-session>","token":"…"}. Exits 1 (CLAUDE_CODE_SESSION_ID unset, an empty --session or --reason, a --session carrying whitespace or ·, a multi-line --reason, or --session naming this very session — plain release already covers that), 7 (issue proven absent or closed), 8 (the marker write failed — UNKNOWN), 9 (the marker landed but does not read back). Example: fabrika build adopt 6037 --session 3672779a --reason "driver died in the 2026-08-18 API outage"',
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
		adopt,
		issue,
		branch,
		scratch,
		commit,
		check,
		push,
		pr,
		prBody,
		note,
		verdicts,
		clear,
	]),
	Command.withShortDescription("Drive one construction lane from issue pick to open PR."),
	Command.withDescription(
		"Drive one construction lane end to end — prove the tree, pick and claim the issue, cut the branch, validate the tree, push, open the PR, and read the verdicts back",
	),
);
