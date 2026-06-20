/**
 * Pure per-file stage-name construction for the integration harness (`_integration.ts`).
 *
 * Split out so the naming invariants are unit-testable without the env-/deploy-coupled
 * `stageFor`: given a raw test-file basename, the run mode, and a run token, this
 * yields the stage name `_integration.ts` deploys under. The invariant it upholds —
 * `[a-z0-9-]` only, no leading/trailing dash, no internal `--`, non-empty — is the
 * Cloudflare resource-name contract `stageFor`'s docblock states (see `_integration.ts`).
 */

// Stage length is load-bearing: alchemy's `createPhysicalName` hard-caps a D1 name at
// 64 chars by truncating the readable prefix while preserving the trailing 16-char
// hash, and the harness's `resolveD1DatabaseId` (_harness.ts) reconstructs the name as
// `phoenix-phoenix-db-${stage}-…` and finds the DB by that prefix — if alchemy
// truncated the stage out of the readable prefix, `startsWith` misses and the lookup
// throws (the #689 `sozluk-keyset` failure). Budget: `phoenix-phoenix-db-` (19) + `-`
// + hash16 (17) = 36 fixed; capping the stage at 26 keeps the readable prefix (19+26=45)
// comfortably under the cap so the stage is never the part alchemy truncates.
export const MAX_STAGE_LEN = 26;
export const DISC_LEN = 8;

const STAGE_PREFIX = "it-";

// Deterministic fixed-length discriminator (FNV-1a 32-bit → base36, padded/truncated to
// DISC_LEN). Fed `${slug}|${runToken}`, it carries BOTH file-distinctness (within a run)
// and run-distinctness (across runs) in a constant width, so the bounded stage never has
// to depend on the raw slug or token fitting.
export const disc = (seed: string): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(DISC_LEN, "0").slice(0, DISC_LEN);
};

/** Sanitize a raw test-file basename to the `[a-z0-9-]` set with no leading/trailing dash. */
export const slugify = (base: string): string =>
	base
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");

/**
 * Build the stage name from an already-sanitized `slug`.
 *
 *   - `NO_DESTROY`: stable `it-<slug>` so a kept-alive local deploy re-adopts by name.
 *   - otherwise: `it-<readable>-<disc>`, always ≤ MAX_STAGE_LEN.
 *
 * `readable` is a slug prefix kept only as a human-debug aid. A punctuation-only basename
 * sanitizes to an empty slug; the placeholder + dash-collapse below keep the output
 * non-empty and free of leading/trailing/internal `--` for every input (#698).
 */
export const stageName = (slug: string, noDestroy: boolean, runToken: string): string => {
	if (noDestroy) return collapse(`${STAGE_PREFIX}${slug}`);

	const readableBudget = MAX_STAGE_LEN - STAGE_PREFIX.length - 1 - DISC_LEN;
	const readable = slug.slice(0, readableBudget).replace(/-$/, "");
	return collapse(`${STAGE_PREFIX}${readable}-${disc(`${slug}|${runToken}`)}`);
};

// Fold any run of dashes to one and trim the ends — an empty `slug`/`readable` would
// otherwise leave `it--<disc>` (internal `--`) or a trailing dash, both of which the
// docblock invariant forbids. A name reduced to bare `it` (empty slug under NO_DESTROY)
// stays valid: non-empty, no edge dash.
const collapse = (name: string): string => name.replace(/-+/g, "-").replace(/(^-|-$)/g, "");
