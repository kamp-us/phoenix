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
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {readStdin} from "../io/stdin.ts";
import {refuse} from "../verb.ts";
import {runCiFetch} from "./ci-fetch-verb.ts";
import {runCiProduce} from "./ci-produce-verb.ts";
import {PRECONDITION_UNKNOWN} from "./codes.ts";
import {runNote} from "./note-verb.ts";
import {runPost} from "./post-verb.ts";
import {captureRenderLeg} from "./render-leg.ts";
import {runRender} from "./render-verb.ts";
import {runRoute} from "./route-verb.ts";
import {githubAttachmentUploadLeg} from "./upload-leg.ts";

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
				"a surface id to capture — a route such as /pano, or /pano:auth for the signed-in render (proved against the preview's session endpoint before the shot is recorded); repeatable, and zero operands is refused (no tool guesses surfaces from a diff)",
			),
		),
		// `atLeast(0)` is the repeatable form with no floor: forcing nothing is the ordinary run.
		flag: Flag.string("flag").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"force one flag for this run — <key>=on|off, repeatable; rides the preview's phoenix_flag_overrides cookie, which is honored only for an authorized platform-admin actor, so every --surface must name :auth and each forced key is proved against the preview's own evaluation before the shot is recorded",
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
	Effect.fn(function* ({pr, out, surface, flag, app, repo}) {
		yield* emit(
			yield* runRender({
				pr,
				out,
				surfaces: surface,
				flags: flag,
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
		"Capture the named surfaces from a PR's announced preview deployment at the inspected head, one validated PNG per surface, and write the set manifest. Prints one schema-2 JSON object: source, repository, set, PR, head, app, preview URL, exact flag operands, and one capture record per surface (path, dimensions, sha256, page errors); every surface's outcome is enumerated on stderr. Full success is the only exit 0. Exits 1 (zero --surface operands), 7 (PR absent or closed), 10 (--out is not kebab-case, a --surface names a :state nothing renders — the realized set is auth, a --flag operand is not a <key>=<on|off> pair, or --flag was passed with an anonymous surface), 11 (a read failed, the preview comment is malformed or names several apps, a capture's validity is undeterminable, an :auth surface was requested with PREVIEW_TEST_SESSION_TOKEN/BETTER_AUTH_SECRET unset, an :auth surface's session proof did not come back signed in, or a forced flag evaluated at its default anyway), 12 (the preview deploys a head that is not the PR's live head — stale preview), 13 (a surface threw during render), 14 (a surface is unreachable), 15 (a capture is invalid), 16 (no preview-deploy comment — the CANT-SEE route). Example: fabrika review-ui render --pr 4321 --out judged --surface /pano",
	),
);

const fetch = leafCommand(
	"fetch",
	{
		pr: prArg,
		harness: Flag.string("harness").pipe(
			Flag.withDescription(
				"a localhost-only harness declared by the repository's governed authority",
			),
		),
		out: Flag.string("out").pipe(
			Flag.withDescription("kebab-case reviewer-owned capture-set name"),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, harness, out, repo}) {
		yield* emit(
			yield* runCiFetch({
				pr,
				harness,
				out,
				repo: Option.getOrNull(repo),
				env: process.env,
				tmpRoot: tmpdir(),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Fetch a governed localhost harness's exact-head CI captures."),
	Command.withDescription(
		'Resolve the declared producer from the repository default branch, require its successful pull_request_target run whose Actions head_sha names the open PR\'s exact live head and whose base-owned title also binds the PR number and current authority revision, then require its named check, unique non-expired artifact, and manifest-bound authority, validate the manifest and every PNG, then materialize the set in reviewer-owned scratch. There is no local path, workflow, run, check, artifact or manifest input. Preview rendering remains the default review-ui path. Machine stdout is exactly one JSON object shaped {"answer":"fetched","render":"clean"|"red","set":string,"pr":number,"head":string,"harness":string,"run":number,"artifact":number,"check":number,"surfaces":number,"captures":[{"surface":string,"path":string,"width":number,"height":number,"sha256":string,"pageErrors":{"rows":array,"more":number}}]}. A clean accepted set prints `render:"clean"`; an accepted set with an uncaught page error prints `render:"red"` on exit 0 and is proven FAIL evidence. Exits 4 (malformed declaration/manifest), 7 (PR absent/closed), 10 (unknown harness or bad set name), 11 (producer evidence unresolved), 12 (head moved), 15 (capture hash/dimensions invalid). Example: fabrika review-ui fetch 7190 --harness tuval --out judged. Example success on a host whose temp root is /tmp: {"answer":"fetched","render":"clean","set":"judged","pr":7190,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","harness":"tuval","run":42,"artifact":51,"check":61,"surfaces":2,"captures":[{"surface":"tuval-cockpit-desktop","path":"/tmp/fabrika-review-ui/7190-03135b91/judged/captures/tuval-cockpit-desktop.png","width":1280,"height":800,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","pageErrors":{"rows":[],"more":0}},{"surface":"tuval-cockpit-mobile","path":"/tmp/fabrika-review-ui/7190-03135b91/judged/captures/tuval-cockpit-mobile.png","width":390,"height":844,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pageErrors":{"rows":[],"more":0}}]}',
	),
);

const ciProduce = leafCommand(
	"ci-produce",
	{
		pr: prArg,
		head: Flag.string("head").pipe(
			Flag.withDescription("the exact lowercase 40-character PR head checked out as the subject"),
		),
		authorityHead: Flag.string("authority-head").pipe(
			Flag.withDescription(
				"the exact default-branch authority revision checked out as trusted code",
			),
		),
		harness: Flag.string("harness").pipe(
			Flag.withDescription("the localhost harness id from the trusted declaration"),
		),
		runId: Flag.integer("run-id").pipe(
			Flag.withDescription("the positive GitHub Actions run id bound into the manifest"),
		),
		repository: Flag.string("repository").pipe(
			Flag.withDescription("the owner/name repository identity bound into the manifest"),
		),
		subjectRoot: Flag.string("subject-root").pipe(
			Flag.withDescription("the exact-head subject input to the trusted image recipe"),
		),
		authorityRoot: Flag.string("authority-root").pipe(
			Flag.withDescription("the trusted base checkout containing the declaration and producer"),
		),
		outputDir: Flag.string("output-dir").pipe(
			Flag.withDescription("the trusted host directory where captures and manifest are written"),
		),
	},
	Effect.fn(function* (options) {
		yield* emit(yield* runCiProduce({...options, env: process.env}));
	}),
).pipe(
	Command.withShortDescription(
		"Produce the governed localhost capture artifact inside trusted CI.",
	),
	Command.withDescription(
		'Internal trusted-workflow leg: the image build performs only fixed-tool setup and a scriptless dependency fetch, then an offline PR lifecycle install plus test run in one disposable workspace and a separate offline, declaration-command build in the read-only-served workspace, all under read-only-root/capability-drop/no-network isolation with two CPUs, 2 GiB memory, 256 PIDs, bounded tmpfs workspaces, deterministic container names, unconditional force-removal, and no published port. A base-owned capture sidecar shares only the server\'s isolated network namespace to reach loopback; the host validates its output and alone writes the versioned manifest. The PR server receives no credentials, authority, Docker socket, or output mount. Machine stdout is exactly one version-1 manifest shaped {"schemaVersion":1,"source":"github-actions","repository":string,"pr":number,"head":string,"harness":string,"declarationSha256":string,"producer":{"workflow":string,"check":string,"event":"pull_request_target","runId":number,"artifact":string,"authorityHead":string},"captures":[{"surface":string,"route":string,"state":string,"path":string,"width":number,"height":number,"sha256":string,"pageErrors":{"rows":array,"more":number},"errorCoverage":{"pageerror":"readable","consoleError":"readable"}}]}. Exits 4 (trusted declaration malformed), 10 (subject head, authority head, run, repository, harness or subject root .dockerignore off vocabulary), 11 (checkout/image/workspace/governed journey/server build/readiness/capture/output state UNKNOWN), 12 (subject or authority checkout is not its named exact head), 14 (navigation has no successful HTTP response), 15 (capture bytes invalid). A successful journey\'s later page errors remain publishable for fetch to classify as proven red on 13. This is an internal workflow interface with required --repository, not the reviewer-facing optional --repo contract and not an evidence import path. Example: fabrika review-ui ci-produce 7190 --head 03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c --authority-head cccccccccccccccccccccccccccccccccccccccc --harness tuval --run-id 42 --repository kamp-us/phoenix --subject-root /github/workspace/subject --authority-root /github/workspace/authority --output-dir /github/workspace/review-ui-localhost-tuval. Example success: {"schemaVersion":1,"source":"github-actions","repository":"kamp-us/phoenix","pr":7190,"head":"03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c","harness":"tuval","declarationSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","producer":{"workflow":".github/workflows/review-ui-localhost-evidence.yml","check":"review-ui localhost evidence / tuval","event":"pull_request_target","runId":42,"artifact":"review-ui-localhost-tuval","authorityHead":"cccccccccccccccccccccccccccccccccccccccc"},"captures":[{"surface":"tuval-cockpit-desktop","route":"/","state":"desktop","path":"captures/tuval-cockpit-desktop.png","width":1280,"height":800,"sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pageErrors":{"rows":[],"more":0},"errorCoverage":{"pageerror":"readable","consoleError":"readable"}}]}',
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
				"the kebab-case review-ui render or provenance-validated review-ui fetch set whose bytes are independently revalidated before verified upload",
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
				renderPreview: captureRenderLeg,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Post the review-ui verdict on stdin as one comment."),
	Command.withDescription(
		'Post the review-ui verdict on STDIN as ONE comment for this namespace — re-resolve the live head, read the evidence set through its manifest, independently re-render preview evidence or for CI evidence re-resolve the governed workflow/run/check/artifact ids through GitHub, re-validate every capture, verify-upload every capture BEFORE anything posts, record complete provenance, compose through the `verdict-marker` wire format, leak-scan, upsert, and read back. There is no --namespace. Prints one JSON object. Exits 3 (empty stdin), 4 (manifest/preview-recapture/receipt/declaration/identity malformed or design-harness.json invalid), 5 (machine-local path), 6 (bare @ reference), 7 (PR absent/closed), 8 (create/edit UNKNOWN), 9 (read-back mismatch), 10 (bad polarity/carrier), 11 (precondition or trusted provenance read failed), 12 (head/pixels stale), 13 (CI page crash cannot carry PASS), 15 (capture invalid), 17 (upload verification failed). Example: fabrika review-ui post 4321 --polarity FAIL --sha 03135b91 --clause "changes-requested" --evidence judged < verdict.md',
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
		"Post the blocker note on STDIN as one new comment — the typed non-verdict write for a proven can't-see or escalation state. Append-only, leak-scanned, and read back. A body whose first line parses as a verdict marker or an advisory carrier is refused: a verdict goes through review-ui post. Prints one JSON object. Exits 3 (empty stdin), 5 (machine-local path), 6 (bare @ reference), 7 (PR absent or closed), 8 (the post failed — UNKNOWN), 9 (the comment does not read back as sent), 10 (the body is verdict-shaped), 11 (a precondition read failed — nothing was posted). Example: fabrika review-ui note 4321 < blocker.md",
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
		"Record, bound to the head whose diff you read, that this PR moves no pixels — so review-ui owes it no verdict and ship's gate resolves the namespace as routed (ADR 0316). The reasoning arrives on STDIN, the record's first line is composed through the `routed-elsewhere` wire format, and both are leak-scanned, upserted as one comment and read back. It is not a verdict: the format carries no polarity, the record is head-bound so any push voids it, and no capture evidence is involved either way. Whether the diff renders anything is your judgment over `review diff`, never a verb's. Prints one JSON object. Exits 3 (empty stdin), 5 (machine-local path), 6 (bare @ reference), 7 (PR absent, closed, empty, or its diff raises no ui class — nothing to route), 8 (the post failed — UNKNOWN), 9 (the record does not read back as sent), 10 (bad --sha or a blank --clause), 11 (a precondition read failed or the file list was truncated — nothing was posted), 12 (the live head moved past --sha). Example: fabrika review-ui route 6326 --sha 6c6fe226 --clause \"no rendered delta; both files are prose only\" < why.md",
	),
);

export const reviewUiCommand = Command.make("review-ui").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		render,
		fetch,
		ciProduce,
		post,
		note,
		route,
	]),
	Command.withShortDescription("Judge a UI pull request over governed rendered evidence."),
	Command.withDescription(
		"Judge a UI pull request over its preview deployment by default. A governed localhost-only declaration is the sole CI-evidence exception: fetch its exact-head artifact instead of running PR code on the reviewer's machine. Resolve the review-ui namespace through one of the three sanctioned writes: the verdict, a typed blocker note, or a routed-elsewhere record for a PR that renders nothing.",
	),
);
