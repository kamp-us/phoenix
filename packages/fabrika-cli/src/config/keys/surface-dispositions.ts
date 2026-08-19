/**
 * `surfaceDispositions` — what fabrika does in **this** repo when a surface it reads is not there.
 *
 * This is the single home of the answer the per-skill `## Required repo files` tables used to give
 * thirty-two times over (#6301, R10.1 on #5603). Those tables were prose: nothing read them but a
 * parser, three skills gave three different dispositions for the same label taxonomy, and a repo had
 * no way to say "I run no design system" other than editing somebody else's SKILL.md. One key, one
 * registry, one verb that prints it — `fabrika status settings`.
 *
 * **The registry is closed, and an id it does not know is refused.** A repo declaring
 * `"desing-manifest": "degrade"` would otherwise hold a setting it believes is configured and is not.
 * A repo declares only the ids it wants to move; every other id falls to its shipped disposition,
 * which is what makes an absent key and an absent file the same well-formed answer.
 *
 * **Every shipped disposition was read off its verb, never copied from the retired table.** The
 * tables were not a faithful copy of the code: `build` and this group's own front door called the
 * board label taxonomy `bootstrap` while `ledger child` exits 10 on it, and `front-door` called the
 * `.gitignore` row `bootstrap` while every lane verb runs fine without one. Each entry's `note` names
 * the arm that was read, so a reader can check the claim rather than take it.
 *
 * **What is not here.** A surface whose behaviour another key already decides is that key's, not this
 * one's — zero CI workflows is `ci.noProducer`.
 * A *path* key is not such a key: `roadmapFile` and `cycleDoc` say where a file lives, never what
 * happens when it is not there, so both surfaces are registered here (#6301's first review round
 * missed exactly this and the two entries were absent).
 * And a per-issue or per-PR input — an acceptance-criteria block, a `## Deviations` section, an
 * epic's `## Dependencies` — is not a repo surface at all: it is one artifact's content, and the
 * verb's exit code is the whole contract.
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const SURFACE_DISPOSITIONS = "surfaceDispositions";

/**
 * The closed when-missing vocabulary. **Each word says what happens to a run**, never who can fix
 * the repo — the two axes were fused across the retired tables and that fusion is most of why three
 * skills gave one surface three words.
 *
 * - `fail-loud` — a verb that needs it refuses and names it. The run stops.
 * - `degrade` — the run continues with a narrower answer, and says so.
 * - `bootstrap` — the verb answers the literal outcome `bootstrap` at exit `0`: this repo has not
 *   adopted the surface yet, which is a day-one fact rather than a fault. Only `glossary` and
 *   `pattern` have it.
 *
 * Buildability is the other axis and already has a home: `status bootstrap`'s own
 * `BUILDABLE_SURFACES`. `design-manifest` is `fail-loud` **and** buildable there, and reading one
 * off the other is what the fused vocabulary kept inviting.
 */
export type Disposition = "fail-loud" | "degrade" | "bootstrap";

const DISPOSITIONS: ReadonlyArray<Disposition> = ["fail-loud", "degrade", "bootstrap"];

export type SurfaceDispositions = Readonly<Record<string, Disposition>>;

export interface SurfaceSpec {
	readonly id: string;
	readonly disposition: Disposition;
	/** What the surface is, and the verb arm the disposition was read off. */
	readonly note: string;
}

/**
 * Every repo surface a fabrika verb reads by name, with the disposition it ships with.
 *
 * Ordered by what a reader is looking for — access, board, prose homes, design, merge and CI, the
 * machine-local surfaces — not alphabetically, because the groups are how an adopting repo works
 * through them.
 */
