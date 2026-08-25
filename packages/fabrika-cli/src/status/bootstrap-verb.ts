/**
 * `status bootstrap` — create **one** missing repo surface from this group's own registry, and read
 * it back.
 *
 * The content is the skill's judgement; the write, the collision guard and the read-back are this
 * verb's. That split is why file content arrives on stdin: *"/fabrika shows what's missing, then
 * runs the primitives to build the missing thing"* (#4952). A **line** surface is the exception and
 * carries its own text here: a caller supplying it would let two repos spell one block two ways.
 *
 * **What this builds is fixed in {@link BUILDABLE_SURFACES}, never read off a disposition.** A
 * surface's disposition in `surfaceDispositions` says what happens to a *run* that finds it missing —
 * `design-manifest` is `fail-loud` and buildable here at once — so reading `fail-loud` as
 * "unbuildable" would make the most important onboarding surface unreachable.
 *
 * **`exists` is an exit-`0` answer, not a refusal.** A target already there is a proven fact the
 * caller acts on, and a non-zero exit cannot carry it. Nothing is written and nothing is overwritten.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {audienceLabel, type BoardVocabulary, statusList, typeLabel} from "../config/board.ts";
import {CONFIG_PATH, type ConfigSource} from "../config/document.ts";
import {loadConfig} from "../config/load.ts";
import {type Read, readRoadmapFile} from "../config/paths.ts";
import {resolveBoard} from "../config/resolve-board.ts";
import {appendText, exists, readFile, writeFile} from "../io/fs.ts";
import type {Attempt} from "../io/git.ts";
import {
	createLabel,
	createUnlabelledIssue,
	getIssue,
	listLabels,
	openIssuesTitled,
} from "../io/issues.ts";
import type {StdinRead} from "../io/stdin.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {DEFAULT_BOARD_VOCABULARY, FACET_VOCABULARY} from "../triage/facets.ts";
import {parseRoadmap, ROADMAP_FILE} from "../triage/roadmap.ts";
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
 * **Every name is derived, never restated.** v1 listed the two statuses and the priorities and
 * stopped, so a repo that ran the whole documented bootstrap still could not `triage apply`,
 * `triage park`, `plan flip` or `ship release` — each refuses a label the repo lacks (#4285),
 * correctly, over a gap that list left (#5772). Deriving it from the board vocabulary is what makes
 * a seventh type widen the bootstrap with no second edit here — and what makes a repo that declared
 * its own vocabulary get *its* labels rather than phoenix's (#6294).
 */
export const taxonomy = (board: BoardVocabulary): ReadonlyArray<LabelSpec> =>
	[
		...statusList(board.statuses),
		...board.priorities,
		...board.types.map(typeLabel),
		...board.audiences.map(audienceLabel),
	].map((name) => ({name, description: LABEL_DESCRIPTION, color: null}));

/** The taxonomy a repo that declared no vocabulary gets — phoenix's own. */
export const TAXONOMY: ReadonlyArray<LabelSpec> = taxonomy(DEFAULT_BOARD_VOCABULARY);

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
 * What a machine-read file's own parser saw in the bytes just written: a clause for the notice, and
 * the same numbers as `--json` fields.
 *
 * **Reported, never enforced.** The read-back predicate stays the byte match, so a zero-row roadmap
 * is still `created`. Refusing an unjoinable roadmap is `triage homes`'s exit `7`, at the point the
 * rows are actually needed.
 */
