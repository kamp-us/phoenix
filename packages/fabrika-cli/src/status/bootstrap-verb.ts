/**
 * `status bootstrap` — create **one** missing repo surface from this group's own registry, and read
 * it back.
 *
 * The content is the skill's judgement; the write, the collision guard and the read-back are this
 * verb's. That split is why file content arrives on stdin: *"/fabrika shows what's missing, then
 * runs the primitives to build the missing thing"* (#4952).
 *
 * **What this builds is fixed in {@link BUILDABLE_SURFACES}, never inferred from a declaration.** A
 * row's disposition says what *the declaring skill* does when a surface is missing — `build-ui`
 * declares `design-system-manifest.md` **fail-loud** *and* points at this verb — so reading
 * `fail-loud` as "unbuildable" would make the most important onboarding surface unreachable.
 *
 * **`exists` is an exit-`0` answer, not a refusal.** A target already there is a proven fact the
 * caller acts on, and a non-zero exit cannot carry it. Nothing is written and nothing is overwritten.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {exists, readFile, writeFile} from "../io/fs.ts";
import type {Attempt} from "../io/git.ts";
import {createLabel, createUnlabelledIssue, listLabels, openIssuesTitled} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {STATUSES} from "../labels.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {AUDIENCES, PRIORITIES, TYPES} from "../triage/facets.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	NOT_BUILDABLE,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {EMPTY_CELL, row} from "./fields.ts";
import {ARTIFACT_TITLE} from "./readout-verb.ts";

const VERB = "status bootstrap";

export interface LabelSpec {
	readonly name: string;
	readonly description: string;
	/** A six-hex-digit colour, or `null` to take GitHub's default. */
	readonly color: string | null;
}

/** The description every created taxonomy label carries, so its creator is on the record. */
export const LABEL_DESCRIPTION = "created by fabrika status bootstrap label-taxonomy";

/**
 * The board label taxonomy this verb creates, in the order it reports it.
 *
 * **Every name is derived, never restated.** v1 listed the two statuses and `PRIORITIES` and stopped,
 * so a repo that ran the whole documented bootstrap still could not `triage apply`, `triage park`,
 * `plan flip` or `ship release` — each refuses a label the repo lacks (#4285), correctly, over a gap
 * this list left (#5772). Deriving from `STATUSES`, `TYPES` and `AUDIENCES` is what makes a seventh
 * `TYPES` member widen the bootstrap with no second edit here.
 */
export const TAXONOMY: ReadonlyArray<LabelSpec> = [
	...STATUSES,
	...PRIORITIES,
	...TYPES.map((type) => `type:${type}`),
	...AUDIENCES.map((audience) => `ready-for:${audience}`),
].map((name) => ({name, description: LABEL_DESCRIPTION, color: null}));

/**
 * The colour every issue-shape marker carries. Fixed here rather than left to GitHub's random
 * default, because a marker minted a different colour in each repo is one no reader recognises
 * across two boards.
 */
export const MARKER_COLOR = "1D76DB";

const marker = (name: string, thing: string): LabelSpec => ({
	name,
	description: `issue-shape marker: a ${thing} (not a pipeline state, not pickable)`,
	color: MARKER_COLOR,
});

/**
 * The issue-shape markers — what an issue *is*, as against where it sits in the pipeline.
 *
 * They are a separate surface from {@link TAXONOMY} rather than an extension of it because they are
 * a different kind of label: `status board` counts the taxonomy and `build pick` ranks on it, while
 * nothing ranks or counts these — `map open`, `spike open` and `grill open` mint issues carrying
 * them, and `graduate trail` dispatches on them. They also carry their own colour and their own
 * description grammar, which a single set could only hold behind a conditional.
 */
export const ISSUE_SHAPE_MARKERS: ReadonlyArray<LabelSpec> = [
	marker("wayfinding:map", "wayfinding map"),
	marker("prototyping:spike", "disposable prototyping spike"),
	marker("grilling:session", "grilling session"),
];

/** The artifact issue's body, fixed here so no clause defers to another skill's prose. */
export const ARTIFACT_BODY = `The durable home for the landed-decision digest. \`fabrika governance readout\` upserts a comment
here; \`fabrika status readout\` displays it. This issue stays open and is not worked.`;

/**
 * A surface carries only the fields its own kind uses, so no caller reads a `defaultPath` off a
 * label surface or a label set off a file.
 */
