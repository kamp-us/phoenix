/**
 * `status bootstrap` — create **one** missing repo surface from this group's own registry, and read
 * it back.
 *
 * The content is the skill's judgement; the write, the collision guard and the read-back are this
 * verb's. That split is why file content arrives on stdin: *"/fabrika shows what's missing, then
 * runs the primitives to build the missing thing"*. A **line** surface is the exception and
 * carries its own text here: a caller supplying it would let two repos spell one block two ways.
 *
 * **What this builds is fixed in {@link BUILDABLE_SURFACES}, never read off what a verb does when
 * the surface is missing.** That behaviour belongs to a *run* that finds it missing — `ui manifest`
 * refuses without a design manifest, and the manifest is buildable here at once — so reading a
 * refusal as "unbuildable" would make the most important onboarding surface unreachable.
 *
 * **`exists` is an exit-`0` answer, not a refusal.** A target already there is a proven fact the
 * caller acts on, and a non-zero exit cannot carry it. Nothing is written and nothing is overwritten
 * — bar the merge arm an adoption surface takes into a present file, which key-merges or appends
 * once, touching only what the surface declares and never bytes it does not own.
 */
import {Effect, type FileSystem, Path, Result} from "effect";
import type {ChildProcessSpawner} from "effect/unstable/process";
import {audienceLabel, type BoardVocabulary, statusList, typeLabel} from "../config/board.ts";
import {CONFIG_PATH, type ConfigSource, readDocument} from "../config/document.ts";
import {setJsoncValue} from "../config/jsonc-edit.ts";
import type {Decoded, KeyGroup} from "../config/key-group.ts";
import {MODE, REVIEW_UI, reviewUiKey, SCREENS} from "../config/keys/review-ui.ts";
import {uiSurfacesKey} from "../config/keys/ui-surfaces.ts";
import {loadConfig} from "../config/load.ts";
import {type Read, readRoadmapFile} from "../config/paths.ts";
import {resolveBoard} from "../config/resolve-board.ts";
import {
	cpPaths,
	findUncovered,
	parseCodeownersPatterns,
	renderCodeowners,
} from "../guard/codeowners-cp.ts";
import {CODEOWNERS} from "../guard/codeowners-cp-verb.ts";
import {CONTROL_PLANE_RE} from "../guard/control-plane-re.ts";
import {appendText, exists, readDir, readFile, writeFile} from "../io/fs.ts";
import type {Attempt, Shell} from "../io/git.ts";
import {
	createLabel,
	createUnlabelledIssue,
	getIssue,
	listLabels,
	listOpenMilestones,
	openIssuesTitled,
} from "../io/issues.ts";
import {isRecord, parseJsonOrReason} from "../io/json.ts";
import {FRESH_JSON_LAYOUT, readJsonLayout, renderJson} from "../io/json-layout.ts";
import {latestPublishedVersion} from "../io/npm.ts";
import {viewerLogin} from "../io/pulls.ts";
import type {StdinRead} from "../io/stdin.ts";
import {CLASS_LABELS, KILL_LABEL} from "../labels.ts";
import {normalizeForReadback} from "../report/compose.ts";
import {isBareAtReference, renderLeaks, scanBody} from "../report/leaks.ts";
import {DEFAULT_BOARD_VOCABULARY, FACET_VOCABULARY} from "../triage/facets.ts";
import {parseRoadmap, ROADMAP_FILE, unopenedArcPins} from "../triage/roadmap.ts";
import {answer, FAILED, refuse, type VerbOutcome} from "../verb.ts";
import {
	BARE_AT_PATH,
	EMPTY_STDIN,
	LEAKED_PATH,
	NO_SCREENS,
	NOT_BUILDABLE,
	OFF_VOCABULARY,
	PRECONDITION_UNKNOWN,
	READBACK_MISMATCH,
	WRITE_UNKNOWN,
} from "./codes.ts";
import {EMPTY_CELL, row} from "./fields.ts";
import {HAND_CHECK_MODE, planHandCheck} from "./hand-check-step.ts";
import {ARTIFACT_TITLE} from "./readout-verb.ts";
import {STARTER_CONFIG} from "./starter-config.ts";
import {PLUGIN, SETTINGS_PATH} from "./wiring-verb.ts";

const VERB = "status bootstrap";

export interface LabelSpec {
	readonly name: string;
	readonly description: string;
	/** A six-hex-digit colour, or `null` to take GitHub's default. */
	readonly color: string | null;
}