export const SURFACE_REGISTRY: ReadonlyArray<SurfaceSpec> = [
	{
		id: "gh-rest",
		disposition: "fail-loud",
		note: "a GitHub repo reachable over `gh` REST with `issues: write`; every issue-writing verb exits 11 without it, and a run with no board is no answer rather than a narrower one",
	},
	{
		id: "git-worktree",
		disposition: "fail-loud",
		note: "a git working tree whose root resolves; `build tree`, `handoff capture` and `spike open` all derive their state from it",
	},
	{
		id: "git-origin",
		disposition: "degrade",
		note: "a remote named `origin` to compare a branch against; `handoff`'s `reachable`, `aheadBy` and `behindBy` render unproven rather than refusing",
	},
	{
		id: "git-history",
		disposition: "degrade",
		note: "history for the doc surface plus a resolvable base ref; `pattern drift` reports a doc unaged instead of refusing",
	},
	{
		id: "collaborator-permissions",
		disposition: "fail-loud",
		note: "`repos/<repo>/collaborators/<login>/permission` readable; every ACL-resolved claim and ruling is UNKNOWN without it, never permissive (ADR 0055)",
	},
	{
		id: "issue-dependencies",
		disposition: "fail-loud",
		note: "GitHub's native sub-issue and issue-dependency endpoints; the frontier's edges and an epic's child set live there and nowhere else",
	},
	{
		id: "label-taxonomy",
		disposition: "fail-loud",
		note: "the board vocabulary's statuses, types, priorities and audiences; `ledger child` exits 10 and `triage apply` refuses rather than minting a label nobody declared (#4285) — `status bootstrap label-taxonomy` is the remedy, which is the other axis",
	},
	{
		id: "issue-shape-markers",
		disposition: "fail-loud",
		note: "`wayfinding:map`, `prototyping:spike`, `grilling:session`; `graduate trail` exits 12 naming which it looked for, and a map nobody can find again is worse than one never minted",
	},
	{
		id: "standing-lanes",
		disposition: "degrade",
		note: "the standing-lane labels `boardVocabulary.standingLanes` names; `status bootstrap` creates none of them, and a repo that homes work on milestones needs none",
	},
	{
		id: "issue-home",
		disposition: "fail-loud",
		note: "an open milestone or a standing lane on the issue itself; `build claim`'s fence refuses a homeless issue at exit 20 and writes no marker",
	},
	{
		id: "roadmap-focus",
		disposition: "degrade",
		note: "the `## Campaigns` table at `roadmapFile`, which declares the campaign in exclusive focus; an absent file and an absent table are the same well-formed default — nothing is active, so `build pick`'s and `build claim`'s fence is inert and admits every issue, and `triage homes` answers over the milestones alone (#5773) — buildable through `status bootstrap roadmap-focus`, which is the other axis",
	},
	{
		id: "cycle-doc",
		disposition: "degrade",
		note: "the product-development cycle doc `cycleDoc` names, the surface a containment class is derived from; `ledger open` probes it and answers `absent` at exit 0, and every child body `ledger child` composes then drops its `**Containment:**` field rather than deriving a class from a doc that is not there",
	},
	{
		id: "decisions-corpus",
		disposition: "fail-loud",
		note: "the `NNNN-slug.md` records under `decisionsDir`; `governance sweep` and `digest` refuse `7` naming the corpus, whether it is absent or declined, and `governance guards` still runs — a sweep over no corpus is not a clean sweep",
	},
	{
		id: "decisions-rarity-floor",
		disposition: "degrade",
		note: "at least ten live-`accepted` records, below which every term scores common; `governance sweep` says the ranking carries no information and still ranks",
	},
	{
		id: "patterns-dir",
		disposition: "degrade",
		note: "the flat `<slug>.md` doc surface `pattern corpus`, `drift` and `anchor` read; `pattern corpus` answers the proven negative `absent` at exit 0, and `pattern new` creates `--dir` when it writes the first doc",
	},
	{
		id: "patterns-index",
		disposition: "fail-loud",
		note: "the index whose tables register each doc; `pattern register` proves its edit against the file and cannot invent one",
	},
	{
		id: "patterns-admission-bar",
		disposition: "degrade",
		note: "the *when to add a doc here* criteria inside that index; without it the bar is the author's judgement, stated as such",
	},
	{
		id: "glossary-registers",
		disposition: "bootstrap",
		note: "the domain-noun and architecture-vocabulary registers; `glossary drift` and `check` answer the literal outcome `bootstrap` at exit 0 over an *absent* register, because refusing would leave a fresh repo unable to reach the verb that writes one — a register that is there and holds zero rows is `glossary check`'s 7 instead, since a clean scan of an empty register is not a clean scan (ADR 0092)",
	},
	{
		id: "prose-homes",
		disposition: "degrade",
		note: "the placement homes a prose fact lands in; `build` writes into the homes that exist and discloses the substituted one",
	},
	{
		id: "doc-gates",
		disposition: "degrade",
		note: "the repo's own leak and dead-link checks over changed markdown; `glossary check` and `write-pattern` compute no second verdict and say the deferral is unbacked",
	},
	{
		id: "dep-manifest",
		disposition: "degrade",
		note: "the workspace manifest pinning dependency versions; `pattern anchor` reports a doc's `Derived from` package unresolved",
	},
	{
		id: "design-manifest",
		disposition: "fail-loud",
		note: "the repo's design law; `ui manifest` exits 12 and `build-ui` carries no law of its own — buildable through `status bootstrap design-manifest`, which is a different question",
	},
	{
		id: "design-prohibitions",
		disposition: "degrade",
		note: "the typed rubric beside the manifest; `ui law` exits 13 and the manifest's prose prohibitions are the law instead",
	},
	{
		id: "design-inventory",
		disposition: "degrade",
		note: "the component inventory a generation step selects from; `ui manifest` resolves it `null`, a fact and not an error",
	},
	{
		id: "golden-pointer",
		disposition: "degrade",
		note: "the blessed-surface pointer `ui golden` answers from; an unblessed surface is a fact and the rubric carries the judgement alone",
	},
	{
		id: "design-harness",
		disposition: "degrade",
		note: "the harness file `designHarness` names, declaring the dev server to render at; `ui render` answers that the tree cannot be rendered here",
	},
	{
		id: "dev-server",
		disposition: "fail-loud",
		note: "a server that actually comes ready at the harness's `readyPath`; `ui render` captures nothing and never renders a blank page as a surface",
	},
	{
		id: "preview-deployment",
		disposition: "fail-loud",
		note: "a per-PR preview the visual gate reads pixels from; `review-ui render` exits 16 rather than judging a surface it cannot see",
	},
	{
		id: "codeowners",
		disposition: "degrade",
		note: "`.github/CODEOWNERS` carrying a control-plane row; a proven-absent file is an empty row set and holds on `unknown`, and an *unreadable* one is the caller's `11` in every repo (ADR 0220 §4)",
	},
	{
		id: "landing-path",
		disposition: "degrade",
		note: "a merge queue on the base branch, or a repo permitting one merge method; `ship` lands through whichever exists and names which it took",
	},
	{
		id: "required-status-contexts",
		disposition: "degrade",
		note: "the base ref's declared required checks, off a ruleset or branch protection; unreadable on a private repo without a paid plan, so `heal-ci surface` compares what it can read",
	},
	{
		id: "governance-floor-workflow",
		disposition: "degrade",
		note: "the workflow running `ship floor` on every PR; without it the floor binds on the reader rather than on a machine, and `ship` says so",
	},
	{
		id: "code-validators",
		disposition: "fail-loud",
		note: "a command `codeValidators` names that can actually be spawned here; `build check --surface code` refuses UNKNOWN on an empty list or a validator it cannot run — never green, never red",
	},
	{
		id: "readout-artifact",
		disposition: "fail-loud",
		note: "the open issue the landed-decision digest lives on; `governance readout` exits 7 naming the absent target rather than posting the digest somewhere improvised (`status readout` reads it and answers `absent` at 0 — reading and writing are not the same question)",
	},
	{
		id: "gitignore-row",
		disposition: "degrade",
		note: "a `.gitignore` covering the lane ledger's root; every lane verb works without it and the only cost is a machine-local ledger committed by accident (#5777)",
	},
	{
		id: "temp-root",
		disposition: "fail-loud",
		note: "a writable OS temp root outside the tree; a spike workspace inside the repo is the contamination the disposal check exists to prevent",
	},
	{
		id: "claim-signal",
		disposition: "degrade",
		note: "an assignee or the construction lane's claim marker; `heal-ci diagnose` folds `attended` into the unclaimed classes and says the signal was unread",
	},
	{
		id: "verdict-history",
		disposition: "degrade",
		note: "the SHA-bound verdict markers a review lane posts; with none, every PR reads `ungated`, which is the true answer on a repo that has never gated one",
	},
];

