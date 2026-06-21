/**
 * Pure per-file stage-name construction for the integration harness (`_integration.ts`).
 *
 * Split out so the naming invariants are unit-testable without the env-/deploy-coupled
 * `stageFor`: given a raw test-file basename, the run mode, and a run token, this
 * yields the stage name `_integration.ts` deploys under. The invariant it upholds —
 * `[a-z0-9-]` only, no leading/trailing dash, no internal `--`, non-empty — is the
 * Cloudflare resource-name contract `stageFor`'s docblock states (see `_integration.ts`).
 */

export const DISC_LEN = 8;

// The human-debug `readable` prefix is trimmed to this width. Purely cosmetic now: the
// harness reads the deployed D1's uuid off the compiled Stack output (#692), so no name
// reconstruction couples to the stage length — `disc` alone carries uniqueness. The #689
// `MAX_STAGE_LEN` guard (a bound on the stage so alchemy's `createPhysicalName` 64-char
// truncation never cut the prefix-match's readable part) is retired with that coupling.
const READABLE_MAX = 15;

const STAGE_PREFIX = "it-";

// Deterministic fixed-length discriminator (FNV-1a 32-bit → base36, padded/truncated to
// DISC_LEN). Fed `${slug}|${runToken}`, it carries BOTH file-distinctness (within a run)
// and run-distinctness (across runs) in a constant width — the sole uniqueness guarantee,
// never depending on the raw slug or token fitting into the name.
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
 *   - otherwise: `it-<readable>-<disc>`, where `<disc>` alone makes it run-unique.
 *
 * `readable` is a slug prefix (trimmed to `READABLE_MAX`) kept only as a human-debug aid.
 * A punctuation-only basename sanitizes to an empty slug; the placeholder + dash-collapse
 * below keep the output non-empty and free of leading/trailing/internal `--` for every
 * input (#698).
 */
export const stageName = (slug: string, noDestroy: boolean, runToken: string): string => {
	if (noDestroy) return collapse(`${STAGE_PREFIX}${slug}`);

	const readable = slug.slice(0, READABLE_MAX).replace(/-$/, "");
	return collapse(`${STAGE_PREFIX}${readable}-${disc(`${slug}|${runToken}`)}`);
};

/**
 * The run-scoped SHARED stage name (ADR 0104 step 7, #1027) — `it-shared-<disc>`.
 *
 * One stage per RUN, not per file: globalSetup deploys it once and every migrated file reads
 * the injected handle. `<disc>` is the SAME fixed-width hash `stageName` uses, seeded on
 * `shared|<runToken>` — so it is run-unique across concurrent PRs and reruns (the runToken
 * carries CI's `<run-id>-<run-attempt>`, else a per-process local token), mirroring the
 * per-file stage's run-uniqueness while collapsing the per-file `<slug>` dimension to the
 * single literal `shared`. Same `[a-z0-9-]` invariant via `collapse`.
 */
export const sharedStageName = (runToken: string): string =>
	collapse(`${STAGE_PREFIX}shared-${disc(`shared|${runToken}`)}`);

// The per-file namespace token a migrated file prefixes EVERY row it seeds with, so the
// shared stage's single D1 can't collide across files (ADR 0104 step 7, #1027).
const NS_TOKEN_LEN = 12;

/**
 * A deterministic, file-derived namespace token for a file's seeded rows on the SHARED
 * stage — `nsToken("…/report.test.ts") === "report"`, `"…/pasaport-from-tag.test.ts"`
 * → `"pasaport-fro"`. Derived from the file basename (the `.test.ts` stripped,
 * `slugify`'d, capped to `NS_TOKEN_LEN`), it is deterministic and collision-free across
 * files — two files can never share a token, where the old per-file `Date.now()` STAMP
 * could (and carried no file identity). A migrated file prefixes every slug/email/id it
 * seeds with this so its rows are uniquely its own on the shared D1, and scopes every
 * assertion to those `NS`-prefixed rows.
 */
export const nsToken = (metaUrl: string): string =>
	slugify((metaUrl.split("/").pop() ?? "f").replace(/\.test\.ts$/, "")).slice(0, NS_TOKEN_LEN);

// Fold any run of dashes to one and trim the ends — an empty `slug`/`readable` would
// otherwise leave `it--<disc>` (internal `--`) or a trailing dash, both of which the
// docblock invariant forbids. A name reduced to bare `it` (empty slug under NO_DESTROY)
// stays valid: non-empty, no edge dash.
const collapse = (name: string): string => name.replace(/-+/g, "-").replace(/(^-|-$)/g, "");