/** The description every created taxonomy label carries, so its creator is on the record. */
const LABEL_DESCRIPTION = "created by fabrika status bootstrap label-taxonomy";

/**
 * The board label taxonomy this verb creates, in the order it reports it.
 *
 * **Every name is derived, never restated.** v1 listed the two statuses and the priorities and
 * stopped, so a repo that ran the whole documented bootstrap still could not `triage apply`,
 * `triage park`, `plan flip` or `ship release` — each refuses a label the repo lacks, correctly,
 * over a gap that list left. Deriving it from the board vocabulary is what makes a seventh type
 * widen the bootstrap with no second edit here — and what makes a repo that declared its own
 * vocabulary get *its* labels rather than the shipped defaults. The class labels and
 * `closed-by-triage` are the rows no board declares: fixed in code, and minted here because a verb
 * refuses without them.
 */
export const taxonomy = (board: BoardVocabulary): ReadonlyArray<LabelSpec> =>
	[
		...statusList(board.statuses),
		...board.priorities,
		...board.types.map(typeLabel),
		...board.audiences.map(audienceLabel),
		...CLASS_LABELS,
		KILL_LABEL,
	].map((name) => ({name, description: LABEL_DESCRIPTION, color: null}));

/** The taxonomy a repo that declared no vocabulary gets — the shipped default. */
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
 * leaving an inert draft to be discovered in some later session.
 */
export const roadmapCount = (text: string): ContentCount => {
	const {arcs, campaigns} = parseRoadmap(text);
	return {
		clause: `${plural(arcs.length, "arc")}, ${plural(campaigns.length, "campaign")}`,
		fields: {arcs: arcs.length, campaigns: campaigns.length},
	};
};

/**
 * The `roadmap-focus` pin check: each arc's `#<n>` against the target repo's open milestones.
 *
 * Reported like {@link roadmapCount}, never enforced — a pin to a milestone not yet open is a
 * warning at exit `0`. A repo or milestone read that fails says the check is unknown, so a silent
 * notice can never be read as "every pin resolves". A roadmap with no arc rows pins nothing, and
 * reads nothing.
 */
