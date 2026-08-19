/**
 * Pure per-file stage-name construction for the seed integration harness (`_d1.ts`). Real
 * remote D1 on a shared Cloudflare account is stage-keyed, so the name must be run-unique
 * and resource-name-legal: `[a-z0-9-]` only, no leading/trailing dash, no internal `--`,
 * non-empty, ≤ MAX_STAGE_LEN. A local copy of apps/web's, whose version is test-internal.
 */

// Stage length is load-bearing: alchemy's `createPhysicalName` hard-caps a D1 name
// at 64 chars by truncating the readable prefix while preserving the trailing 16-char
// hash. Capping the stage at 26 keeps the readable prefix comfortably under the cap so
// the stage is never the part alchemy truncates (the #689 class).
export const MAX_STAGE_LEN = 26;
export const DISC_LEN = 8;

const STAGE_PREFIX = "it-";

// FNV-1a 32-bit → base36, at a constant width. Fed `${slug}|${runToken}`, so it carries
// both file-distinctness and run-distinctness.
export const disc = (seed: string): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(DISC_LEN, "0").slice(0, DISC_LEN);
};

export const slugify = (base: string): string =>
	base
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");

/** `NO_DESTROY` drops the discriminator so a kept-alive local deploy re-adopts by name. */
export const stageName = (slug: string, noDestroy: boolean, runToken: string): string => {
	if (noDestroy) return collapse(`${STAGE_PREFIX}${slug}`);

	const readableBudget = MAX_STAGE_LEN - STAGE_PREFIX.length - 1 - DISC_LEN;
	const readable = slug.slice(0, readableBudget).replace(/-$/, "");
	return collapse(`${STAGE_PREFIX}${readable}-${disc(`${slug}|${runToken}`)}`);
};

// Fold any run of dashes to one and trim the ends, so an empty `slug`/`readable`
// can't leave `it--<disc>` (internal `--`) or a trailing dash.
const collapse = (name: string): string => name.replace(/-+/g, "-").replace(/(^-|-$)/g, "");
