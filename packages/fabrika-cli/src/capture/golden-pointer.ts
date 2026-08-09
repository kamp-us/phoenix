/**
 * The golden POINTER — the committed git metadata mapping a capture surface-id to
 * its current blessed golden (ADR 0183). The golden BYTES live in depo
 * (content-addressed, immutable — ADR 0144); git carries ONLY this tiny pointer,
 * so a re-bless is a one-line reviewable diff and history never bloats with PNGs.
 *
 * This is the migrations-guard committed-baseline + `bless` idiom (ADR 0108): the
 * pointer file is the audited baseline, `blessSurface` is the deliberate re-bless
 * (the golden analogue of `deriveBaseline`), and depo's write-once immutability IS
 * the "explicit update, never silent overwrite" guarantee (epic #2955 story 9) —
 * a re-bless is a new sha256 → new depo URL → a pointer move, never an in-place
 * overwrite of live bytes.
 *
 * Pure + IO-free (the unit-tested resolution/bless logic), and dependency-free so
 * the pure test never has to load the depo client: the fs load/serialize boundary
 * lives in `golden-fs.ts`, and the depo URL/store/fetch boundary — including
 * `resolveGoldenUrl` (sha256 → immutable depo URL) — in `golden-store.ts`.
 */

/**
 * One surface's current golden, exactly the ADR 0183 §2 schema
 * (`surface-id -> { sha256, blessed-date, intent }`). The bytes are at
 * `depo.kamp.us/<sha256>.png`; this record is the pointer, not the image.
 */
export interface GoldenEntry {
	/** 64-hex depo content-address stem — the blessed bytes at `depo.kamp.us/<sha256>.png`. */
	readonly sha256: string;
	/** ISO date (YYYY-MM-DD) the surface was blessed to this sha. */
	readonly blessedDate: string;
	/** Human note: what this golden captures / why it was (re-)blessed. */
	readonly intent: string;
}

/** The whole pointer: surface-id (the `<route>[:state]` capture spec) → its current golden. */
export type GoldenPointer = Readonly<Record<string, GoldenEntry>>;

/** A 64-char lowercase-hex sha256 — the exact shape depo content-addresses with. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

export const isSha256Hex = (value: string): boolean => SHA256_HEX.test(value);

/** The blessed golden for a surface, or `null` when the surface has no golden yet. */
export const resolveGoldenEntry = (pointer: GoldenPointer, surfaceId: string): GoldenEntry | null =>
	pointer[surfaceId] ?? null;

/** The blessed surface-ids, sorted — stable for a reviewable diff and deterministic listing. */
export const blessedSurfaces = (pointer: GoldenPointer): readonly string[] =>
	Object.keys(pointer).sort();

/** The fields a bless supplies for a surface; `blessedDate` is stamped by the caller. */
export interface BlessInput {
	readonly surfaceId: string;
	readonly sha256: string;
	readonly blessedDate: string;
	readonly intent: string;
}

/**
 * Move a surface's golden pointer to a new blessed sha — returning a NEW pointer,
 * never mutating the input (immutability is the whole guarantee, so the baseline
 * an audit reads can't be clobbered under it). Blessing to a new sha is a pointer
 * move; blessing to the same sha with a fresh date/intent is a re-record. Rejects
 * a non-sha256 stem (`.png` or a URL is a caller bug) and an empty surface/intent —
 * an invalid pointer must be unrepresentable, not silently written.
 */
export const blessSurface = (pointer: GoldenPointer, input: BlessInput): GoldenPointer => {
	if (input.surfaceId.length === 0) {
		throw new Error("golden-pointer: cannot bless an empty surface-id");
	}
	if (!isSha256Hex(input.sha256)) {
		throw new Error(
			`golden-pointer: sha256 must be a 64-hex depo content-address stem (no ".png", no URL), got "${input.sha256}"`,
		);
	}
	if (input.intent.trim().length === 0) {
		throw new Error(`golden-pointer: bless of ${input.surfaceId} needs a non-empty intent`);
	}
	return {
		...pointer,
		[input.surfaceId]: {
			sha256: input.sha256,
			blessedDate: input.blessedDate,
			intent: input.intent,
		},
	};
};