export const roadmapPinCheck = (
	text: string,
	repo: Attempt<string>,
): Shell<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		const rows = parseRoadmap(text);
		if (rows.arcs.length === 0) return [];
		if (repo._tag === "Failure") {
			return [
				`${VERB}: pin check unknown — no target repo resolved (${repo.reason}); whether the arc pins are open milestones is unread.`,
			];
		}
		const open = yield* listOpenMilestones(repo.value);
		if (open._tag === "Failure") {
			return [
				`${VERB}: pin check unknown — cannot read ${repo.value}'s open milestones: ${open.reason}; whether the arc pins are open milestones is unread.`,
			];
		}
		const unopened = unopenedArcPins(rows, new Set(open.value.map((m) => m.number)));
		if (unopened.length === 0) {
			return [
				`${VERB}: pin check — every arc pin is an open milestone in ${repo.value} (scanned ${plural(open.value.length, "open milestone")}).`,
			];
		}
		const named = unopened.map((row) => `#${row.milestone} (${row.name})`).join(", ");
		return [
			`${VERB}: warning — ${unopened.length === 1 ? "an arc pins a milestone that is" : "arcs pin milestones that are"} not open in ${repo.value}: ${named}. \`triage homes\` offers only open milestones; open ${unopened.length === 1 ? "it" : "them"} or fix the pin.`,
		];
	});

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
			/**
			 * Present only where the content names things in the target repo. Its lines ride the
			 * notice channel after the write; it never changes the outcome or the exit.
			 */
			readonly repoCheck?: (text: string, repo: Attempt<string>) => Shell<ReadonlyArray<string>>;
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
			readonly kind: "json";
			/** The registry default write path — where this lands in a repo that declares nothing. */
			readonly defaultPath: string;
			/**
			 * The keys this surface owns. Present file: merged over the parsed object, every undeclared
			 * key preserved through the re-serialize. Absent file: serialized whole.
			 */
			readonly patch: Readonly<Record<string, unknown>>;
	  }
	| {
			readonly id: string;
			readonly kind: "dep-pin";
			/** The registry default write path — the adopting repo's manifest. */
			readonly defaultPath: string;
			/** The dependency row this surface owns — resolved from npm at run time, never restated. */
			readonly packageName: string;
	  }
	| {
			readonly id: string;
			readonly kind: "no-preview-rule";
			/** The registry default write path — the repo's tracked config file. */
			readonly defaultPath: string;
			/** What this surface declares under `reviewUi` when the repo has not answered. */
			readonly rule: HandCheckRule;
	  }
	| {
			readonly id: string;
			readonly kind: "starter";
			/** The registry default write path — where this lands in a repo that declares nothing. */
			readonly defaultPath: string;
			/** The whole file, fixed in the registry and written only when the target is absent. */
			readonly content: string;
	  }
	| {
			readonly id: string;
			readonly kind: "owners";
			/** The one path the owners-file guard reads, so `--path` does not move it. */
			readonly defaultPath: string;
	  }
	| {
			readonly id: string;
			readonly kind: "workflow";
			/** GitHub runs a workflow from this file's directory only, so `--path` does not move it. */
			readonly defaultPath: string;
			/** The whole file, fixed in the registry. */
			readonly content: string;
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

/**
 * The `settings-patch` keys: the marketplace registration and the plugin flip, spelled as an adopted
 * repo carries them. Fixed in the registry for the reason the line surface's row is fixed there: a
 * caller supplying the JSON would let two repos spell one marketplace two ways.
 */
export const SETTINGS_PATCH: Readonly<Record<string, unknown>> = {
	extraKnownMarketplaces: {
		kampus: {
			source: {source: "github", repo: "kamp-us/phoenix"},
			autoUpdate: true,
		},
	},
	enabledPlugins: {[`${PLUGIN}@kampus`]: true},
};

/**
 * The dependency row `dep-pin` owns. Named here once so the manifest merge, the install command and
 * the npm resolution all read the same spelling.
 */
export const FABRIKA_CLI_PACKAGE = "@kampus/fabrika-cli";

/**
 * `manifest` with `packageName` pinned at `version` under `devDependencies` — the CLI is a dev tool,
 * never a runtime dependency of what the repo deploys. A row already under `dependencies` (where an
 * earlier `dep-pin` wrote it) moves: it leaves `dependencies` in the same edit that lands it under
 * `devDependencies`, so the manifest never carries two rows for one package. Every other key keeps
 * its value and its place, an emptied `dependencies` included.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10032
 */
export const pinDevDependency = (
	manifest: Readonly<Record<string, unknown>>,
	packageName: string,
	version: string,
): Record<string, unknown> => {
	const runtime = manifest.dependencies;
	const withoutRuntimeRow =
		isRecord(runtime) && Object.hasOwn(runtime, packageName)
			? {
					...manifest,
					dependencies: Object.fromEntries(
						Object.entries(runtime).filter(([name]) => name !== packageName),
					),
				}
			: manifest;
	return mergeJsonPatch(withoutRuntimeRow, {devDependencies: {[packageName]: version}});
};

/**
 * The exact install command printed once the row lands, at the version just pinned. The lockfile is
 * the caller's to resolve — fabrika never shells to a package manager — so this line on the notice
 * is the whole handoff.
 */
export const installCommand = (packageName: string, version: string): string =>
	`pnpm add -D --save-exact ${packageName}@${version}`;

/**
 * What the install behind {@link installCommand} costs and what it needs approved. The package's
 * `postinstall` downloads the headless browser `ui render` drives, and pnpm 10 skips a dependency's
 * build scripts until the repo approves them — so without this the install lands quietly and the
 * browser never does. `ui render` still refuses on `11` at run time; this names it up front.
 */
export const installCostNotices = (packageName: string): ReadonlyArray<string> => [
	`${VERB}: the install brings in Playwright (@playwright/test) and its postinstall downloads a headless Chromium (~130MB) — the browser \`fabrika ui render\` drives.`,
	`${VERB}: pnpm 10 skips that postinstall until you approve it — run \`pnpm approve-builds\` and pick ${packageName}, or add ${packageName} to \`onlyBuiltDependencies\` and run \`pnpm rebuild ${packageName}\`; approving it is what lets \`ui render\`'s browser setup run.`,
];

/**
 * What the `hand-check-rule` step declares: the repo's `reviewUi.mode`, at `hand-check` only. Of the
 * three modes this is the one the step can turn on by itself. `preview` needs hosting the step
 * cannot set up, and `skip` is what a repo that never ran the step already resolves to.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10520#issuecomment-5984214868
 */
export interface HandCheckRule {
	readonly mode: typeof HAND_CHECK_MODE;
}

/**
 * The mode is the repo's answer for every screen file no `whenNoPreview` rule matches. It is only
 * ever read over a pull request's ui-class files, and the route refuses it when the pull request has
 * a preview, so it loosens nothing else.
 */
const HAND_CHECK_RULE: HandCheckRule = {mode: HAND_CHECK_MODE};

/** The marker heading that decides `exists` for the CLAUDE.md section, and its first line. */
export const CLAUDE_MD_MARKER = "## Work flows through fabrika";

/**
 * The canonical operator-first "work flows through fabrika" CLAUDE.md section, fixed in code as
 * the single source, appended once when its marker heading is absent. Repo-specific adaptation —
 * tone, an exemption like a no-ADRs rule — stays with the adopting agent in the front-door flow;
 * this verb emits the canonical text and no repo-specific branches.
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

/**
 * Where GitHub looks for an owners file, in the order it looks. The first one present is the one in
 * force, so writing {@link CODEOWNERS} into a repo that keeps its file at a later path would replace
 * that file's rows. GitHub's "About code owners" names these three directories and this order.
 */
export const OWNERS_FILE_LOCATIONS: ReadonlyArray<string> = [
	CODEOWNERS,
	"CODEOWNERS",
	"docs/CODEOWNERS",
];

/** The one directory GitHub runs workflows from. */
export const WORKFLOWS_DIR = ".github/workflows";

/**
 * A workflow file as GitHub reads one: a `.yml` or `.yaml` entry directly in {@link WORKFLOWS_DIR}.
 * GitHub's "Workflow syntax for GitHub Actions" names both extensions and that one directory.
 */
const isWorkflowFile = (name: string): boolean => /\.ya?ml$/.test(name);

/**
 * The starter CI workflow: one job, run on every pull request, that passes when `README.md` holds
 * something. The merge step needs one CI run on a pull request, and this is the smallest check a
 * new repo can pass.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10498
 */
export const STARTER_CI_WORKFLOW = `name: ci
on:
  pull_request:
jobs:
  readme:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: test -s README.md
`;

/** Thirteen ids. A fourteenth is a change to this table, not a new rule. */
export const BUILDABLE_SURFACES: ReadonlyArray<BuildableSurface> = [
	{id: "design-manifest", kind: "file", defaultPath: "design-system-manifest.md"},
	{
		id: "roadmap-focus",
		kind: "file",
		defaultPath: ROADMAP_FILE,
		declared: readRoadmapFile,
		count: roadmapCount,
		repoCheck: roadmapPinCheck,
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
	{id: "settings-patch", kind: "json", defaultPath: SETTINGS_PATH, patch: SETTINGS_PATCH},
	{
		id: "dep-pin",
		kind: "dep-pin",
		defaultPath: "package.json",
		packageName: FABRIKA_CLI_PACKAGE,
	},
	{id: "fabrika-config", kind: "starter", defaultPath: CONFIG_PATH, content: STARTER_CONFIG},
	{id: "hand-check-rule", kind: "no-preview-rule", defaultPath: CONFIG_PATH, rule: HAND_CHECK_RULE},
	{id: "owners-file", kind: "owners", defaultPath: CODEOWNERS},
	{
		id: "ci-file",
		kind: "workflow",
		defaultPath: `${WORKFLOWS_DIR}/ci.yml`,
		content: STARTER_CI_WORKFLOW,
	},
];

const findSurface = (id: string): BuildableSurface | undefined =>
	BUILDABLE_SURFACES.find((surface) => surface.id === id);

/**
 * The id of the `labels` surface whose set holds `label` on this board, or `null` when no surface
 * creates it.
 *
 * Read off {@link BUILDABLE_SURFACES} so a verb refusing over a missing label names the command that
 * creates it without restating which set holds it, and so a repo that declared its own vocabulary
 * is answered for its own label names.
 */
export const labelSurface = (label: string, board: BoardVocabulary): string | null =>
	BUILDABLE_SURFACES.find(
		(surface) =>
			surface.kind === "labels" && surface.labels(board).some((spec) => spec.name === label),
	)?.id ?? null;

/** The repo-relative file a surface writes when no `--path` moves it, or `null` when it writes no file. */
export const defaultFileOf = (id: string): string | null => {
	const surface = findSurface(id);
	return surface !== undefined && "defaultPath" in surface ? surface.defaultPath : null;
};

export const knownIds = (): string => BUILDABLE_SURFACES.map((surface) => surface.id).join(", ");

export interface BootstrapInput {
	readonly surfaceId: string;
	readonly path: string | null;
	/**
	 * Where the screens live, as the owner typed each `--screens` path. Only `hand-check-rule` reads
	 * it; absent is none named.
	 */
	readonly screens?: ReadonlyArray<string>;
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
	extraNotices?: ReadonlyArray<string>,
): VerbOutcome => {
	const stdout = json
		? `${JSON.stringify({outcome: "created", surfaceId, target, readback: "ok", ...fields})}\n`
		: `${row("bootstrap", "created", surfaceId, target, "ok")}\n`;
	return answer(stdout, [notice, ...(extraNotices ?? [])]);
};

const already = (
	surfaceId: string,
	target: string,
	json: boolean,
	notice = `${target} is already present for ${surfaceId} — nothing written.`,
): VerbOutcome => {
	const stdout = json
		? `${JSON.stringify({outcome: "exists", surfaceId, target, readback: EMPTY_CELL})}\n`
		: `${row("bootstrap", "exists", surfaceId, target, EMPTY_CELL)}\n`;
	return answer(stdout, [`${VERB}: ${notice}`]);
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
 * through to the default — scaffolding the shipped path into a repo that declared its own is the
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
		const checked =
			surface.repoCheck === undefined ? [] : yield* surface.repoCheck(content, input.repo);
		return created(
			surface.id,
			relative,
			input.json,
			`${VERB}: created ${relative} for ${surface.id}, read-back conformed${count === undefined ? "" : ` — ${count.clause}`}.`,
			count?.fields,
			checked,
		);
	});

/**
 * JSON value equality, key-order-insensitive: a hand-authored settings object may spell its keys in
 * any order, and an adoption that differs only in key order is adopted, not a delta to rewrite.
 */
const jsonEquals = (a: unknown, b: unknown): boolean => {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item, index) => jsonEquals(item, b[index]))
		);
	}
	if (!isRecord(a) || !isRecord(b)) return false;
	const aKeys = Object.keys(a);
	const bKeys = new Set(Object.keys(b));
	return (
		aKeys.length === bKeys.size &&
		aKeys.every((key) => bKeys.has(key) && jsonEquals(a[key], b[key]))
	);
};

