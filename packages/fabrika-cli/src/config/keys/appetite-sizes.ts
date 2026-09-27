/**
 * `appetiteSizes` — what each pitch size is worth in dollars, per epic child.
 *
 * A pitch declares its appetite as a size, `S`, `M` or `L`, and the size is the spending limit: no
 * column on the table holds a separate number. This key says what each size means in this repo, so
 * the limit a founder approved reads the same way everywhere it is shown.
 *
 * **The shipped default is S = $15, M = $35, L = $40**, the amounts the founder ruled. A declared
 * value names all three sizes, each a positive number of dollars, strictly rising from `S` to `L`.
 * A missing size, an extra key, or two sizes that cost the same refuse the whole value at load: a
 * size table that does not order its sizes is one where `L` can be the smaller bet.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/9821
 */

import type {Decoded, KeyGroup} from "../key-group.ts";

export const APPETITE_SIZES = "appetiteSizes";

/** The pitch sizes, smallest first. The order is the meaning: each is a bigger bet than the last. */
export const SIZES = ["S", "M", "L"] as const;
export type Size = (typeof SIZES)[number];

export type AppetiteSizes = Readonly<Record<Size, number>>;

export const SHIPPED_APPETITE_SIZES: AppetiteSizes = {S: 15, M: 35, L: 40};

const malformed = (why: string): Decoded<AppetiteSizes> => ({
	_tag: "Malformed",
	reason: `\`${APPETITE_SIZES}\` ${why} — write {"S": <dollars>, "M": <dollars>, "L": <dollars>}, each a positive number, rising from S to L`,
});

const decode = (raw: unknown): Decoded<AppetiteSizes> => {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return malformed("is not an object");
	}
	const record = raw as Record<string, unknown>;
	const extra = Object.keys(record).filter(
		(key) => !(SIZES as ReadonlyArray<string>).includes(key),
	);
	if (extra.length > 0) return malformed(`names ${extra.join(", ")}, which is not a size`);
	const amounts: Array<number> = [];
	for (const size of SIZES) {
		const amount = record[size];
		if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
			return malformed(`gives size ${size} no positive dollar amount`);
		}
		amounts.push(amount);
	}
	if (amounts.some((amount, index) => index > 0 && amount <= (amounts[index - 1] ?? 0))) {
		return malformed("does not rise from S to L");
	}
	const [S, M, L] = amounts as [number, number, number];
	return {_tag: "Value", value: {S, M, L}};
};

/** `S = $15, M = $35, L = $40` — how a report names the sizes a pitch may declare. */
export const describeSizes = (sizes: AppetiteSizes): string =>
	SIZES.map((size) => `${size} = $${sizes[size]}`).join(", ");

const amountSchema = (size: Size) => ({
	type: "number" as const,
	exclusiveMinimum: 0,
	description: `Dollars a size-${size} pitch may spend per epic child.`,
});

export const appetiteSizesKey: KeyGroup<AppetiteSizes> = {
	key: APPETITE_SIZES,
	shippedDefault: SHIPPED_APPETITE_SIZES,
	decode,
	jsonSchema: {
		type: "object",
		description:
			"What each pitch size (`**Appetite:** S`, `M` or `L`) is worth in dollars per epic child. The size is the spending limit a pitch approval binds. Name all three, each positive and rising from S to L. Shipped default: S = 15, M = 35, L = 40.",
		properties: {S: amountSchema("S"), M: amountSchema("M"), L: amountSchema("L")},
		required: [...SIZES],
		additionalProperties: false,
	},
};
