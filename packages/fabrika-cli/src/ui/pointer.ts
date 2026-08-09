/**
 * The golden pointer as `ui golden` reads it: `{"store": "<base URL>", "surfaces": {"<id>":
 * {"sha256": "<hex>"}}}`, the bytes resolving as `GET <store>/<sha256>.png`.
 *
 * An unreadable pointer is **never** an empty blessed set. v1's probe resolved a failed read to zero
 * blessed surfaces with `|| true` (#4501), which reads to a caller as "nothing to compare against"
 * — the fail-open this parser and its `4`/`11` seats exist to refuse.
 *
 * Entry fields beyond `sha256` (phoenix's shipped file carries `blessedDate` and `intent`, ADR 0183
 * §2) are carried by the repo, not by this contract, so they parse and are ignored rather than
 * refused. A pointer that names surfaces without a `store` is malformed: the bytes are unreachable,
 * and answering "blessed" for a golden nothing can fetch would be worse than refusing.
 */
import {isSha256Hex} from "../capture/golden-pointer.ts";

export interface UiGoldenPointer {
	readonly store: string | null;
	readonly surfaces: Readonly<Record<string, string>>;
}

export type PointerParse =
	| {readonly _tag: "Pointer"; readonly pointer: UiGoldenPointer}
	| {readonly _tag: "Violation"; readonly violation: string};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export const parsePointer = (text: string): PointerParse => {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		return {_tag: "Violation", violation: `the file is not JSON (${(err as Error).message})`};
	}
	if (!isRecord(parsed)) return {_tag: "Violation", violation: "the top level is not an object"};
	const rawSurfaces = parsed.surfaces ?? {};
	if (!isRecord(rawSurfaces)) return {_tag: "Violation", violation: '"surfaces" is not an object'};
	const surfaces: Record<string, string> = {};
	for (const [id, entry] of Object.entries(rawSurfaces)) {
		if (!isRecord(entry) || typeof entry.sha256 !== "string") {
			return {_tag: "Violation", violation: `surfaces["${id}"] carries no string sha256`};
		}
		if (!isSha256Hex(entry.sha256)) {
			return {
				_tag: "Violation",
				violation: `surfaces["${id}"].sha256 is not a 64-hex content address`,
			};
		}
		surfaces[id] = entry.sha256;
	}
	const store = parsed.store;
	if (store !== undefined && typeof store !== "string") {
		return {_tag: "Violation", violation: '"store" is not a string'};
	}
	if (store === undefined && Object.keys(surfaces).length > 0) {
		return {
			_tag: "Violation",
			violation: 'it names surfaces but carries no "store" — the blessed bytes are unreachable',
		};
	}
	return {
		_tag: "Pointer",
		pointer: {store: store === undefined ? null : store.replace(/\/+$/, ""), surfaces},
	};
};

/** The immutable URL a surface's blessed bytes resolve at. */
export const goldenUrl = (store: string, sha256: string): string => `${store}/${sha256}.png`;