export interface ContentCount {
	/** The clause appended to the `created` notice, e.g. `3 arcs, 0 campaigns`. */
	readonly clause: string;
	/** The same counts, merged into the `--json` object. */
	readonly fields: Readonly<Record<string, number>>;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The `roadmap-focus` count: what {@link parseRoadmap} joins out of the roadmap just written.
 *
 * A roadmap is the one buildable file whose shape is not the drafting skill's judgement — it is a
 * grammar `triage homes` joins milestones through — so the write says what parsed rather than
 * leaving an inert draft to be discovered in some later session (#5778).
 */
export const roadmapCount = (text: string): ContentCount => {
	const {arcs, campaigns} = parseRoadmap(text);
	return {
		clause: `${plural(arcs.length, "arc")}, ${plural(campaigns.length, "campaign")}`,
		fields: {arcs: arcs.length, campaigns: campaigns.length},
	};
};

/**
 * A surface carries only the fields its own kind uses, so no caller reads a `defaultPath` off a
 * label surface or a label set off a file.
 */
export type BuildableSurface =
	| {
			readonly id: string;
			readonly kind: "file";
			/** The registry default write path — where this lands in a repo that declares nothing. */
			readonly defaultPath: string;
			/**
			 * How the repo names this file in `.fabrika.jsonc`, when it may name it at all.
			 *
			 * Absent means the path is fixed by convention and only `--path` moves it. Present means a
			 * bootstrap must scaffold where the *readers* look: writing `ROADMAP.md` in a repo whose
			 * fence reads `PLAN.md` leaves an inert file and no signal that it is inert.
			 */
			readonly declared?: (
				root: string,
			) => Effect.Effect<Read<string>, never, FileSystem.FileSystem | Path.Path>;
			/**
			 * Present only where the content is machine-read. Absent leaves the notice and the `--json`
			 * object exactly as they were, which is what keeps the other surfaces byte-identical.
			 */
			readonly count?: (text: string) => ContentCount;
	  }
	| {
			readonly id: string;
			readonly kind: "line";
			/** The registry default target — a file the repo owns that this appends to, never rewrites. */
			readonly defaultPath: string;
			/** The block appended when {@link marker} is absent; the marker is a line of the block itself. */
			readonly block: string;
			/** The substring that decides `exists`, and the whole of the read-back. */
			readonly marker: string;
	  }
	| {
			readonly id: string;
			readonly kind: "labels";
			/**
			 * Derived from the resolved board rather than fixed, so a repo that declared its own
			 * vocabulary is bootstrapped into *its* taxonomy. The markers ignore the argument: what an
			 * issue *is* is fabrika's vocabulary, not the host repo's.
			 */
			readonly labels: (board: BoardVocabulary) => ReadonlyArray<LabelSpec>;
	  }
	| {readonly id: string; readonly kind: "issue"};

/** The `.gitignore` row that keeps `fabrika lane`'s per-checkout state out of shared history. */
export const FABRIKA_IGNORE_ROW = "/.fabrika/";

const FABRIKA_IGNORE_BLOCK = `# fabrika's local machine state — the per-lane ledger \`fabrika lane\` writes under
# \`.fabrika/lanes/<n>/\`. One machine's run log; never committed.
${FABRIKA_IGNORE_ROW}`;

/** The marker heading that decides `exists` for the CLAUDE.md section, and its first line. */
export const CLAUDE_MD_MARKER = "## Work flows through fabrika";

/**
 * The canonical operator-first "work flows through fabrika" CLAUDE.md section, fixed in code as
 * the single source (ADR 0334's append-if-absent arm). Repo-specific adaptation — tone, carve-outs
 * like a no-ADRs rule — stays with the adopting agent in the front-door flow; this verb emits the
 * canonical text and no repo-specific branches (#7008).
 */
export const CLAUDE_MD_SECTION = `${CLAUDE_MD_MARKER}

report → triage → plan → build → review → ship. Every unit of work is a GitHub issue moving
through those stages; the fabrika skills run them, and the \`fabrika\` CLI's verbs are the ground
truth at every step.

**The default unit of work is a lane, and the operator drives it.** To get an issue built,
reviewed and shipped, spawn ONE **operator** on it (\`operate\` skill) — it runs the builder,
reviewer and shipper shells itself, feeds every outcome back to the lane ledger, and parks to a
human only when a gate genuinely needs one. Do not hand-dispatch the per-stage shells for normal
work, and never route around them with an ad-hoc general-purpose subagent — an off-pipeline run
skips the gates.

| Work intent | Skill | Agent |
|---|---|---|
| Get one issue built → reviewed → shipped | \`operate\` | **operator** |
| Capture an observation / bug / idea | \`report\` | — |
| Classify + prioritize the backlog | \`triage\` | **triager** |
| Decompose a triaged epic into children | \`plan-epic\`, then \`check-epic-plan\` | — |
| Record a decision | \`adr\` | — |
| Record how the code is shaped | \`write-pattern\` | — |

The per-stage shells are surgical — resume a half-dead lane, re-run one gate, repair one PR —
never the normal entry point: \`build\` (**builder**), \`review\` (**reviewer**), \`ship\`
(**shipper**), and \`heal-ci\` for a PR that is green but going nowhere.`;

/** Seven ids. An eighth is a change to this table, not a new rule. */
export const BUILDABLE_SURFACES: ReadonlyArray<BuildableSurface> = [
	{id: "design-manifest", kind: "file", defaultPath: "design-system-manifest.md"},
	{
		id: "roadmap-focus",
		kind: "file",
		defaultPath: ROADMAP_FILE,
		declared: readRoadmapFile,
		count: roadmapCount,
	},
	{
		id: "gitignore-row",
		kind: "line",
		defaultPath: ".gitignore",
		block: FABRIKA_IGNORE_BLOCK,
		marker: FABRIKA_IGNORE_ROW,
	},
	{
		id: "claude-md-section",
		kind: "line",
		defaultPath: "CLAUDE.md",
		block: CLAUDE_MD_SECTION,
		marker: CLAUDE_MD_MARKER,
	},
	{id: "label-taxonomy", kind: "labels", labels: taxonomy},
	{id: "issue-shape-markers", kind: "labels", labels: () => ISSUE_SHAPE_MARKERS},
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
	/**
	 * The config arm read at the repo root above the cwd, resolved by the caller.
	 *
	 * Separate from `repoRoot` because the two tolerate a failed discovery differently. `repoRoot`
	 * may fall back to the cwd: a path probe rooted there answers about a real directory and reports
	 * nothing present that was not found. A label *write* cannot take that fallback — reading no
	 * config at an unlocated root resolves the shipped taxonomy and mints it into a repo that may
	 * have declared another, so a failed discovery has to arrive here as `Unreadable`.
	 */
	readonly configSource: ConfigSource;
	/** The resolved target repo, or the failure that makes the two non-file surfaces unanswerable. */
	readonly repo: Attempt<string>;
	readonly stdin: Effect.Effect<StdinRead>;
}

type Requirements = FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner;

const created = (
	surfaceId: string,
	target: string,
	json: boolean,
	notice: string,
	fields?: Readonly<Record<string, number>>,
): VerbOutcome => {
	const stdout = json
		? `${JSON.stringify({outcome: "created", surfaceId, target, readback: "ok", ...fields})}\n`
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

interface Target {
	readonly relative: string;
	readonly absolute: string;
}

/**
 * The write target of a path-taking surface, or the refusal it owes.
 *
 * Three sources in one order: an explicit `--path`, else the repo's declared path for surfaces that
 * have a key, else the registry default. A config that cannot be decoded refuses rather than falling
 * through to the default — scaffolding phoenix's path into a repo that declared its own is the
 * silent half of the same defect a wrong `--path` makes loud.
 */
const targetOf = (
	surface: {
		readonly defaultPath: string;
		readonly declared?: (
			root: string,
		) => Effect.Effect<Read<string>, never, FileSystem.FileSystem | Path.Path>;
	},
	input: BootstrapInput,
): Effect.Effect<Target | VerbOutcome, never, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const declared =
			input.path === null && surface.declared !== undefined
				? yield* surface.declared(input.repoRoot)
				: null;
		if (declared !== null && declared._tag === "Refused") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${CONFIG_PATH} is refused — ${declared.reason.replace(/\.$/, "")}, so where this surface belongs is unread. Nothing was written.`,
			);
		}
		const relative =
			input.path ?? (declared?._tag === "Value" ? declared.value : surface.defaultPath);
		const absolute = path.resolve(input.repoRoot, relative);
		// Containment is checked on the RESOLVED path, so `../` cannot walk out of the repository.
		if (absolute !== input.repoRoot && !absolute.startsWith(`${input.repoRoot}${path.sep}`)) {
			return refuse(
				OFF_VOCABULARY,
				`${VERB}: --path ${relative} resolves outside the repository root.`,
			);
		}
		return {relative, absolute};
	});

const isTarget = (value: Target | VerbOutcome): value is Target => "relative" in value;

const buildFile = (
	surface: Extract<BuildableSurface, {kind: "file"}>,
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const target = yield* targetOf(surface, input);
		if (!isTarget(target)) return target;
		const {relative, absolute} = target;
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
		const count = surface.count?.(content);
		return created(
			surface.id,
			relative,
			input.json,
			`${VERB}: created ${relative} for ${surface.id}, read-back conformed${count === undefined ? "" : ` — ${count.clause}`}.`,
			count?.fields,
		);
	});

/**
 * **A line surface appends; it never rewrites what is already in the file.**
 *
 * The target is a file the repo owns and this verb is one contributor to — a `.gitignore` carries
 * rows from every tool in the tree, a CLAUDE.md is the repo's own prose — so the collision guard
 * cannot be the file's existence, the way it is for a file surface this verb authors whole. It is
 * the marker: present anywhere in the text, this is `exists` at exit `0` and nothing is written;
 * absent, the block goes on the end and the pre-existing bytes are re-read intact. Both halves are
 * substring reads over the same marker, so a hand-added row — or a hand-adapted section under the
 * same heading — is recognised as the thing it is (ADR 0334's append-if-absent arm).
 */
const buildLine = (
	surface: Extract<BuildableSurface, {kind: "line"}>,
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const target = yield* targetOf(surface, input);
		if (!isTarget(target)) return target;
		const {relative, absolute} = target;

		const probe = yield* Effect.result(exists(absolute));
		if (Result.isFailure(probe)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot probe ${relative}: ${probe.failure.reason} — nothing was written.`,
			);
		}
		let before = "";
		if (probe.success) {
			const read = yield* Effect.result(readFile(absolute));
			if (Result.isFailure(read)) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${relative}: ${read.failure.reason} — whether ${surface.marker} is already there is UNKNOWN, and nothing was written.`,
				);
			}
			before = read.success;
		}
		if (before.includes(surface.marker)) return already(surface.id, relative, input.json);

		const separator = before === "" ? "" : before.endsWith("\n") ? "\n" : "\n\n";
		const written = yield* Effect.result(appendText(absolute, `${separator}${surface.block}\n`));
		if (Result.isFailure(written)) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: appending ${surface.marker} to ${relative} failed: ${written.failure.reason} — whether it landed is UNKNOWN. Re-read before retrying.`,
			);
		}
		const back = yield* Effect.result(readFile(absolute));
		if (Result.isFailure(back)) {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: appended ${surface.marker} to ${relative} and it could not be read back: ${back.failure.reason} — the outcome is UNKNOWN.`,
			);
		}
		const readback = normalizeForReadback(back.success);
		if (
			!readback.includes(normalizeForReadback(surface.marker)) ||
			!readback.includes(normalizeForReadback(before))
		) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: appended ${surface.marker} to ${relative} and the read-back differs — the outcome is UNKNOWN.`,
			);
		}
		return created(
			surface.id,
			relative,
			input.json,
			`${VERB}: appended ${surface.marker} to ${relative} for ${surface.id}, read-back conformed.`,
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

		const board = resolveBoard(loadConfig(input.configSource), FACET_VOCABULARY);
		if (board._tag === "Refused") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${CONFIG_PATH} is refused — ${board.reason.replace(/\.$/, "")}. Nothing was written; what taxonomy this repo runs on is unread, never the shipped default.`,
			);
		}
		const wanted = surface.labels(board.resolved.board);
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

/**
 * **The pre-write probe and the read-back use different primitives, and the asymmetry is the point.**
 * With no number in hand a title scan is the only probe there is; once `createUnlabelledIssue` has
 * returned one, `getIssue` reads the issue's own resource. The issues *list* is eventually
 * consistent, so re-scanning it spends `READBACK_MISMATCH` — the loudest code here — on a correct
 * first creation whose row has not propagated yet (#5776).
 */
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
		const back = yield* getIssue(repo, write.value.number);
		if (back._tag === "Unknown") {
			return refuse(
				WRITE_UNKNOWN,
				`${VERB}: created ${target} and it could not be read back: ${back.reason} — the outcome is UNKNOWN.`,
			);
		}
		if (
			back._tag === "Absent" ||
			back.value.title !== ARTIFACT_TITLE ||
			back.value.state !== "open"
		) {
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
	if (surface.kind === "line") return buildLine(surface, input);
	return surface.kind === "labels" ? buildLabels(surface, input) : buildArtifact(surface, input);
};
