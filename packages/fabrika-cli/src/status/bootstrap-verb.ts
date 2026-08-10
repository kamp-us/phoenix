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
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {PRIORITIES} from "../triage/facets.ts";
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

/** The board label taxonomy this verb creates, in the order it reports them. */
export const TAXONOMY: ReadonlyArray<string> = [
	"status:needs-triage",
	"status:triaged",
	...PRIORITIES,
];

/** The description every created label carries, so its creator is on the record. */
export const LABEL_DESCRIPTION = "created by fabrika status bootstrap label-taxonomy";

/** The artifact issue's body, fixed here so no clause defers to another skill's prose. */
export const ARTIFACT_BODY = `The durable home for the landed-decision digest. \`fabrika governance readout\` upserts a comment
here; \`fabrika status readout\` displays it. This issue stays open and is not worked.`;

export interface BuildableSurface {
	readonly id: string;
	readonly kind: "file" | "labels" | "issue";
	/** The registry default write path, for a file surface. */
	readonly defaultPath: string | null;
	readonly needsStdin: boolean;
}

/** Four ids. A fifth is a change to this table, not a new rule. */
export const BUILDABLE_SURFACES: ReadonlyArray<BuildableSurface> = [
	{id: "design-manifest", kind: "file", defaultPath: "design-system-manifest.md", needsStdin: true},
	{id: "roadmap-focus", kind: "file", defaultPath: "ROADMAP.md", needsStdin: true},
	{id: "label-taxonomy", kind: "labels", defaultPath: null, needsStdin: false},
	{id: "readout-artifact", kind: "issue", defaultPath: null, needsStdin: false},
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
	surface: BuildableSurface,
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const relative = input.path ?? (surface.defaultPath as string);
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
 * created. This is the one surface holding many objects, so it is the one place the rule is stated.
 */
const buildLabels = (
	surface: BuildableSurface,
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		if (input.repo._tag === "Failure") return UNRESOLVED_REPO;
		const repo = input.repo.value;

		const before = yield* listLabels(repo);
		if (before._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot probe ${repo} labels: ${before.reason} — nothing was written.`,
			);
		}
		const have = new Set(before.value);
		const missing = TAXONOMY.filter((label) => !have.has(label));
		if (missing.length === 0) return already(surface.id, TAXONOMY.join(","), input.json);

		for (const label of missing) {
			const write = yield* createLabel(repo, label, LABEL_DESCRIPTION);
			if (write._tag === "Failure") {
				return refuse(
					WRITE_UNKNOWN,
					`${VERB}: writing label ${label} failed: ${write.reason} — whether it landed is UNKNOWN. Re-read before retrying.`,
				);
			}
		}
		const after = yield* listLabels(repo);
		if (after._tag === "Failure") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: created ${missing.join(",")} and the label set could not be re-read: ${after.reason} — the outcome is UNKNOWN.`,
			);
		}
		const stillMissing = TAXONOMY.filter((label) => !after.value.includes(label));
		if (stillMissing.length > 0) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote ${missing.join(",")} and the read-back differs — ${stillMissing.join(",")} is still absent.`,
			);
		}
		return created(
			surface.id,
			missing.join(","),
			input.json,
			`${VERB}: created ${missing.join(",")} for ${surface.id}, read-back conformed.`,
		);
	});

const buildArtifact = (
	surface: BuildableSurface,
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
