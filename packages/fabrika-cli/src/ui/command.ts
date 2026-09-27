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
import {emit} from "../emit.ts";
import {leafCommand} from "../excess-operand.ts";
import {playwrightBrowse} from "./browser.ts";
import {runEvidence} from "./evidence-verb.ts";
import {runGolden} from "./golden-verb.ts";
import {fetchGolden, ghAttachmentUpload, storeUpload} from "./http.ts";
import {runLaw} from "./law-verb.ts";
import {runManifest} from "./manifest-verb.ts";
import {runRender} from "./render-verb.ts";
import {spawnHarness} from "./server.ts";

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
		[
			"Prints this repo's design surfaces and declared `uiSurfaces` rows as JSON presence and paths.",
			"  11: a probe or the `uiSurfaces` decode failed, so presence is UNKNOWN",
			"  12: no design manifest; the route is front-door",
			'  Derivation: the build-ui skill\'s contract.md, "ui manifest"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika ui manifest"}]),
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
		[
			"Prints the schema-validated prohibition registry as JSON, rows in file order.",
			"  4: the registry violates the schema, so the whole file is refused",
			"  11: the registry could not be read, so the law is UNKNOWN",
			"  12: no design manifest",
			"  13: a manifest but no registry; the manifest's prose is the law",
			'  Derivation: the build-ui skill\'s contract.md, "ui law"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika ui law"}]),
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
				"a surface id: a bare route (/board), repeatable; at least one is required — no tool guesses surfaces from a diff",
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
		[
			"Renders the named surfaces here, captures one validated PNG each and prints the set as JSON.",
			"  Succeeds only when every requested surface captured and validated.",
			"  10: a bad --out, or a --surface that is reserved or outside every mount",
			"  11: an app never became ready, config did not decode, or validity is UNKNOWN",
			"  14: a surface threw during render",
			"  15: a surface is unreachable",
			"  16: a capture is invalid",
			"  18: the lane precondition failed",
			"  19: .fabrika.jsonc declares no `uiSurfaces` row",
			'  Derivation: the build-ui skill\'s contract.md, "ui render"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika ui render --out after --surface /pano"}]),
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
		[
			"Diffs a candidate against its surface's blessed golden and prints the signal as JSON.",
			"  An unblessed surface is an answer once the pointer read succeeded.",
			"  4: the pointer exists but does not parse",
			"  11: the pointer read, bytes fetch or hash check failed, so blessing is UNKNOWN",
			"  16: the candidate is invalid",
			'  Derivation: the build-ui skill\'s contract.md, "ui golden"',
		].join("\n"),
	),
	Command.withExamples([
		{command: "fabrika ui golden --surface /board --candidate /…/after/board.png"},
	]),
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
				attachmentUpload: ghAttachmentUpload(process.env),
			}),
		);
	}),
).pipe(
	Command.withShortDescription("Upload the before/after captures and post them on the PR."),
	Command.withDescription(
		[
			"Uploads before/after captures, posts one head-bound PR comment, reads it back and prints JSON.",
			"  4: a capture set is incomplete",
			"  5: the comment carries a machine-local path",
			"  6: a bare @ path reference",
			"  7: the PR is absent, closed or merged",
			"  8: the post failed; it may have landed",
			"  9: the read-back differs",
			"  11: a read or decode failed; nothing posted",
			"  16: a capture is invalid or off its manifest",
			"  17: an upload failed to verify; nothing posted",
			"  18: the lane precondition failed",
			"  19: .fabrika.jsonc declares no `uiSurfaces` row",
			'  Derivation: the build-ui skill\'s contract.md, "ui evidence"',
		].join("\n"),
	),
	Command.withExamples([{command: "fabrika ui evidence --pr 4318 --before before --after after"}]),
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
	Command.withShortDescription("What the visual modality adds to a construction lane."),
	Command.withDescription(
		"What the visual modality adds to a construction lane — resolve the design surfaces and the typed law, render and validate surface captures, diff them against the blessed goldens, and attach the evidence to the PR",
	),
);