/**
 * The key-merge proper: the patch's own paths overwrite, everything else survives verbatim —
 * including siblings *under* a key the patch names, so an `enabledPlugins` carrying other plugins
 * keeps them. Recursion follows the patch's shape only; the merge never descends into content the
 * surface does not declare.
 */
const mergeJsonPatch = (
	present: Readonly<Record<string, unknown>>,
	patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
	const merged: Record<string, unknown> = {...present};
	for (const [key, value] of Object.entries(patch)) {
		merged[key] =
			isRecord(value) && isRecord(merged[key]) ? mergeJsonPatch(merged[key], value) : value;
	}
	return merged;
};

/**
 * One json surface's edit: `apply` maps a present file's parsed object to what it should hold, and
 * `seed` is the whole object an absent file is created with.
 */
interface JsonEdit {
	readonly apply: (present: Readonly<Record<string, unknown>>) => Record<string, unknown>;
	readonly seed: Readonly<Record<string, unknown>>;
}

const patchEdit = (patch: Readonly<Record<string, unknown>>): JsonEdit => ({
	apply: (present) => mergeJsonPatch(present, patch),
	seed: patch,
});

/**
 * **The JSON key-merge arm, shared by every json-shaped target.** An adopting repo's
 * file usually exists before fabrika ever sees it, so the file arm's absence guard cannot serve it.
 * A present target must parse as a JSON object: the patch's declared keys merge over it, every
 * undeclared key survives the re-serialize verbatim, and bytes that refuse to parse are exit `11`
 * naming the file and the parse failure, nothing written. Already merged — the parsed object equals
 * what merging would produce — is `exists`, so idempotency stays absolute. A merged write renders in
 * the layout the present file already uses, so its diff is the changed rows alone. Absent, the
 * declared keys are written whole in {@link FRESH_JSON_LAYOUT} through the same write-and-read-back
 * protocol the file arm runs.
 */
