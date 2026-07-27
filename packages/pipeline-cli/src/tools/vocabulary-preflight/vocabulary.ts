/**
 * `vocabulary-preflight` pure core — assert the label vocabulary and the roadmap surface the
 * pipeline tools depend on actually exist in the resolved target repo, and name each one that
 * does not (#4272).
 *
 * The vocabulary is deliberately NOT a config surface. Two tools already record that widening
 * their slice of it is a founder ruling (`homing-guard`'s `EXEMPT_LABELS`, `pitch-guard`'s
 * `LANE_ENTERING_TYPES`), so adopting the pipeline means adopting the taxonomy. What was missing
 * is the other half of that bargain: a repo without the taxonomy got no error, because every
 * scan simply matched nothing — the silent no-op ADR 0092 exists to kill. This module turns that
 * absence into an unmet prerequisite with a name.
 *
 * The required set is ASSEMBLED from the constants the tools already own rather than retyped
 * here, so the preflight cannot drift from the literals it protects.
 *
 * IO-free and total — the `gh api` label read and the `ROADMAP.md` read live in
 * `github.ts`/`gate.ts`.
 */
import {ISSUE_TYPE_LABELS} from "../drive-issue-flow/type-route.ts";
import {EXEMPT_LABELS, TRIAGED_LABEL} from "../homing-guard/homing-guard.ts";
import {PLATFORM_LABELS} from "../lane/lane.ts";
import {PRIORITY_LABELS} from "../roadmap/roadmap.ts";
import {SPINE_LABELS} from "../tracker/triage-labels.ts";

/** One named slice of the vocabulary, so a red says which tool loses its footing without it. */
export interface LabelGroup {
	readonly name: string;
	readonly labels: ReadonlyArray<string>;
}

/**
 * The required label universe, grouped by the concern each slice serves. A label may legitimately
 * sit in two groups — `axis:pipeline-hardening` is a standing lane AND the platform discriminator;
 * `status:triaged` is a spine stage AND the label the guards scope on. `REQUIRED_LABELS` dedupes,
 * the groups keep both readings visible in the report. Every group is imported from the tool that
 * owns it, so no slice can be covered only incidentally by another.
 */
export const LABEL_GROUPS: ReadonlyArray<LabelGroup> = [
	{name: "pickability spine", labels: SPINE_LABELS},
	{name: "guard scope", labels: [TRIAGED_LABEL]},
	{name: "priority buckets", labels: PRIORITY_LABELS},
	{name: "issue types", labels: ISSUE_TYPE_LABELS},
	{name: "standing lanes", labels: EXEMPT_LABELS},
	{name: "platform discriminator", labels: PLATFORM_LABELS},
];

/** Every label the tools scope on, deduped, in group order. */
export const REQUIRED_LABELS: ReadonlyArray<string> = [
	...new Set(LABEL_GROUPS.flatMap((group) => group.labels)),
];

/**
 * The required set as a newline-delimited list — the machine-readable seam a non-Node consumer
 * reads this module through. `doctor.sh` is the caller (#4300): a bash preflight cannot import a
 * TS constant, so without this it would have to retype the set, which is precisely the parallel
 * hand-written list that drifted.
 */
export const renderLabelList = (labels: ReadonlyArray<string>): string => labels.join("\n");

/** A label in create-ready form: the name a guard scopes on plus the two fields a create needs. */
export interface LabelSpec {
	readonly name: string;
	readonly color: string;
	readonly description: string;
}

/**
 * The create-ready taxonomy — the ONE home for every pipeline label's colour and description
 * (#4341). The two facts split across files before this: `REQUIRED_LABELS` carried names and
 * `doctor.sh` carried `NAME|HEX|DESCRIPTION` in a heredoc, so the seeder would have been a third
 * copy. Both consumers — this package's seeder and `doctor.sh`'s printed `gh label create` fixes —
 * now read these rows, so a colour or wording change lands in one place.
 *
 * It is deliberately a SUPERSET of `REQUIRED_LABELS`, not a mirror of it: `status:planning` (the
 * ADR-0059 epic lock) and `status:awaiting-release` (the ADR-0083 release queue) are labels the
 * pipeline writes but the preflight does not yet enforce, and an adopting repo needs them created
 * all the same. `unspecifiedRequiredLabels` is the fail-closed direction that matters — every
 * enforced label must be creatable from here, or the seeder cannot clear the preflight it seeds
 * for.
 *
 * Colour is the 6-hex GitHub wants with no leading `#`. Descriptions carry no `|`, because the
 * rendered form below is pipe-delimited for the bash consumer.
 */
