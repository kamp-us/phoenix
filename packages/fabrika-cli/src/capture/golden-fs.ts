/**
 * The filesystem boundary for the golden pointer file — the only golden module
 * that touches disk, keeping `golden-pointer.ts` pure. The committed file is a
 * `{ "surfaces": { "<surface-id>": { sha256, blessedDate, intent } } }` JSON blob;
 * a re-bless is a one-line edit to it (the migrations-guard `migration-hashes.json`
 * shape, ADR 0108 / 0183 §4).
 */
import {readFileSync} from "node:fs";
import type {GoldenEntry, GoldenPointer} from "./golden-pointer.ts";

interface RawPointerFile {
	readonly surfaces?: Readonly<Record<string, Partial<GoldenEntry>>>;
}

/**
 * Read the committed pointer; a missing file is an empty pointer (the pre-bless
 * state — every surface then resolves to `null` until it is first blessed). Each
 * entry is validated so a malformed committed file fails loud, not silently as a
 * half-filled pointer a resolve would then mis-read.
 */
export const loadGoldenPointer = (pointerPath: string): GoldenPointer => {
	let text: string;
	try {
		text = readFileSync(pointerPath, "utf8");
	} catch {
		return {};
	}
	const raw = JSON.parse(text) as RawPointerFile;
	const surfaces = raw.surfaces ?? {};
	const pointer: Record<string, GoldenEntry> = {};
	for (const [surfaceId, entry] of Object.entries(surfaces)) {
		if (
			typeof entry.sha256 !== "string" ||
			typeof entry.blessedDate !== "string" ||
			typeof entry.intent !== "string"
		) {
			throw new Error(
				`golden-fs: pointer entry for "${surfaceId}" is malformed (needs string sha256/blessedDate/intent)`,
			);
		}
		pointer[surfaceId] = {
			sha256: entry.sha256,
			blessedDate: entry.blessedDate,
			intent: entry.intent,
		};
	}
	return pointer;
};

/**
 * Serialize the pointer with surface-ids in sorted order so a re-bless yields a
 * stable, minimal, reviewable diff (only the moved line changes). Tab-indented +
 * trailing newline to match the repo's committed-JSON convention.
 */
export const serializeGoldenPointer = (pointer: GoldenPointer): string => {
	const sorted: Record<string, GoldenEntry> = {};
	for (const surfaceId of Object.keys(pointer).sort()) {
		sorted[surfaceId] = pointer[surfaceId] as GoldenEntry;
	}
	return `${JSON.stringify({surfaces: sorted}, null, "\t")}\n`;
};