const mergePatchAt = (
	surfaceId: string,
	relative: string,
	absolute: string,
	edit: JsonEdit,
	input: BootstrapInput,
	extraNotices?: ReadonlyArray<string>,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const probe = yield* Effect.result(exists(absolute));
		if (Result.isFailure(probe)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot probe ${relative}: ${probe.failure.reason} — nothing was written.`,
			);
		}
		if (!probe.success) {
			return yield* writeAndReadBack(
				surfaceId,
				relative,
				absolute,
				renderJson(edit.seed, FRESH_JSON_LAYOUT),
				input,
				`created ${relative} for ${surfaceId}, read-back conformed.`,
				extraNotices,
			);
		}
		const read = yield* Effect.result(readFile(absolute));
		if (Result.isFailure(read)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read ${relative}: ${read.failure.reason} — whether the declared keys are already there is UNKNOWN, and nothing was written.`,
			);
		}
		const parsed = parseJsonOrReason(read.success);
		if (parsed._tag === "Failed") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${relative} does not parse as a JSON object: ${parsed.reason} — nothing was written.`,
			);
		}
		if (!isRecord(parsed.value)) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${relative} parses to ${Array.isArray(parsed.value) ? "an array" : typeof parsed.value}, not a JSON object — nothing was written.`,
			);
		}
		const merged = edit.apply(parsed.value);
		if (jsonEquals(parsed.value, merged)) return already(surfaceId, relative, input.json);
		return yield* writeAndReadBack(
			surfaceId,
			relative,
			absolute,
			renderJson(merged, readJsonLayout(read.success)),
			input,
			`merged the declared keys into ${relative} for ${surfaceId}, read-back conformed.`,
			extraNotices,
		);
	});