export const LABEL_SPECS: ReadonlyArray<LabelSpec> = [
	{
		name: "status:needs-triage",
		color: "fbca04",
		description: "Filed, awaiting triage classification",
	},
	{
		name: "status:needs-info",
		color: "fbca04",
		description: "Human-filed; awaiting answers before triage",
	},
	{
		name: "status:planned",
		color: "fbca04",
		description: "plan-epic child: planned, not yet verified by review-plan, not pickable",
	},
	{
		name: "status:triaged",
		color: "fbca04",
		description: "Triage signed off; ready for write-code to pick",
	},
	{
		name: "status:planning",
		color: "fbca04",
		description: "Epic-lock held: a plan-epic/review-plan run is mutating this epic's children",
	},
	{
		name: "status:awaiting-release",
		color: "5319e7",
		description: "Post-merge release queue: deployed dark, awaiting a human flag flip",
	},
	{name: "p0", color: "b60205", description: "Highest priority"},
	{name: "p1", color: "d93f0b", description: "Medium priority"},
	{name: "p2", color: "e99695", description: "Lowest priority"},
	{name: "type:bug", color: "1d76db", description: "Behavior diverges from intent"},
	{name: "type:chore", color: "1d76db", description: "No behavior change"},
	{
		name: "type:decision",
		color: "1d76db",
		description: "One question; output is a recorded choice",
	},
	{name: "type:epic", color: "1d76db", description: "Too big for one PR; spawns children"},
	{
		name: "type:feature",
		color: "1d76db",
		description: "New capability, directly implementable",
	},
	{name: "type:investigation", color: "1d76db", description: "Unknown; output is knowledge"},
	{
		name: "wayfinder:backlog",
		color: "8250df",
		description: "Standing lane: a destination queued for a wayfinding chart",
	},
	{
		name: "axis:pipeline-hardening",
		color: "5319e7",
		description: "Standing lane: the cross-cutting pipeline-hardening axis",
	},
	{
		name: "area:infra",
		color: "0e8a16",
		description: "Platform/infra discriminator the lane tool scopes on",
	},
];

/** Every name `LABEL_SPECS` can create, in table order. */
export const SPECIFIED_LABELS: ReadonlyArray<string> = LABEL_SPECS.map((spec) => spec.name);

/**
 * Required labels with no create-ready row — non-empty means the seeder could never clear the
 * preflight, because the enforced set names something it cannot create. Callers refuse on a
 * non-empty result rather than seeding a partial taxonomy (ADR 0092).
 */
export const unspecifiedRequiredLabels = (): ReadonlyArray<string> =>
	REQUIRED_LABELS.filter((label) => !SPECIFIED_LABELS.includes(label));

/**
 * The create-ready rows as `NAME|HEX|DESCRIPTION` lines — the seam `doctor.sh` reads, for the same
 * reason `renderLabelList` exists: a bash preflight cannot import a TS constant, and retyping the
 * rows is the drift this consolidation removes.
 */
export const renderLabelSpecs = (specs: ReadonlyArray<LabelSpec>): string =>
	specs.map((spec) => `${spec.name}|${spec.color}|${spec.description}`).join("\n");

/** `ROADMAP.md` as the preflight finds it: absent, or present with the rows it parsed. */
export type RoadmapSurface =
	| {readonly _tag: "absent"; readonly path: string}
	| {
			readonly _tag: "present";
			readonly path: string;
			readonly arcs: number;
			readonly campaigns: number;
	  };

/** The roadmap surface is missing or shaped so it parses to nothing. */
export interface RoadmapPrerequisite {
	readonly _tag: "roadmap";
	readonly path: string;
	readonly detail: string;
}

