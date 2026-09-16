/**
 * Payload fit: the one comparison that decides whether two ports carry the same thing, and the
 * localiser that says where two that do not first part company.
 *
 * It lives beside the program row rather than in `../authoring/` because two slices ask it now and
 * both must get the same answer. `../authoring/shape.ts` asks it of a program-valued arg's declared
 * shape against the row a config filled it with (#8887), and `../ports/compile.ts` asks it of a
 * graph route's two ends (ADR 0395, #8923). One relation, one meaning of "fit" — a route that
 * compiled and a shaped arg that filled would otherwise be two different promises with the same
 * name (#8716 R13.1).
 *
 * **Fit is exact structural equality over the canonical JSON Schema, and nothing looser.** No
 * version is read, no field is optional-by-tolerance, and a payload carrying more than the other
 * end declared does not fit it. That is what `payloadFits` has always meant for a shape, and
 * widening it for routes alone would have introduced a second compatibility relation that no
 * module owns.
 */

import {Schema} from "effect";
import type {PortPayloadSchema} from "./program.ts";

/**
 * The generator's default reference policy is `({identifier}) => identifier`, which emits any schema
 * carrying an `identifier` annotation as a `$ref` into `$defs` keyed by that name — so the name its
 * package chose would land in the compared string and two identical payloads named differently would
 * not fit. Naming a schema is the ordinary Effect idiom, so that is the common case, not the rare
 * one. Returning `undefined` inlines every named schema instead. A recursive payload still needs a
 * `$def` to point at and gets a synthetic name derived from its own structure, not from the author's
 * annotation, so two recursive payloads of the same shape still compare equal.
 */
const inlineNames = {referencePolicy: () => undefined} as const;

/**
 * `required` is a set, so the order the author declared their struct's fields in is not part of the
 * payload. Every other array in a JSON Schema is positional (`prefixItems`, `anyOf` branches), and
 * sorting one of those would call two different payloads the same.
 */
const unordered = (key: string, value: unknown): unknown =>
	key === "required" && Array.isArray(value) ? [...(value as ReadonlyArray<string>)].sort() : value;

const stable = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const keys = Object.keys(value as Record<string, unknown>).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(unordered(key, (value as Record<string, unknown>)[key]))}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

/**
 * A schema's payload as a comparable string: its JSON Schema, with every object's keys sorted, so
 * two structurally identical payloads compare equal however their authors ordered the fields.
 */
const canonical = (schema: PortPayloadSchema): string =>
	stable(Schema.toJsonSchemaDocument(schema, inlineNames));

/**
 * Do two ports carry the same payload? Structural, over the schemas — no version is read. This is
 * the single owner of the decision; everything below only describes an answer it already gave.
 */
export const payloadFits = (declared: PortPayloadSchema, offered: PortPayloadSchema): boolean =>
	canonical(declared) === canonical(offered);

/**
 * Where two payloads that do not fit first differ: a path into the JSON Schema and a short
 * rendering of each side there. A refusal that only said "does not fit" would leave the author
 * diffing two generated schema documents by eye, which is the thing this exists to spare them.
 */
export interface PayloadDifference {
	/** JSON-Schema path from the payload root, `""` for the root itself. */
	readonly path: string;
	readonly declared: string;
	readonly offered: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** An object as its key set, a scalar as itself: enough to see which side to change, and no more. */
const render = (value: unknown): string => {
	if (isRecord(value)) return `{${Object.keys(value).sort().join(", ")}}`;
	if (Array.isArray(value)) return `[${value.map(render).join(", ")}]`;
	return JSON.stringify(value) ?? "null";
};

const at = (path: string, key: string): string => `${path}.${key}`;

const firstDifference = (
	path: string,
	declared: unknown,
	offered: unknown,
): PayloadDifference | undefined => {
	if (stable(declared) === stable(offered)) return undefined;
	if (isRecord(declared) && isRecord(offered)) {
		const declaredKeys = Object.keys(declared).sort();
		const offeredKeys = Object.keys(offered).sort();
		// A differing key set is the difference, reported here rather than descending into a key one
		// side does not have: "source has {items, ok, text}, target has {text}" is the actionable line.
		if (declaredKeys.join(",") !== offeredKeys.join(",")) {
			return {path, declared: render(declared), offered: render(offered)};
		}
		for (const key of declaredKeys) {
			const found = firstDifference(
				at(path, key),
				unordered(key, declared[key]),
				unordered(key, offered[key]),
			);
			if (found !== undefined) return found;
		}
	}
	if (Array.isArray(declared) && Array.isArray(offered) && declared.length === offered.length) {
		for (const [index, element] of declared.entries()) {
			const found = firstDifference(at(path, String(index)), element, offered[index]);
			if (found !== undefined) return found;
		}
	}
	return {path, declared: render(declared), offered: render(offered)};
};

/**
 * The first place two payloads part company, or `undefined` when they fit. `payloadFits` is what
 * decides; this only localises an answer it gave, so the two can never disagree about whether a
 * payload fits — at worst this points at the root.
 */
export const payloadDifference = (
	declared: PortPayloadSchema,
	offered: PortPayloadSchema,
): PayloadDifference | undefined =>
	payloadFits(declared, offered)
		? undefined
		: firstDifference(
				"",
				Schema.toJsonSchemaDocument(declared, inlineNames),
				Schema.toJsonSchemaDocument(offered, inlineNames),
			);

/** The difference as one clause, with the two ends named the way the caller calls them. */
export const describeDifference = (
	difference: PayloadDifference,
	declaredEnd: string,
	offeredEnd: string,
): string =>
	`at ${difference.path === "" ? "the payload root" : difference.path}, ${declaredEnd} carries ${difference.declared} where ${offeredEnd} accepts ${difference.offered}`;