export const SHIPPED_SURFACE_DISPOSITIONS: SurfaceDispositions = Object.fromEntries(
	SURFACE_REGISTRY.map((surface) => [surface.id, surface.disposition]),
);

const KNOWN_IDS = new Set(SURFACE_REGISTRY.map((surface) => surface.id));

/**
 * The registry joined to what this repo resolved — every id, the disposition in force here, and
 * what the surface is.
 *
 * The registry ships the notes and the config carries the overrides, so neither half answers "what
 * happens here when this is missing" alone. `status settings --surfaces` is the one caller, and it
 * exists because the front door's step 3 relays a surface's note to a human (#6301).
 */
export const surfaceNotes = (resolved: SurfaceDispositions): ReadonlyArray<SurfaceSpec> =>
	SURFACE_REGISTRY.map((surface) => ({
		...surface,
		disposition: resolved[surface.id] ?? surface.disposition,
	}));

const decode = (raw: unknown): Decoded<SurfaceDispositions> => {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {_tag: "Malformed", reason: `\`${SURFACE_DISPOSITIONS}\` is not an object`};
	}
	const declared: Record<string, Disposition> = {...SHIPPED_SURFACE_DISPOSITIONS};
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!KNOWN_IDS.has(id)) {
			return {
				_tag: "Malformed",
				reason: `\`${SURFACE_DISPOSITIONS}\` names \`${id}\`, which is not a surface fabrika reads — the ids are ${[...KNOWN_IDS].join(", ")}`,
			};
		}
		if (typeof value !== "string" || !DISPOSITIONS.includes(value as Disposition)) {
			return {
				_tag: "Malformed",
				reason: `\`${SURFACE_DISPOSITIONS}\`'s \`${id}\` is not one of ${DISPOSITIONS.join(", ")}`,
			};
		}
		declared[id] = value as Disposition;
	}
	return {_tag: "Value", value: declared};
};

export const surfaceDispositionsKey: KeyGroup<SurfaceDispositions> = {
	key: SURFACE_DISPOSITIONS,
	shippedDefault: SHIPPED_SURFACE_DISPOSITIONS,
	decode,
};
