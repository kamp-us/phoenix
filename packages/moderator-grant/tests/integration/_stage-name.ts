/**
 * Pure per-file stage-name construction for the grant integration harness
 * (`_d1.ts`) — the same invariant + shape `@kampus/preview-seed`'s
 * `tests/integration/_stage-name.ts` (and apps/web's) upholds (real remote D1 + a
 * shared Cloudflare account are stage-keyed, so a stage name must be run-unique and
 * Cloudflare-resource-name-legal). Kept local to this package because the apps/web /
 * preview-seed copies are test-internal (not a shared export), and the helper is
 * small and pure. Unit-pinned in `_stage-name.unit.test.ts`.
 *
 * The invariant: `[a-z0-9-]` only, no leading/trailing dash, no internal `--`,
 * non-empty, ≤ MAX_STAGE_LEN.
 */

// Stage length is load-bearing: alchemy's `createPhysicalName` hard-caps a D1 name
// at 64 chars by truncating the readable prefix while preserving the trailing 16-char
// hash. Capping the stage at 26 keeps the readable prefix comfortably under the cap so
// the stage is never the part alchemy truncates (the #689 class).
export const MAX_STAGE_LEN = 26;
export const DISC_LEN = 8;

const STAGE_PREFIX = "it-";

// Deterministic fixed-length discriminator (FNV-1a 32-bit → base36, padded/truncated
// to DISC_LEN). Fed `${slug}|${runToken}`, it carries BOTH file-distinctness (slug)
// and run-distinctness (runToken) in a constant width.
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
 */
export const stageName = (slug: string, noDestroy: boolean, runToken: string): string => {
	if (noDestroy) return collapse(`${STAGE_PREFIX}${slug}`);

	const readableBudget = MAX_STAGE_LEN - STAGE_PREFIX.length - 1 - DISC_LEN;
	const readable = slug.slice(0, readableBudget).replace(/-$/, "");
	return collapse(`${STAGE_PREFIX}${readable}-${disc(`${slug}|${runToken}`)}`);
};

// Fold any run of dashes to one and trim the ends, so an empty `slug`/`readable`
// can't leave `it--<disc>` (internal `--`) or a trailing dash.
const collapse = (name: string): string => name.replace(/-+/g, "-").replace(/(^-|-$)/g, "");
