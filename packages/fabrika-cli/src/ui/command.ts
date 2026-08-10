/**
 * The `ui` verb group — `fabrika ui <verb>`.
 *
 * The adapter and nothing else: it declares the flags (`--help` is the interface, so every flag
 * carries a one-line description), supplies the impure legs, runs the pure verb, and emits its
 * outcome. Every decision lives in the `*-verb.ts` modules beside it, which is what makes each
 * refusal testable without spawning a process or a browser.
 *
 * Every leaf is declared with `leafCommand`, never a bare `Command.make` — the bare form silently
 * opts out of the excess-operand guard, which `../excess-operand.unit.test.ts` reds on.
 */
import {tmpdir} from "node:os";
import {Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {leafCommand} from "../excess-operand.ts";
import type {VerbOutcome} from "../verb.ts";
import {playwrightBrowse} from "./browser.ts";
import {runEvidence} from "./evidence-verb.ts";
import {runGolden} from "./golden-verb.ts";
import {fetchGolden, ghAttachmentUpload, storeUpload} from "./http.ts";
import {runLaw} from "./law-verb.ts";
import {runManifest} from "./manifest-verb.ts";
import {runRender} from "./render-verb.ts";
import {spawnHarness} from "./server.ts";

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

const manifest = leafCommand(
	"manifest",
	{},
	Effect.fn(function* () {
		yield* emit(yield* runManifest());
	}),
).pipe(
	Command.withShortDescription("This repo's design surfaces, as presence and paths."),
	Command.withDescription(
		'Resolve this repo\'s design surfaces by convention — manifest, prohibition registry, component inventory, golden pointer, render harness — as presence and paths, never a judgment. Prints {"manifest","registry","inventory","goldenPointer","harness","lawSource"}, each path repo-root-relative or null, with lawSource "registry" or "manifest-prose". Exits 11 (the repo root or a convention path could not be probed — presence is UNKNOWN, never "absent"), 12 (proven: no design manifest — the repo is un-bootstrapped; route to front-door). Example: fabrika ui manifest',
	),
);

const law = leafCommand(
	"law",
	{},
	Effect.fn(function* () {
		yield* emit(yield* runLaw());
	}),
).pipe(
	Command.withShortDescription("The typed prohibition registry, in file order."),
	Command.withDescription(
		'The typed prohibition registry, schema-validated whole-file, rows in file order. Prints {"lawSource":"registry","rows":[…]}; there is no empty answer, because a law file that names no law is malformed rather than minimal. Exits 4 (the registry exists but violates the schema — missing/extra field, duplicate id, off-enum value, zero rows, unparseable JSON; the whole file is refused), 11 (the registry could not be read — the law is UNKNOWN, never "untyped"), 12 (proven: no design manifest), 13 (proven: manifest present, no registry — the law is untyped and the manifest\'s prose is the source). Example: fabrika ui law',
	),
);

const render = leafCommand(
	"render",
	{
		out: Flag.string("out").pipe(
			Flag.withDescription("kebab-case capture-set name; captures land under the lane scratch dir"),
		),
		surface: Flag.string("surface").pipe(
			Flag.atLeast(1),
			Flag.withDescription(
				"a surface id: a bare route (/pano), repeatable; at least one is required — no tool guesses surfaces from a diff",
			),
		),
		firstRender: Flag.string("first-render").pipe(
			Flag.atLeast(0),
			Flag.withDescription(
				"a listed surface that has no pre-change state; recorded as firstRender and exempted from before/after pairing",
			),
		),
		repo: repoFlag,
	},
	Effect.fn(function* ({out, surface, firstRender, repo}) {
		yield* emit(
			yield* runRender({
				out,
				surfaces: surface,
				firstRender,
				repo: Option.getOrNull(repo),
				env: process.env,
				tmpRoot: tmpdir(),
				startHarness: spawnHarness,
				browse: playwrightBrowse,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Render the named surfaces here and capture one PNG each."),
	Command.withDescription(
		'Render the named surfaces in this tree and capture one VALIDATED PNG per surface, into <set>/ under the lane scratch dir, plus a <set>/manifest.json byte-identical to the stdout JSON. Prints {"set","captures":[{"surface","path","width","height","sha256","firstRender"}]} and exits 0 only when EVERY requested surface captured and validated. Emits no verdict, no score and no layout opinion. Exits 4 (design-harness.json violates its schema), 10 (--out is not kebab-case, or a --surface carries the reserved :state suffix), 11 (the harness never became ready, or a capture\'s validity could not be determined — UNKNOWN), 14 (proven: a surface threw during render), 15 (proven: a surface is unreachable), 16 (proven: a capture is invalid), 18 (proven: the lane precondition failed), 19 (proven: no design-harness.json). Example: fabrika ui render --out after --surface /pano',
	),
);

const golden = leafCommand(
	"golden",
	{
		surface: Flag.string("surface").pipe(
			Flag.withDescription("the surface id whose blessed golden to resolve"),
		),
		candidate: Flag.string("candidate").pipe(
			Flag.optional,
			Flag.withDescription(
				"a candidate PNG to diff against the golden; a relative path resolves against $FABRIKA_INVOCATION_DIR",
			),
		),
	},
	Effect.fn(function* ({surface, candidate}) {
		yield* emit(
			yield* runGolden({
				surface,
				candidate: Option.getOrNull(candidate),
				env: process.env,
				tmpRoot: tmpdir(),
				fetch: fetchGolden,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Diff a candidate surface against its blessed golden."),
	Command.withDescription(
		'Resolve a surface\'s blessed golden and diff a candidate against it — signal, never verdict. Prints {"surface","blessed","golden","diff"}; an unblessed surface is a FACT on exit 0, but only after a pointer read that succeeded. The diff is the contract\'s number: a pixel differs above a per-channel delta of 10, magnitude is differing/total rounded to 3 decimals, regions are 8-connected boxes merged under 16px, largest first, capped at 20; a dimension mismatch is {"magnitude":1,"regions":[],"dimensionMismatch":true}. Exits 4 (the pointer exists but does not parse — never read as an empty blessed set), 11 (the pointer read, the bytes fetch or their hash check failed — blessing is UNKNOWN), 16 (proven: the candidate is invalid). Example: fabrika ui golden --surface /pano --candidate /…/after/pano.png',
	),
);

const evidence = leafCommand(
	"evidence",
	{
		pr: Flag.integer("pr").pipe(
			Flag.withDescription("the pull request the evidence comment posts to"),
		),
		before: Flag.string("before").pipe(
			Flag.optional,
			Flag.withDescription(
				"the before capture-set name; omit only when every after-surface is firstRender",
			),
		),
		after: Flag.string("after").pipe(Flag.withDescription("the after capture-set name")),
		repo: repoFlag,
	},
	Effect.fn(function* ({pr, before, after, repo}) {
		yield* emit(
			yield* runEvidence({
				pr,
				before: Option.getOrNull(before),
				after,
				repo: Option.getOrNull(repo),
				env: process.env,
				tmpRoot: tmpdir(),
				storeUpload,
				attachmentUpload: ghAttachmentUpload,
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Upload the before/after captures and post them on the PR."),
	Command.withDescription(
		'Upload the before/after captures, verify EVERY upload, post one head-SHA-bound PR comment, and read it back. Prints {"answer":"attached","pr","commentId","head","surfaces"}. Evidence is all-or-nothing: one failed upload or verification is 17 with nothing posted. Exits 4 (an after-surface has no before and no firstRender mark, a set is missing its manifest.json, or design-harness.json violates its schema), 5 (the comment carries a machine-local path), 6 (the comment is a bare @ path reference), 7 (the PR is proven absent, closed or merged), 8 (the post failed — it may or may not have landed), 9 (the comment landed but does not read back as sent), 11 (a precondition read failed — nothing was uploaded or posted), 16 (proven: a capture is invalid or no longer matches its manifest sha), 17 (proven: an upload or its verification failed), 18 (proven: the lane precondition failed). Example: fabrika ui evidence --pr 4318 --before before --after after',
	),
);

export const uiCommand = Command.make("ui").pipe(
	Command.withSubcommands([
		// One leaf per line, so concurrent slices append at distinct lines rather than all editing one.
		manifest,
		law,
		render,
		golden,
		evidence,
	]),
	Command.withDescription(
		"What the visual modality adds to a construction lane — resolve the design surfaces and the typed law, render and validate surface captures, diff them against the blessed goldens, and attach the evidence to the PR",
	),
);
