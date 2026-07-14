/**
 * The candidate-set contract (epic #2955 story 1 → 2, ADR 0183 §5): the pure
 * assembly + (de)serialization of the SET the blessing surface (#2962) consumes.
 *
 * A candidate SET is the input to the founder's one blessing session: one candidate
 * SCREEN per priority surface, each carrying its surface identity + the depo
 * content-address of the exact rendered bytes (`sha256` + immutable `url`). That
 * `sha256` is load-bearing — it is the byte-faithfulness anchor of ADR 0183 §5's
 * no-re-render guard: the blessing surface embeds `url` in the gallery comment at
 * full resolution, the founder approves it, and the blessed pointer moves to THIS
 * `sha256` — never a re-render. So the render step (this package) PUTs each candidate
 * to depo up front and emits its `sha256` here, and the bless commits exactly it.
 *
 * Pure + IO-free: `assembleCandidateSet` folds resolved priority surfaces against
 * their rendered+stored artifacts (unit-tested — same inputs → same set), and
 * `serialize`/`parse` are the JSON boundary the blessing surface decodes. Hand-
 * validated (the `golden-fs.ts` idiom) so a malformed set fails loud, never as a
 * half-filled set a bless would mis-read.
 */

import {isSha256Hex} from "./golden-pointer.ts";
import type {ResolvedPrioritySurface} from "./priority-surfaces.ts";

/** One rendered-and-stored candidate screen — a blessing-gallery entry. */
export interface CandidateScreen {
	/** 1-based founder-decided blessing order (#2944). */
	readonly order: number;
	/** The `<route>[:state]` surface-id — the golden-pointer key a bless moves. */
	readonly surfaceId: string;
	/** Human label shown in the gallery. */
	readonly title: string;
	/** The bless intent recorded on the pointer when this candidate is blessed. */
	readonly intent: string;
	/** 64-hex depo content-address of the EXACT rendered bytes (the no-re-render anchor). */
	readonly sha256: string;
	/** Immutable `depo.kamp.us/<sha256>.png` URL — the full-res gallery embed. */
	readonly url: string;
	/** Filesystem-safe PNG name (basename of `localPath`). */
	readonly fileName: string;
	/** On-disk PNG path the render wrote — the operator's local copy of the candidate. */
	readonly localPath: string;
}

/** The whole candidate set staged for one blessing session. */
export interface CandidateSet {
	/** The flag-forced preview base the candidates were rendered over. */
	readonly previewUrl: string;
	/** The viewport label every candidate was shot at. */
	readonly viewport: string;
	/**
	 * The forced flag state the preview was rendered under (flag key → on/off).
	 * Recorded as metadata for provenance — this step CONSUMES a flag-forced preview,
	 * it does not force flags (the forcing mechanism is emitted separately, #2955).
	 */
	readonly forcedFlags: Readonly<Record<string, boolean>>;
	/** The candidate screens, in founder order. */
	readonly screens: readonly CandidateScreen[];
}

/** A rendered-and-stored artifact for one surface — the impure legs' output, joined by surface-id. */
export interface RenderedCandidate {
	readonly surfaceId: string;
	readonly sha256: string;
	readonly url: string;
	readonly fileName: string;
	readonly localPath: string;
}

export interface AssembleCandidateSetInput {
	readonly previewUrl: string;
	readonly viewport: string;
	readonly forcedFlags: Readonly<Record<string, boolean>>;
	readonly surfaces: readonly ResolvedPrioritySurface[];
	readonly rendered: readonly RenderedCandidate[];
}

/**
 * Assemble the candidate set: join each resolved priority surface to its rendered
 * artifact by surface-id, preserving founder order. Fail-closed on a mismatch —
 * every priority surface must have exactly one rendered candidate and vice-versa (a
 * missing or extra render means the capture leg silently dropped/duplicated a
 * surface, which must never reach the founder as a partial gallery). Rejects a
 * non-sha256 content-address (a `.png` or URL slipped in where the stem belongs).
 */
