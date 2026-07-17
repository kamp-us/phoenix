/**
 * `commands` core — the pure, rot-proof derivation of the pipeline-cli tool index.
 *
 * The index is sourced from the registry itself: every registered tool is a
 * `Command` carrying its own `name` + `description` (`Command.withDescription`) —
 * the *same* object the router dispatches on (`router.ts` reads `.name`). Deriving
 * the discovery surface from that array means it can't drift: a newly-registered
 * tool appears automatically, and one that ships without a description is detectable
 * (`description === undefined`). There is no parallel hand-maintained list to rot —
 * the exact failure mode of the stale README this replaces (#3316).
 *
 * Pure and IO-free: it operates on an injected registry array, so it is unit-tested
 * without importing the real `registry.ts` (and without spawning the bin). The Effect
 * command layer (`command.ts`) resolves the real `registeredTools` and feeds it in.
 */

/** The minimal shape the index reads off a registered tool — its `name` + one-line `description`. */
export interface ToolMeta {
	readonly name: string;
	readonly description: string | undefined;
}

/** Registry order is insertion-arbitrary; discovery scans by name, so the index is alphabetical. */
export const toolEntries = (registry: ReadonlyArray<ToolMeta>): ReadonlyArray<ToolMeta> =>
	[...registry].sort((a, b) => a.name.localeCompare(b.name));

/**
 * One line per tool — `name · description` — mirroring `decisions-index compact`'s
 * `id · title · status` ambient-discovery surface (ADR 0126). A tool missing a
 * description (a bug `check` reds on) renders an explicit marker rather than a blank.
 */
export const renderCompact = (registry: ReadonlyArray<ToolMeta>): string =>
	toolEntries(registry)
		.map((t) => `${t.name} · ${describe(t)}`)
		.join("\n");

const describe = (t: ToolMeta): string => {
	const d = t.description?.trim();
	return d && d.length > 0 ? d : "(undocumented — see `pipeline-cli commands check`)";
};

/**
 * The names of registered tools missing a one-line description (undefined or blank).
 * A non-empty result is the `check` gate's fail condition — it is what makes a
 * newly-registered tool unable to silently ship without appearing in the index (AC #4).
 */
export const undocumentedTools = (registry: ReadonlyArray<ToolMeta>): ReadonlyArray<string> =>
	toolEntries(registry)
		.filter((t) => {
			const d = t.description?.trim();
			return d === undefined || d.length === 0;
		})
		.map((t) => t.name);
