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
 */
import {tmpdir} from "node:os";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {uiCaptureOr, uiSurfacesOr} from "../config/paths.ts";
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {refuse} from "../verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {runNote} from "./note-verb.ts";
import {runPostFlags} from "./post-verb.ts";
import {captureRenderLeg} from "./render-leg.ts";
import {runRender} from "./render-verb.ts";
import {runRoute} from "./route-verb.ts";
import {githubAttachmentUploadLeg, githubPostedEvidenceCheck} from "./upload-leg.ts";

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
				"a surface id to capture — a route such as /pano, or a route plus a tier state (/pano:auth renders as the yazar test account, /pano:auth-caylak as the çaylak one), each proved signed in AND at the named tier against the preview's session endpoint before the shot is recorded; repeatable, and zero operands is refused (no tool guesses surfaces from a diff)",
			),
		),
		// `atLeast(0)` is the repeatable form with no floor: omitting it renders at desktop alone,
		// which is what every invocation written before this operand asked for implicitly.
		viewport: Flag.string("viewport").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"a viewport to shoot every --surface at — desktop (1280x800) or mobile (390x844), repeatable and crossed with --surface; each shot proves its own width off the captured PNG's bytes before it is recorded (default: desktop alone)",
			),
		),
		// `atLeast(0)` is the repeatable form with no floor: forcing nothing is the ordinary run.
		flag: Flag.string("flag").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"force one flag for this run — <key>=on|off, repeatable; rides the preview's phoenix_flag_overrides cookie, which is honored only for an authorized platform-admin actor, so every --surface must name a tier state and each forced key is proved against the preview's own evaluation before the shot is recorded",
			),
		),
		locale: Flag.string("locale").pipe(
			Flag.optional,
			Flag.withDescription(
				"render every shot in this locale — one of the values .fabrika.jsonc's uiCapture.locale declares; the declared localStorage key is seeded in each shot's browser context before it navigates, and the page's document.documentElement.lang is read back and must name the value before the shot is recorded (default: the app's own default locale, nothing seeded)",
			),
		),
		// `atLeast(0)` is the repeatable form with no floor: omitting it shoots the browser's default
		// scheme with no emulation and no proof, which is what every earlier invocation asked for.
		scheme: Flag.string("scheme").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"a colour scheme to shoot every --surface at — light or dark, repeatable and crossed with --surface and --viewport; each shot's browser context emulates prefers-color-scheme, and the root attribute .fabrika.jsonc's uiCapture.scheme declares must read back that scheme before the shot is recorded (default: the browser's own scheme, nothing emulated or proved)",
			),
		),
		app: Flag.string("app").pipe(
			Flag.optional,
			Flag.withDescription(
				"which app's sub-line of the preview comment to resolve (default: the sole app it names; ambiguity refuses)",
			),
		),
		authSecretFrom: Flag.string("auth-secret-from").pipe(
			Flag.optional,
			Flag.withDescription(
				"a file holding a session-signing secret to use instead of the repo's own (default: the committed infra/preview-auth-key/key.txt, else $BETTER_AUTH_SECRET); sourcing: the review-ui contract's \"Required environment\"",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({
		pr,
		out,
		surface,
		viewport,
		flag,
		locale,
		scheme,
		app,
		authSecretFrom,
		repo,
	}) {
		// The reviewer's own checked-out tree, never the PR head — the same read `route` takes, and
		// for the same reason: the declaration is the repo's, not the branch's.
		const surfaces = yield* uiSurfacesOr(
			"review-ui render",
			process.cwd(),
			"which app serves each --surface is UNKNOWN; nothing was rendered.",
		);
		if (surfaces._tag === "Refused") {
			yield* emit(refuse(PRECONDITION_UNKNOWN, surfaces.message));
			return;
		}
		// Read only when asked for, so a run seeding no locale and requesting no scheme is untouched by
		// the capture settings.
		const requestedLocale = Option.getOrNull(locale);
		const capture =
			requestedLocale === null && scheme.length === 0
				? null
				: yield* uiCaptureOr(
						"review-ui render",
						process.cwd(),
						"the storage key --locale seeds, or the root attribute --scheme is proved against, is UNKNOWN; nothing was rendered.",
					);
		if (capture?._tag === "Refused") {
			yield* emit(refuse(PRECONDITION_UNKNOWN, capture.message));
			return;
		}
		yield* emit(
			yield* runRender({
				pr,
				out,
				surfaces: surface,
				viewports: viewport,
				flags: flag,
				locale: requestedLocale,
				localeDeclaration: capture?.capture.locale ?? null,
				schemes: scheme,
				schemeDeclaration: capture?.capture.scheme ?? null,
				app: Option.getOrNull(app),
				surfaceRows: surfaces.surfaces,
				authSecretFrom: Option.getOrNull(authSecretFrom),
				cwd: process.cwd(),
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
		[
			"Captures the named surfaces from a PR's preview deployment and prints one JSON capture record.",
			"  7: PR absent or closed",
			"  10: an operand off its closed set, or --flag, --locale or --scheme it cannot honor",
			"  11: a read, a session, flag, locale or scheme proof, or a capture check failed (UNKNOWN)",
			"  12: the preview deploys a stale head",
			"  13: a surface threw during render",
			"  14: a surface is unreachable",
			"  15: a capture is invalid",
			"  16: no preview-deploy comment (the CANT-SEE route)",
			"  19: a capture's PNG width is not the requested viewport's",
			'  Derivation: the review-ui skill\'s contract.md, "review-ui render"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				"fabrika review-ui render --pr 4321 --out judged --surface /pano --viewport desktop --viewport mobile",
			description: "Capture one surface at both viewports",
		},
		{
			command:
				"fabrika review-ui render --pr 4321 --out schemes --surface /lab/atolye/markdown --scheme light --scheme dark",
			description: "Capture one surface in both colour schemes, each proved off the page",
		},
	]),
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
		// Repeatable only so the verb sees a repeat and refuses it — one capture set per post.
		evidence: Flag.string("evidence").pipe(
			Flag.atLeast(1),
			Flag.withDescription(
				"the review-ui render capture-set name whose verified upload is this verdict's evidence — exactly one; passing it twice is refused on 10",
			),
		),
		carrier: Flag.string("carrier").pipe(
			Flag.withDefault("marker"),
			Flag.withDescription(
				"marker (first-line SHA-bound marker) or advisory (§CP: advisory first line, `Reviewed-head: @ <sha>` in the body); advisory is a PASS path only (default: marker)",
			),
		),
		supersede: Flag.boolean("supersede").pipe(
			Flag.withDefault(false),
			Flag.withDescription(
				"acknowledge that this verdict retires a standing one of the OPPOSITE polarity at the same head; without it that post is refused at 18",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, polarity, sha, clause, evidence, carrier, supersede, repo}) {
		yield* emit(
			yield* runPostFlags({
				pr,
				polarity,
				sha,
				clause,
				evidence,
				carrier,
				supersede,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
				now: Effect.sync(() => Date.now()),
				tmpRoot: tmpdir(),
				// The reviewer's own checked-out tree, never the PR head — this skill never checks the
				// PR out, so the tier choice is read where the verb is running.
				cwd: process.cwd(),
				upload: githubAttachmentUploadLeg(process.env),
				confirm: githubPostedEvidenceCheck(process.env),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the review-ui verdict on stdin as one comment."),
	Command.withDescription(
		[
			"Posts the stdin verdict and its verified evidence as one comment; prints one JSON object.",
			"  3: empty stdin",
			"  4: no evidence manifest, or a bad `uiCapture`",
			"  5: machine-local path",
			"  6: bare @ reference",
			"  7: PR absent or closed",
			"  8: write failed (UNKNOWN)",
			"  9: posted, but the read-back fails",
			"  10: bad --polarity, --carrier or --evidence",
			"  11: a precondition read failed",
			"  12: head moved, or set rendered at another head",
			"  15: a capture fails its manifest sha",
			"  17: evidence upload failed",
			"  18: opposite verdict needs --supersede",
			'  Derivation: the review-ui skill\'s contract.md, "review-ui post"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika review-ui post 4321 --polarity FAIL --sha 03135b91 --clause "changes-requested" --evidence judged < verdict.md',
			description: "Post a FAIL over the judged capture set",
		},
	]),
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
		[
			"Posts the stdin blocker note as one new, non-verdict comment and prints one JSON object.",
			"  3: empty stdin",
			"  5: machine-local path",
			"  6: bare @ reference",
			"  7: PR absent or closed",
			"  8: the post failed (UNKNOWN)",
			"  9: the comment does not read back as sent",
			"  10: the body is verdict-shaped",
			"  11: a precondition read failed",
			'  Derivation: the review-ui skill\'s contract.md, "review-ui note"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command: "fabrika review-ui note 4321 < blocker.md",
			description: "Post a can't-see blocker note",
		},
	]),
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
		verifiedAt: Flag.string("verified-at").pipe(
			Flag.optional,
			Flag.withDescription(
				"the head a hand-verification standing in for the render ran at (7–40 lowercase hex); the route is refused when any file in that range to --sha raises the ui class, because the evidence is then spent, and refused as UNKNOWN when the two heads have diverged, because the range was never read (omit it where the route rests on no such evidence)",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, sha, clause, verifiedAt, repo}) {
		// The reviewer's own checked-out tree, never the PR head: the class this route resolves was
		// raised over these prefixes, so they are read where the verb is running.
		const surfaces = yield* uiSurfacesOr(
			"review-ui route",
			process.cwd(),
			"which paths raise the ui class is UNKNOWN; nothing was posted.",
		);
		if (surfaces._tag === "Refused") {
			yield* emit(refuse(PRECONDITION_UNKNOWN, surfaces.message));
			return;
		}
		yield* emit(
			yield* runRoute({
				pr,
				sha,
				clause,
				verifiedAt: Option.getOrNull(verifiedAt),
				uiPrefixes: surfaces.prefixes,
				repo: Option.getOrNull(repo),
				env: process.env,
				stdin: Effect.sync(readStdin),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Record that this PR renders nothing, so no verdict is owed."),
	Command.withDescription(
		[
			"Records that a PR renders nothing, bound to --sha, so no verdict is owed; prints one JSON.",
			"  3: empty stdin",
			"  5: machine-local path",
			"  6: bare @ reference",
			"  7: nothing to route, or PR absent or closed",
			"  8: the post failed (UNKNOWN)",
			"  9: read-back mismatch",
			"  10: bad --sha or --verified-at, or a blank --clause",
			"  11: a read failed, came back capped, or diverged",
			"  12: head moved, or a ui file changed since --verified-at",
			"  20: review-code FAIL, or absent on a --verified-at route",
			'  Derivation: the review-ui skill\'s contract.md, "review-ui route"',
		].join("\n"),
	),
	Command.withExamples([
		{
			command:
				'fabrika review-ui route 6326 --sha 6c6fe226 --clause "no rendered delta; both files are prose only" < why.md',
			description: "Route a prose-only PR away from review-ui",
		},
	]),
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