export type BuildableSurface =
	| {
			readonly id: string;
			readonly kind: "file";
			/** The registry default write path. */
			readonly defaultPath: string;
	  }
	| {readonly id: string; readonly kind: "labels"; readonly labels: ReadonlyArray<LabelSpec>}
	| {readonly id: string; readonly kind: "issue"};

/** Five ids. A sixth is a change to this table, not a new rule. */
export const BUILDABLE_SURFACES: ReadonlyArray<BuildableSurface> = [
	{id: "design-manifest", kind: "file", defaultPath: "design-system-manifest.md"},
	{id: "roadmap-focus", kind: "file", defaultPath: "ROADMAP.md"},
	{id: "label-taxonomy", kind: "labels", labels: TAXONOMY},
	{id: "issue-shape-markers", kind: "labels", labels: ISSUE_SHAPE_MARKERS},
	{id: "readout-artifact", kind: "issue"},
];

export const findSurface = (id: string): BuildableSurface | undefined =>
	BUILDABLE_SURFACES.find((surface) => surface.id === id);

export const knownIds = (): string => BUILDABLE_SURFACES.map((surface) => surface.id).join(", ");

export interface BootstrapInput {
	readonly surfaceId: string;
	readonly path: string | null;
	readonly json: boolean;
	readonly repoRoot: string;
	/** The resolved target repo, or the failure that makes the two non-file surfaces unanswerable. */
	readonly repo: Attempt<string>;
	readonly stdin: Effect.Effect<StdinRead>;
}

type Requirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

const created = (surfaceId: string, target: string, json: boolean, notice: string): VerbOutcome => {
	const stdout = json
		? `${JSON.stringify({outcome: "created", surfaceId, target, readback: "ok"})}\n`
		: `${row("bootstrap", "created", surfaceId, target, "ok")}\n`;
	return answer(stdout, [notice]);
};

const already = (surfaceId: string, target: string, json: boolean): VerbOutcome => {
	const stdout = json
		? `${JSON.stringify({outcome: "exists", surfaceId, target, readback: EMPTY_CELL})}\n`
		: `${row("bootstrap", "exists", surfaceId, target, EMPTY_CELL)}\n`;
	return answer(stdout, [
		`${VERB}: ${target} is already present for ${surfaceId} — nothing written.`,
	]);
};

/** The stdin content, or the refusal its three variants owe. `Failed` is `1`; empty is `3`. */
const contentOrRefusal = (read: StdinRead, surfaceId: string): string | VerbOutcome => {
	if (read._tag === "Failed") {
		return refuse(
			FAILED,
			`${VERB}: cannot read stdin: ${read.reason} — the content is UNKNOWN, never empty.`,
		);
	}
	if (read._tag === "NoStdin" || read.text.trim() === "") {
		return refuse(EMPTY_STDIN, `${VERB}: stdin held nothing — ${surfaceId} requires content.`);
	}
	const scan = scanBody(read.text);
	if (isBareAtReference(read.text)) {
		return refuse(
			BARE_AT_PATH,
			`${VERB}: the supplied content is a bare @ path reference — not redactable.`,
		);
	}
	if (scan.leaks.length > 0) {
		return refuse(
			LEAKED_PATH,
			`${VERB}: the supplied content carries a machine-local path: ${scan.leaks[0]?.class ?? ""}.`,
			renderLeaks(scan.leaks),
		);
	}
	return read.text;
};

const isOutcome = (value: string | VerbOutcome): value is VerbOutcome => typeof value !== "string";

const UNRESOLVED_REPO = refuse(
	FAILED,
	`${VERB}: cannot resolve a target repo — set CLAUDE_PIPELINE_REPO, GITHUB_REPOSITORY, or pass --repo.`,
);