/** One unmet prerequisite. Both arms carry what the operator has to create to clear it. */
export type Prerequisite =
	| {readonly _tag: "labels"; readonly missing: ReadonlyArray<string>}
	| RoadmapPrerequisite;

/**
 * The verdict. A discriminated union so an invalid state is unrepresentable: a pass carries only
 * counts, and a fail carries a list `judge` only ever builds non-empty.
 */
export type PreflightVerdict =
	| {
			readonly pass: true;
			readonly labels: number;
			readonly arcs: number;
			readonly campaigns: number;
	  }
	| {readonly pass: false; readonly unmet: ReadonlyArray<Prerequisite>};

/**
 * The roadmap half: a `ROADMAP.md` that is absent, or present but parsing to no arcs, is the same
 * unmet prerequisite — an empty tree reads as a roadmap that is merely quiet. Returns `null` when
 * the surface is fine.
 */
export const judgeRoadmap = (surface: RoadmapSurface): RoadmapPrerequisite | null => {
	if (surface._tag === "absent") {
		return {_tag: "roadmap", path: surface.path, detail: "not found"};
	}
	if (surface.arcs === 0) {
		return {
			_tag: "roadmap",
			path: surface.path,
			detail: "parsed ZERO `## Arcs` rows — the table is missing or its grammar does not match",
		};
	}
	return null;
};

/**
 * Judge the live label universe and roadmap surface against the prerequisites.
 *
 * An empty universe is not a special case: every required label is then missing, so it reds by
 * the same path a partially-adopted repo does — and never as a vacuous pass (ADR 0092).
 */
export const judge = (
	universe: ReadonlyArray<string>,
	roadmap: RoadmapSurface,
): PreflightVerdict => {
	const unmet: Array<Prerequisite> = [];
	const missing = REQUIRED_LABELS.filter((label) => !universe.includes(label));
	if (missing.length > 0) unmet.push({_tag: "labels", missing});
	const roadmapDefect = judgeRoadmap(roadmap);
	if (roadmapDefect !== null) unmet.push(roadmapDefect);

	if (unmet.length > 0) return {pass: false, unmet};
	return {
		pass: true,
		labels: REQUIRED_LABELS.length,
		arcs: roadmap._tag === "present" ? roadmap.arcs : 0,
		campaigns: roadmap._tag === "present" ? roadmap.campaigns : 0,
	};
};

const LABEL_REMEDY =
	"Adopting the pipeline means adopting its taxonomy — the vocabulary is governance, not\n" +
	"configuration, and two tools record that widening it is a founder ruling. Create each label\n" +
	"above in the target repo (`gh label create <name>`); do NOT try to point the tools at a\n" +
	"different vocabulary.";

/** Render one unmet prerequisite with the group each missing label belongs to. */
const renderPrerequisite = (unmet: Prerequisite): string => {
	if (unmet._tag === "roadmap") {
		return (
			`ROADMAP.md — ${unmet.detail} (${unmet.path}).\n` +
			"It is the SOLE parsed roadmap surface (#2630/#2632): with no `## Arcs` table there is no\n" +
			"active arc, so milestone homing and the roadmap view have nothing to read."
		);
	}
	const byGroup = LABEL_GROUPS.map((group) => {
		const gone = group.labels.filter((label) => unmet.missing.includes(label));
		return gone.length === 0 ? "" : `  ${group.name}: ${gone.join(", ")}`;
	}).filter((line) => line !== "");
	return `${unmet.missing.length} required label(s) absent from the repo:\n${byGroup.join("\n")}\n\n${LABEL_REMEDY}`;
};

/** Render the report for a verdict (ADR 0092 §1 — "emit what you scanned"). */
export const renderReport = (verdict: PreflightVerdict): string => {
	if (verdict.pass) {
		return (
			`vocabulary-preflight: prerequisites met — all ${verdict.labels} required labels exist, ` +
			`ROADMAP.md parses ${verdict.arcs} arc(s) and ${verdict.campaigns} campaign(s).`
		);
	}
	return (
		`vocabulary-preflight: ${verdict.unmet.length} unmet prerequisite(s) — the pipeline would run ` +
		"and protect nothing here:\n\n" +
		verdict.unmet.map(renderPrerequisite).join("\n\n")
	);
};
