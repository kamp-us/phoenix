/**
 * `vocabulary-seed` pure core — decide what an adopting repo is missing from the pipeline label
 * taxonomy, what a `ROADMAP.md` scaffold should say, and how to read a label-create outcome
 * (#4341).
 *
 * The write counterpart of `vocabulary-preflight`, which is read-only by contract. Everything the
 * seeder creates comes from `LABEL_SPECS`, the one create-ready home in
 * `../vocabulary-preflight/vocabulary.ts` — the seeder never carries its own list, because a
 * second list is exactly the drift that made this tool necessary.
 *
 * IO-free and total: the `gh api` reads/writes live in `github.ts`, the disk read/write in
 * `gate.ts`.
 */
import {
	type LabelSpec,
	REQUIRED_LABELS,
	unspecifiedRequiredLabels,
} from "../vocabulary-preflight/vocabulary.ts";

/** What happened to one label. `already-exists` is a success: seeding is idempotent by contract. */
export type LabelOutcome = "created" | "already-exists";

/** One label's result after `apply` ran (or would have, under `plan`). */
export interface LabelResult {
	readonly name: string;
	readonly outcome: LabelOutcome;
}

/** `ROADMAP.md` is written only when absent — an existing roadmap is never overwritten. */
export type RoadmapPlan =
	| {readonly _tag: "create"; readonly path: string}
	| {readonly _tag: "keep"; readonly path: string};

/** What a run would do, computed before it does anything. `plan` prints this and stops. */
export interface SeedPlan {
	readonly repo: string;
	readonly create: ReadonlyArray<LabelSpec>;
	readonly present: ReadonlyArray<string>;
	readonly roadmap: RoadmapPlan;
}

/**
 * Diff the create-ready taxonomy against the repo's live label universe.
 *
 * An empty universe is not a special case: every spec is then missing and gets created, which is
 * the from-zero adopter this tool exists for. Comparison is on the exact name — GitHub label names
 * are case-insensitive for uniqueness, so a repo carrying `P0` would still 422 on `p0`; `github.ts`
 * reads that 422 as `already-exists` rather than a failure, which is where that case resolves.
 */
export const planLabels = (
	specs: ReadonlyArray<LabelSpec>,
	universe: ReadonlyArray<string>,
): {readonly create: ReadonlyArray<LabelSpec>; readonly present: ReadonlyArray<string>} => {
	const create = specs.filter((spec) => !universe.includes(spec.name));
	const present = specs.filter((spec) => universe.includes(spec.name)).map((spec) => spec.name);
	return {create, present};
};

/**
 * A 422 that means "this label is already here" versus one that means the request was wrong.
 *
 * `POST /repos/{owner}/{repo}/labels` 422s on an existing name, and it 422s on a malformed colour.
 * Collapsing both into "failed" would break idempotency; collapsing both into "fine" would swallow
 * a real defect. The discriminator is the error body's `already_exists` code, which `gh api` prints
 * to STDOUT (not stderr) — hence `github.ts` capturing both streams and passing them here joined.
 */
export const isAlreadyExists = (output: string): boolean =>
	/already_exists|already exists/i.test(output);

/**
 * The seeded `ROADMAP.md`.
 *
 * Two constraints shape it. It must parse to at least one `## Arcs` row under
 * `roadmap-guard`'s parser, or the seeded repo trades a missing-roadmap red for an empty-roadmap
 * one. And the arc ships `queued` with NO milestone pin, because ADR 0072 makes creating a
 * milestone an explicitly human act and this tool creates none — a queued arc with no pin is the
 * legal shape for that (invariant I1), and the page says out loud who closes the gap.
 */
