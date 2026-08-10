/**
 * fabrika's model vocabulary — the allowlist, the harness alias map and the default pin.
 *
 * The three belong together because a decision needs all three at once: a requested model is
 * **canonicalized through the alias map before** it is checked against the allowlist, and an absent
 * `WORKFLOW_MODEL` pin falls back to the default. Splitting them lets one drift from the others.
 *
 * This module is fabrika's ONE source for that knowledge — every consumer under `packages/fabrika-cli/`
 * imports it and nothing declares a second copy ([#5075](https://github.com/kamp-us/phoenix/issues/5075),
 * and [#5158](https://github.com/kamp-us/phoenix/issues/5158) which normalizes `--model` aliases
 * against the same table). Reimplemented from v1's `spawn-guard`, never imported from it: ADR
 * [0238](../../../.decisions/0238-fabrika-reimplements-v1-never-calls-it.md) freezes v1, so its scars
 * are carried across as behaviour and as the tests below, not as a dependency.
 */

/** The canonical model ids a spawned subagent may run on — the Opus 4.8 family, and only it. */
export const ALLOWLIST: ReadonlyArray<string> = ["claude-opus-4-8", "claude-opus-4-8[1m]"];

/**
 * Harness alias → canonical id.
 *
 * The harness spells a spawn's model in its own short vocabulary: the captured `Agent` envelope at
 * `src/hook/__fixtures__/pre-tool-use-task-spawn.payload.golden.json` carries `"model": "opus"`, never
 * `claude-opus-4-8`. An allowlist holding only canonical ids therefore denied the very family it
 * exists to permit, which is v1's #2565. Only the Opus-4.8 family has an entry — `sonnet` and `haiku`
 * are deliberately absent, so they canonicalize to themselves, miss the allowlist and stay denied.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
	opus: "claude-opus-4-8",
	"opus[1m]": "claude-opus-4-8[1m]",
};

/**
 * The committed pin an absent `WORKFLOW_MODEL` falls back to (ADR 0116).
 *
 * Living in source rather than in an operator's shell is the whole point: without it a fresh clone,
 * CI or cron has no pin, and an unset spawn fails closed on a machine that never misconfigured
 * anything. Must stay a member of {@link ALLOWLIST} — `models.unit.test.ts` holds it there.
 */
export const DEFAULT_PIN = "claude-opus-4-8[1m]";

/** A trimmed non-empty string, or null. Whitespace and absence are the same input: no model. */
export const normalizeModel = (model: string | null | undefined): string | null => {
	if (model == null) return null;
	const trimmed = model.trim();
	return trimmed === "" ? null : trimmed;
};

/**
 * Resolve an alias to its canonical id. A value that is not an alias — including a canonical id, and
 * including a model nobody has ever heard of — passes through unchanged, so an unknown model reaches
 * the allowlist check as itself and is judged there rather than rejected here.
 */
export const canonicalModel = (model: string | null | undefined): string | null => {
	const normalized = normalizeModel(model);
	if (normalized === null) return null;
	return MODEL_ALIASES[normalized] ?? normalized;
};

/** Is this model — after canonicalization — one a spawn may run on? */
export const isAllowlisted = (model: string | null | undefined): boolean => {
	const canonical = canonicalModel(model);
	return canonical !== null && ALLOWLIST.includes(canonical);
};