/** The settings arm: the registry's static keys through {@link mergePatchAt}. */
const buildJsonPatch = (
	surface: Extract<BuildableSurface, {kind: "json"}>,
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const target = yield* targetOf(surface, input);
		if (!isTarget(target)) return target;
		return yield* mergePatchAt(
			surface.id,
			target.relative,
			target.absolute,
			patchEdit(surface.patch),
			input,
		);
	});

/**
 * **dep-pin resolves the release at run time; the edit itself is the json arm's.** The pinned
 * version is never a constant here — the npm registry's current published release is what makes a
 * re-run move an old row forward — and an unreachable or malformed answer refuses instead of
 * pinning a guess. The merge rides {@link mergePatchAt} with {@link pinDevDependency} as its edit:
 * `devDependencies.@kampus/fabrika-cli` at exactly the resolved version, every other key verbatim,
 * absolute idempotency. No package manager ever spawns and no lockfile is read or written — the
 * exact install command is printed instead, because the lockfile stays the caller's.
 */
const buildDepPin = (
	surface: Extract<BuildableSurface, {kind: "dep-pin"}>,
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const target = yield* targetOf(surface, input);
		if (!isTarget(target)) return target;
		const {relative, absolute} = target;

		const resolved = yield* latestPublishedVersion(surface.packageName);
		if (resolved._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot resolve ${surface.packageName}'s current release from npm: ${resolved.reason} — nothing pinned, nothing written.`,
			);
		}
		return yield* mergePatchAt(
			surface.id,
			relative,
			absolute,
			{
				apply: (present) => pinDevDependency(present, surface.packageName, resolved.value),
				seed: {devDependencies: {[surface.packageName]: resolved.value}},
			},
			input,
			[
				`${VERB}: the lockfile stays yours — install with: ${installCommand(surface.packageName, resolved.value)}`,
				...installCostNotices(surface.packageName),
			],
		);
	});

/** The standing value of one key in a parsed config record, or the reason its decoder refuses it. */
const standingOf = <A>(
	record: Readonly<Record<string, unknown>>,
	group: KeyGroup<A>,
): Decoded<A> =>
	record[group.key] === undefined
		? {_tag: "Value", value: group.shippedDefault}
		: group.decode(record[group.key]);

/**
 * **The config file is edited in place, never re-serialized.** `.fabrika.jsonc` carries a person's
 * comments, so the keys are spliced into the text and every other byte stays.
 *
 * What is written is `./hand-check-step.ts`'s plan over what the file already says: the repo's
 * `reviewUi.mode` at `hand-check`, and the `--screens` paths under `reviewUi.screens`. A repo that
 * names no screen file is refused, because the hand-check written there is one no pull request can
 * trigger. A repo that already answered — `preview`, `hand-check`, or its own `whenNoPreview`
 * rules — is `exists`: a second statement from here could only contradict the first.
 *
 * The spliced text is re-parsed before it is written. A document whose other keys moved, or whose
 * `reviewUi` is not exactly the planned one, is refused unwritten.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10520#issuecomment-5984214868
 */