const buildFile = (
	surface: Extract<BuildableSurface, {kind: "file"}>,
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const relative = input.path ?? surface.defaultPath;
		const absolute = path.resolve(input.repoRoot, relative);
		// Containment is checked on the RESOLVED path, so `../` cannot walk out of the repository.
		if (absolute !== input.repoRoot && !absolute.startsWith(`${input.repoRoot}${path.sep}`)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --path ${relative} resolves outside the repository root.`,
			);
		}
		const probe = yield* Effect.result(exists(absolute));
		if (Result.isFailure(probe)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot probe ${relative}: ${probe.failure.reason} — nothing was written.`,
			);
		}
		if (probe.success) return already(surface.id, relative, input.json);

		const content = contentOrRefusal(yield* input.stdin, surface.id);
		if (isOutcome(content)) return content;

		const written = yield* Effect.result(writeFile(absolute, content));
		if (Result.isFailure(written)) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: writing ${relative} failed: ${written.failure.reason} — whether it landed is UNKNOWN. Re-read before retrying.`,
			);
		}
		const back = yield* Effect.result(readFile(absolute));
		if (Result.isFailure(back)) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: wrote ${relative} and it could not be read back: ${back.failure.reason} — the outcome is UNKNOWN.`,
			);
		}
		if (normalizeForReadback(back.success) !== normalizeForReadback(content)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote ${relative} and the read-back differs — the outcome is UNKNOWN.`,
			);
		}
		return created(
			surface.id,
			relative,
			input.json,
			`${VERB}: created ${relative} for ${surface.id}, read-back conformed.`,
		);
	});

/**
 * **Partial existence is not existence.** `exists` requires every label in the set; where some are
 * present the verb creates only the missing ones and reports `created` naming exactly what it
 * created. A label is matched by name alone: one already there under another colour reads `exists`
 * and is left as it is, because this verb never overwrites.
 */
const buildLabels = (
	surface: Extract<BuildableSurface, {kind: "labels"}>,
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		if (input.repo._tag === "Failure") return UNRESOLVED_REPO;
		const repo = input.repo.value;
		const wanted = surface.labels;
		const names = wanted.map((label) => label.name);

		const before = yield* listLabels(repo);
		if (before._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot probe ${repo} labels: ${before.reason} — nothing was written.`,
			);
		}
		const have = new Set(before.value);
		const missing = wanted.filter((label) => !have.has(label.name));
		if (missing.length === 0) return already(surface.id, names.join(","), input.json);

		for (const label of missing) {
			const write = yield* createLabel(repo, label.name, label.description, label.color);
			if (write._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: writing label ${label.name} failed: ${write.reason} — whether it landed is UNKNOWN. Re-read before retrying.`,
				);
			}
		}
		const wrote = missing.map((label) => label.name).join(",");
		const after = yield* listLabels(repo);
		if (after._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: created ${wrote} and the label set could not be re-read: ${after.reason} — the outcome is UNKNOWN.`,
			);
		}
		const stillMissing = names.filter((name) => !after.value.includes(name));
		if (stillMissing.length > 0) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote ${wrote} and the read-back differs — ${stillMissing.join(",")} is still absent.`,
			);
		}
		return created(
			surface.id,
			wrote,
			input.json,
			`${VERB}: created ${wrote} for ${surface.id}, read-back conformed.`,
		);
	});

const buildArtifact = (
	surface: Extract<BuildableSurface, {kind: "issue"}>,
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		if (input.repo._tag === "Failure") return UNRESOLVED_REPO;
		const repo = input.repo.value;

		const before = yield* openIssuesTitled(repo, ARTIFACT_TITLE);
		if (before._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot probe ${repo} for "${ARTIFACT_TITLE}": ${before.reason} — nothing was written.`,
			);
		}
		const found = before.value[0];
		if (found !== undefined) return already(surface.id, `${repo}#${found.number}`, input.json);

		const write = yield* createUnlabelledIssue(repo, ARTIFACT_TITLE, ARTIFACT_BODY);
		if (write._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: writing the ${ARTIFACT_TITLE} issue failed: ${write.reason} — whether it landed is UNKNOWN. Re-read before retrying.`,
			);
		}
		const target = `${repo}#${write.value.number}`;
		const back = yield* openIssuesTitled(repo, ARTIFACT_TITLE);
		if (back._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: created ${target} and it could not be read back: ${back.reason} — the outcome is UNKNOWN.`,
			);
		}
		if (!back.value.some((issue) => issue.number === write.value.number)) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote ${target} and the read-back differs — it does not resolve open under that exact title.`,
			);
		}
		return created(
			surface.id,
			target,
			input.json,
			`${VERB}: created ${target} for ${surface.id}, read-back conformed.`,
		);
	});

/** One surface per invocation, deliberately: a partial write reported as success is #4557's shape. */
export const runBootstrap = (
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> => {
	const surface = findSurface(input.surfaceId);
	if (surface === undefined) {
		return Effect.succeed(
			refuse(
				NOT_BUILDABLE,
				`${VERB}: "${input.surfaceId}" is not a buildable surface. Known: ${knownIds()}.`,
			),
		);
	}
	if (surface.kind === "file") return buildFile(surface, input);
	return surface.kind === "labels" ? buildLabels(surface, input) : buildArtifact(surface, input);
};