export const assembleCandidateSet = (input: AssembleCandidateSetInput): CandidateSet => {
	const byId = new Map<string, RenderedCandidate>();
	for (const r of input.rendered) {
		if (byId.has(r.surfaceId)) {
			throw new Error(`candidate-set: duplicate rendered candidate for ${r.surfaceId}`);
		}
		byId.set(r.surfaceId, r);
	}
	if (byId.size !== input.surfaces.length) {
		throw new Error(
			`candidate-set: rendered count (${byId.size}) != priority-surface count (${input.surfaces.length}) — refusing a partial candidate set`,
		);
	}
	const screens = input.surfaces.map((surface): CandidateScreen => {
		const surfaceId = surface.surface.surface;
		const r = byId.get(surfaceId);
		if (r === undefined) {
			throw new Error(`candidate-set: no rendered candidate for priority surface ${surfaceId}`);
		}
		if (!isSha256Hex(r.sha256)) {
			throw new Error(
				`candidate-set: ${surfaceId} content-address must be a 64-hex sha256 stem (no ".png"/URL), got "${r.sha256}"`,
			);
		}
		return {
			order: surface.order,
			surfaceId,
			title: surface.title,
			intent: surface.intent,
			sha256: r.sha256,
			url: r.url,
			fileName: r.fileName,
			localPath: r.localPath,
		};
	});
	return {
		previewUrl: input.previewUrl,
		viewport: input.viewport,
		forcedFlags: input.forcedFlags,
		screens,
	};
};

/**
 * Serialize the set to the JSON the blessing surface consumes — tab-indented +
 * trailing newline, matching the repo's committed-JSON convention. Deterministic:
 * screens stay in founder order, and flag keys are sorted so the same set always
 * serializes byte-identically (a stable operator artifact / diff).
 */
export const serializeCandidateSet = (set: CandidateSet): string => {
	const forcedFlags: Record<string, boolean> = {};
	for (const key of Object.keys(set.forcedFlags).sort()) {
		forcedFlags[key] = set.forcedFlags[key] as boolean;
	}
	return `${JSON.stringify({...set, forcedFlags}, null, "\t")}\n`;
};

interface RawCandidateSet {
	readonly previewUrl?: unknown;
	readonly viewport?: unknown;
	readonly forcedFlags?: unknown;
	readonly screens?: unknown;
}

const isStringRecordOfBoolean = (value: unknown): value is Record<string, boolean> =>
	typeof value === "object" &&
	value !== null &&
	Object.values(value).every((v) => typeof v === "boolean");

/**
 * Parse + validate a serialized candidate set (the blessing surface's decode
 * boundary). Every field is checked so a malformed set fails loud here, not later as
 * a half-filled set a bless mis-reads — the `golden-fs.ts` hand-validation idiom.
 */
export const parseCandidateSet = (text: string): CandidateSet => {
	const raw = JSON.parse(text) as RawCandidateSet;
	if (typeof raw.previewUrl !== "string" || typeof raw.viewport !== "string") {
		throw new Error("candidate-set: malformed set (needs string previewUrl/viewport)");
	}
	if (!isStringRecordOfBoolean(raw.forcedFlags)) {
		throw new Error("candidate-set: malformed forcedFlags (needs a {string: boolean} map)");
	}
	if (!Array.isArray(raw.screens)) {
		throw new Error("candidate-set: malformed set (screens must be an array)");
	}
	const screens = raw.screens.map((entry, index): CandidateScreen => {
		const s = entry as Partial<CandidateScreen>;
		if (
			typeof s.order !== "number" ||
			typeof s.surfaceId !== "string" ||
			typeof s.title !== "string" ||
			typeof s.intent !== "string" ||
			typeof s.sha256 !== "string" ||
			typeof s.url !== "string" ||
			typeof s.fileName !== "string" ||
			typeof s.localPath !== "string"
		) {
			throw new Error(`candidate-set: screen[${index}] is malformed`);
		}
		if (!isSha256Hex(s.sha256)) {
			throw new Error(`candidate-set: screen[${index}] sha256 is not a 64-hex stem: "${s.sha256}"`);
		}
		return {
			order: s.order,
			surfaceId: s.surfaceId,
			title: s.title,
			intent: s.intent,
			sha256: s.sha256,
			url: s.url,
			fileName: s.fileName,
			localPath: s.localPath,
		};
	});
	return {
		previewUrl: raw.previewUrl,
		viewport: raw.viewport,
		forcedFlags: raw.forcedFlags,
		screens,
	};
};