const buildNoPreviewRule = (
	surface: Extract<BuildableSurface, {kind: "no-preview-rule"}>,
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
		let text: string | null = null;
		let record: Readonly<Record<string, unknown>> = {};
		if (probe.success) {
			const read = yield* Effect.result(readFile(absolute));
			if (Result.isFailure(read)) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot read ${relative}: ${read.failure.reason} — what \`${REVIEW_UI}\` already says is UNKNOWN, and nothing was written.`,
				);
			}
			const before = readDocument({_tag: "Text", text: read.success}, relative);
			if (before._tag !== "Record") {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: ${relative} does not parse as a JSON object with comments — nothing was written.`,
				);
			}
			text = read.success;
			record = before.record;
		}
		const keyRefused = (reason: string): VerbOutcome =>
			refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: ${relative} is refused — ${reason.replace(/\.$/, "")}. Nothing was written; fix that key first.`,
			);
		const standing = standingOf(record, reviewUiKey);
		if (standing._tag === "Malformed") return keyRefused(standing.reason);
		// The rows are read only to know whether the repo names a screen file anywhere.
		const surfaces = standingOf(record, uiSurfacesKey);
		if (surfaces._tag === "Malformed") return keyRefused(surfaces.reason);

		const plan = planHandCheck({
			standing: standing.value,
			surfaces: surfaces.value.length,
			screens: input.screens ?? [],
		});
		if (plan._tag === "BadScreen") {
			return refuse(OFF_VOCABULARY, `${VERB}: ${plan.reason}. Nothing was written.`);
		}
		if (plan._tag === "NoScreens") {
			return refuse(NO_SCREENS, `${VERB}: ${relative} ${plan.reason}. Nothing was written.`);
		}
		if (plan._tag === "Exists") {
			return already(surface.id, relative, input.json, `${relative} ${plan.notice}`);
		}

		const patch = {
			...(plan.mode === null ? {} : {[MODE]: surface.rule.mode}),
			...(plan.screens === null ? {} : {[SCREENS]: plan.screens}),
		};
		const wrote = [
			plan.mode === null ? null : `\`${REVIEW_UI}.${MODE}\` ${surface.rule.mode}`,
			plan.screens === null ? null : `${plan.screens.length} \`${REVIEW_UI}.${SCREENS}\` path(s)`,
		]
			.filter((part): part is string => part !== null)
			.join(" and ");
		if (text === null) {
			return yield* writeAndReadBack(
				surface.id,
				relative,
				absolute,
				renderJson({[REVIEW_UI]: patch}, FRESH_JSON_LAYOUT),
				input,
				`created ${relative} for ${surface.id} with ${wrote}, read-back conformed.`,
			);
		}

		const edited = Object.entries(patch).reduce<string | null>((current, [key, value]) => {
			if (current === null) return null;
			const edit = setJsoncValue(current, [REVIEW_UI, key], value);
			return edit._tag === "Edited" ? edit.text : null;
		}, text);
		const after = edited === null ? null : readDocument({_tag: "Text", text: edited}, relative);
		const was = record[REVIEW_UI];
		if (
			edited === null ||
			after?._tag !== "Record" ||
			!jsonEquals(after.record, {
				...record,
				[REVIEW_UI]: {...(isRecord(was) ? was : {}), ...patch},
			})
		) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot add ${wrote} to ${relative} without moving its other keys — nothing was written. Add ${JSON.stringify(patch)} under "${REVIEW_UI}" by hand.`,
			);
		}
		return yield* writeAndReadBack(
			surface.id,
			relative,
			absolute,
			edited,
			input,
			`added ${wrote} to ${relative} for ${surface.id}, read-back conformed.`,
		);
	});

/**
 * **A starter surface writes its own file whole, and only into a gap.** The target's existence is
 * the collision guard, as it is for a file surface: whatever is already there is the repo's own
 * statement and is never read, merged or judged.
 */
const buildStarter = (
	surface: Extract<BuildableSurface, {kind: "starter"}>,
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
		return yield* writeAndReadBack(
			surface.id,
			relative,
			absolute,
			surface.content,
			input,
			`created ${relative} for ${surface.id}, read-back conformed.`,
		);
	});

/**
 * **The owners file is written from the guard's own path list and proven by the guard's own check.**
 * The rows are `cpPaths(CONTROL_PLANE_RE)`, the list `guard codeowners-cp check` reads, so this arm
 * holds no path and follows that boundary when it moves. Each row is owned by the login the token
 * signs in as: a new repo has no team to name, and its owner is the one account known to exist.
 *
 * An owners file at any path GitHub reads is `exists`, and is never read, merged or judged. The
 * login is read only once every such path is proven absent, so a repo that has the file answers
 * with no credential at all.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10497
 */
const buildOwners = (
	surface: Extract<BuildableSurface, {kind: "owners"}>,
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		for (const location of OWNERS_FILE_LOCATIONS) {
			const probe = yield* Effect.result(exists(path.resolve(input.repoRoot, location)));
			if (Result.isFailure(probe)) {
				return refuse(
					PRECONDITION_UNKNOWN,
					`${VERB}: cannot probe ${location}: ${probe.failure.reason} — nothing was written.`,
				);
			}
			if (probe.success) return already(surface.id, location, input.json);
		}

		const login = yield* viewerLogin;
		if (login._tag === "Failure") {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot read the signed-in login: ${login.reason} — who would own the rows is UNKNOWN, and nothing was written.`,
			);
		}

		const relative = surface.defaultPath;
		const absolute = path.resolve(input.repoRoot, relative);
		const demanded = cpPaths(CONTROL_PLANE_RE);
		const written = yield* Effect.result(
			writeFile(absolute, renderCodeowners(demanded, login.value)),
		);
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
		const uncovered = findUncovered(demanded, parseCodeownersPatterns(back.success));
		if (uncovered.length > 0) {
			return refuse(
				READBACK_MISMATCH,
				`${VERB}: wrote ${relative} and the read-back differs — no row covers ${uncovered.map((p) => p.path).join(", ")}.`,
			);
		}
		return created(
			surface.id,
			relative,
			input.json,
			`${VERB}: created ${relative} for ${surface.id}, read-back conformed — ${plural(demanded.length, "row")} owned by @${login.value}.`,
			{rows: demanded.length},
		);
	});