export const ROADMAP_SCAFFOLD = `# Roadmap

The roadmap in the maintainers' own voice. It is the **sole parsed roadmap surface**: the pipeline
reads the tables below rather than any tracker view, and the one \`active\` arc is what milestone
homing and the write-code picker resolve against.

Seeded by \`pipeline-cli vocabulary-seed apply\`. Edit it — the rows below are a starting shape,
not a fixture.

## Arcs

An arc is a phase of work with a beginning and an end. Exactly one arc is \`active\` at a time;
the rest are \`queued\` (sequenced ahead) or \`done\`.

| Arc | Milestone | State |
| --- | --- | --- |
| Adoption | — | queued |

## Campaigns

A campaign is a cross-cutting push that runs alongside the active arc. Campaigns may overlap.

| Campaign | Milestone | State |
| --- | --- | --- |

## Milestones are created by a human, never by this tool

Every non-queued row pins a GitHub milestone by number. **The seeder creates no milestones.**
Creating or restructuring a milestone is an explicitly human roadmap decision — no pipeline skill
or tool may create or delete one — so the arc above ships \`queued\` and unpinned, which is the
legal shape for an arc whose milestone does not exist yet.

To activate an arc, a maintainer of this repository:

1. creates the milestone in GitHub (Issues → Milestones → New milestone);
2. edits the arc's row here to pin that milestone by number and set the state to \`active\`.

Until an arc is activated this roadmap parses fine and clears the vocabulary preflight, but the
roadmap guard will report that no arc is active — that report is the reminder, not a defect.
`;

/**
 * The seeder's own precondition: every enforced label must be creatable from the one home. A
 * non-empty result is a wiring fault in this package, not an adopter's problem, so it is a refusal
 * rather than a partial seed (ADR 0092).
 */
export const seedPrecondition = (): string | null => {
	const unspecified = unspecifiedRequiredLabels();
	if (unspecified.length === 0) return null;
	return (
		`${unspecified.length} required label(s) have no create-ready row in LABEL_SPECS — ` +
		`${unspecified.join(", ")}. Seeding would leave the vocabulary preflight red, so this run ` +
		"refuses rather than seed a partial taxonomy."
	);
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Render the plan a `plan` run prints — the preview, before anything is written. */
export const renderPlan = (plan: SeedPlan): string => {
	const lines = [
		`vocabulary-seed: PLAN for ${plan.repo} — nothing has been written.`,
		"",
		`labels present: ${plan.present.length}`,
		`labels to create: ${plan.create.length}`,
	];
	for (const spec of plan.create)
		lines.push(`  + ${spec.name}  #${spec.color}  ${spec.description}`);
	lines.push(
		plan.roadmap._tag === "create"
			? `roadmap: would CREATE ${plan.roadmap.path}`
			: `roadmap: keeping the existing ${plan.roadmap.path} (never overwritten)`,
	);
	lines.push("", "Run `pipeline-cli vocabulary-seed apply` to write this.");
	return lines.join("\n");
};

/** Render what an `apply` run did, and what it left for a human. */
export const renderResult = (
	repo: string,
	labels: ReadonlyArray<LabelResult>,
	roadmap: RoadmapPlan,
): string => {
	const created = labels.filter((l) => l.outcome === "created");
	const existing = labels.filter((l) => l.outcome === "already-exists");
	const lines = [
		`vocabulary-seed: seeded ${repo}.`,
		"",
		`labels created: ${created.length}${created.length > 0 ? ` (${created.map((l) => l.name).join(", ")})` : ""}`,
		`labels already present: ${existing.length}`,
		roadmap._tag === "create"
			? `roadmap: created ${roadmap.path}`
			: `roadmap: left the existing ${roadmap.path} untouched`,
		"",
		`${REQUIRED_LABELS.length} ${plural(REQUIRED_LABELS.length, "label is", "labels are")} enforced by \`pipeline-cli vocabulary-preflight check\` — run it to confirm.`,
		"",
		"NOT seeded, by design: GitHub milestones. Creating one is a human roadmap decision (ADR",
		"0072); the seeded ROADMAP.md names the two steps a maintainer takes to activate an arc.",
	];
	return lines.join("\n");
};
