/**
 * The `review-ui` verb group — `fabrika review-ui <verb>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), wires the two impure legs — the capture render and the verified
 * evidence upload — runs the pure verb, and emits its outcome. Every decision lives in the
 * `*-verb.ts` modules beside it.
 *
 * **Every leaf is declared with `leafCommand`, never a bare `Command.make`** — the bare form
 * silently opts out of the excess-operand guard.
 *
 * No `--json` anywhere: each verb's answer is one JSON object, so there is no second output shape
 * to opt into.
 */
import {tmpdir} from "node:os";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {designHarnessOr} from "../config/paths.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {refuse, type VerbOutcome} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {runNote} from "./note-verb.ts";
import {runPost} from "./post-verb.ts";
import {captureRenderLeg} from "./render-leg.ts";
import {runRender} from "./render-verb.ts";
import {runRoute} from "./route-verb.ts";
import {githubAttachmentUploadLeg} from "./upload-leg.ts";

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

const prArg = Argument.integer("pr").pipe(
	Argument.withDescription("the pull-request number this verb acts on"),
);

const render = leafCommand(
	"render",
	{
		pr: Flag.integer("pr").pipe(
			Flag.withDescription("the pull request whose preview deployment is judged"),
		),
		out: Flag.string("out").pipe(
			Flag.withDescription(
				"kebab-case capture-set name; captures land under <OS temp>/fabrika-review-ui/<pr>-<head8>/<set>/",
			),
		),
		// `atLeast(1)` is the repeatable form AND the floor: the parser refuses zero surfaces on `1`
		// before the verb runs, so "rendered nothing, found nothing wrong" is unrepresentable.
		surface: Flag.string("surface").pipe(
			Flag.atLeast(1),
			Flag.withDescription(
				"a surface id to capture — a bare route such as /pano; repeatable, and zero operands is refused (no tool guesses surfaces from a diff)",
			),
		),
		app: Flag.string("app").pipe(
			Flag.optional,
			Flag.withDescription(
				"which app's sub-line of the preview comment to resolve (default: the sole app it names; ambiguity refuses)",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, out, surface, app, repo}) {
		yield* emit(
			yield* runRender({
				pr,
				out,
				surfaces: surface,
				app: Option.getOrNull(app),
				repo: Option.getOrNull(repo),
				env: process.env,
				tmpRoot: tmpdir(),
				render: captureRenderLeg,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Capture the named surfaces from a PR's preview deployment."),
	Command.withDescription(
		"Capture the named surfaces from a PR's announced preview deployment at the inspected head, one validated PNG per surface, and write the set manifest. Prints one JSON object: the set, the PR, the head, the preview URL, and one capture record per surface (path, dimensions, sha256, page errors); every surface's outcome is enumerated on stderr. Full success is the only exit 0. Exits 1 (zero --surface operands), 7 (PR absent or closed), 10 (--out is not kebab-case, or a --surface carries the reserved :state suffix), 11 (a read failed, the preview comment is malformed or names several apps, or a capture's validity is undeterminable), 12 (the preview deploys a head that is not the PR's live head — stale preview), 13 (a surface threw during render), 14 (a surface is unreachable), 15 (a capture is invalid), 16 (no preview-deploy comment — the CANT-SEE route). Example: fabrika review-ui render --pr 4321 --out judged --surface /pano",
	),
);

const post = leafCommand(
	"post",
	{
		pr: prArg,
		polarity: Flag.string("polarity").pipe(
			Flag.withDescription("PASS or FAIL — a third token is not a polarity"),
		),
		sha: Flag.string("sha").pipe(
			Flag.withDescription("the head the reviewer actually inspected (7–40 lowercase hex)"),
		),
		clause: Flag.string("clause").pipe(
			Flag.withDescription("the human clause the marker ends with; blank is not a clause"),
		),
		evidence: Flag.string("evidence").pipe(
			Flag.withDescription(
				"the review-ui render capture-set name whose verified upload is this verdict's evidence",
			),
		),
		carrier: Flag.string("carrier").pipe(
			Flag.withDefault("marker"),
			Flag.withDescription(
				"marker (first-line SHA-bound marker) or advisory (§CP: advisory first line, `Reviewed-head: @ <sha>` in the body); advisory is a PASS path only (default: marker)",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, polarity, sha, clause, evidence, carrier, repo}) {
		// The reviewer's own checked-out tree, never the PR head — this skill never checks the PR
		// out, so the tier choice is read where the verb is running.
		const declared = yield* designHarnessOr(
			"review-ui post",
			process.cwd(),
			"which evidence tier this verdict may use is UNKNOWN; nothing was uploaded or posted.",
		);
		if (declared._tag === "Refused") {
			yield* emit(refuse(PRECONDITION_UNKNOWN, declared.message));
			return;
		}
		yield* emit(
			yield* runPost({
				pr,
				polarity,
				sha,
				clause,
				evidence,
				carrier,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
				tmpRoot: tmpdir(),
				harnessPath: `${process.cwd()}/${declared.path}`,
				upload: githubAttachmentUploadLeg(process.env),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the review-ui verdict on stdin as one comment."),
	Command.withDescription(
		'Post the review-ui verdict on STDIN as ONE comment for this namespace — re-resolve the live head, read the evidence set through its manifest, re-validate every capture, verify-upload every capture BEFORE anything posts, compose the first line through the `verdict-marker` wire format, leak-scan, upsert, and read it back from live state. There is no --namespace: this group emits review-ui and nothing else. Prints one JSON object. Exits 3 (empty stdin), 4 (the evidence set has no readable manifest.json, or design-harness.json violates its schema), 5 (machine-local path in the assembled comment), 6 (bare @ reference), 7 (PR absent or closed), 8 (the create/edit failed — UNKNOWN), 9 (read-back does not yield this marker), 10 (bad --polarity or --carrier, or advisory with FAIL), 11 (a precondition read failed — nothing uploaded or posted), 12 (the live head moved past --sha, or the set was rendered at another head), 15 (a capture fails its manifest sha), 17 (an evidence upload or its verification failed — nothing was posted). Example: fabrika review-ui post 4321 --polarity FAIL --sha 03135b91 --clause "changes-requested" --evidence judged < verdict.md',
	),
);

const note = leafCommand(
	"note",
	{pr: prArg, repo: repoFlag},
	Effect.fn(function* ({pr, repo}) {
		yield* emit(
			yield* runNote({
				pr,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post a blocker note when the surfaces cannot be seen."),
	Command.withDescription(
		"Post the blocker note on STDIN as one new comment — the typed non-verdict write for a proven can't-see or escalation state. Append-only (a dated fact is never edited in place), leak-scanned, and read back. A body whose first line parses as a verdict marker or an advisory carrier is refused: a verdict goes through review-ui post. Prints one JSON object. Exits 3 (empty stdin), 5 (machine-local path), 6 (bare @ reference), 7 (PR absent or closed), 8 (the post failed — UNKNOWN), 9 (the comment does not read back as sent), 10 (the body is verdict-shaped), 11 (a precondition read failed — nothing was posted). Example: fabrika review-ui note 4321 < blocker.md",
	),
);

const route = leafCommand(
	"route",
	{
		pr: prArg,
		sha: Flag.string("sha").pipe(
			Flag.withDescription("the head whose diff was read (7–40 lowercase hex)"),
		),
		clause: Flag.string("clause").pipe(
			Flag.withDescription("the one-line why this PR renders nothing; blank is not a reason"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, sha, clause, repo}) {
		yield* emit(
			yield* runRoute({
				pr,
				sha,
				clause,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Record that this PR renders nothing, so no verdict is owed."),
	Command.withDescription(
		"Record, bound to the head whose diff you read, that this PR moves no pixels — so review-ui owes it no verdict and ship gate resolves the namespace as routed instead of blocking on an absence no sanctioned path could fill (ADR 0316). The reasoning arrives on STDIN, the record's first line is composed through the `routed-elsewhere` wire format, and both are leak-scanned, upserted as one comment and read back. It is not a verdict: the format carries no polarity, the record is head-bound so any push voids it, and no capture evidence is involved either way. Whether the diff renders anything is your judgment over `review diff`, never a verb's. Prints one JSON object. Exits 3 (empty stdin), 5 (machine-local path), 6 (bare @ reference), 7 (PR absent, closed, empty, or its diff raises no ui class — nothing to route), 8 (the post failed — UNKNOWN), 9 (the record does not read back as sent), 10 (bad --sha or a blank --clause), 11 (a precondition read failed or the file list was truncated — nothing was posted), 12 (the live head moved past --sha). Example: fabrika review-ui route 6326 --sha 6c6fe226 --clause \"no rendered delta; both files are prose only\" < why.md",
	),
);

export const reviewUiCommand = Command.make("review-ui").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		render,
		post,
		note,
		route,
	]),
	Command.withShortDescription("Judge a UI pull request over its preview deployment."),
	Command.withDescription(
		"Judge a UI pull request over its preview deployment — capture the named surfaces at the inspected head, and resolve the review-ui namespace through one of the three sanctioned writes: the verdict, a typed blocker note, or a routed-elsewhere record for a PR that renders nothing",
	),
);