/**
 * **A repo with any workflow of its own never gets a second one.** The collision guard is the
 * directory GitHub runs workflows from, not the target path: a workflow file under any name there is
 * `exists`, named in the row, and is never read, merged or judged. A directory that is absent, or
 * holds no workflow file, is the gap the starter is written into.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10498
 */
const buildWorkflow = (
	surface: Extract<BuildableSurface, {kind: "workflow"}>,
	input: BootstrapInput,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const listed = yield* Effect.result(readDir(path.resolve(input.repoRoot, WORKFLOWS_DIR)));
		if (Result.isFailure(listed) && !listed.failure.notFound) {
			return refuse(
				PRECONDITION_UNKNOWN,
				`${VERB}: cannot list ${WORKFLOWS_DIR}: ${listed.failure.reason} — whether the repo has a workflow is UNKNOWN, and nothing was written.`,
			);
		}
		const standing = Result.isFailure(listed)
			? undefined
			: listed.success.filter(isWorkflowFile).sort()[0];
		if (standing !== undefined) {
			return already(surface.id, `${WORKFLOWS_DIR}/${standing}`, input.json);
		}
		return yield* writeAndReadBack(
			surface.id,
			surface.defaultPath,
			path.resolve(input.repoRoot, surface.defaultPath),
			surface.content,
			input,
			`created ${surface.defaultPath} for ${surface.id}, read-back conformed.`,
		);
	});

/**
 * One write, one re-read, one comparison — the protocol every byte-writing arm here runs. The notice
 * prefix (`created …` / `merged …`) is the caller's, because the arms differ in what landed; extra
 * notices ride the same channel, which is how dep-pin hands over the install command.
 */
const writeAndReadBack = (
	surfaceId: string,
	relative: string,
	absolute: string,
	content: string,
	input: BootstrapInput,
	notice: string,
	extraNotices?: ReadonlyArray<string>,
): Effect.Effect<VerbOutcome, never, Requirements> =>
	Effect.gen(function* () {
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
		return created(surfaceId, relative, input.json, `${VERB}: ${notice}`, undefined, extraNotices);
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
 * same heading — is recognised as the thing it is.
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
 * first creation whose row has not propagated yet.
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

/**
 * One surface per invocation, deliberately: a run spanning several surfaces can write some and fail
 * on the rest, and there is no honest single answer for that.
 */
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
	if (surface.kind === "json") return buildJsonPatch(surface, input);
	if (surface.kind === "dep-pin") return buildDepPin(surface, input);
	if (surface.kind === "starter") return buildStarter(surface, input);
	if (surface.kind === "no-preview-rule") return buildNoPreviewRule(surface, input);
	if (surface.kind === "owners") return buildOwners(surface, input);
	if (surface.kind === "workflow") return buildWorkflow(surface, input);
	return surface.kind === "labels" ? buildLabels(surface, input) : buildArtifact(surface, input);
};
