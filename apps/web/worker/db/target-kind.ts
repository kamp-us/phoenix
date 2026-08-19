/**
 * The closed set of entities a vote or a report can target. It lives in `db/` — below
 * both feature directories — because the boundary pins forbid a `vote/`↔`report/` edge
 * while both features and the schema share this one set.
 */
import * as Schema from "effect/Schema";

/** The one runtime tuple the `*.target_kind` D1 enums source from, so no column can drift. */
export const TARGET_KINDS = ["definition", "post", "comment"] as const;

export type TargetKind = (typeof TARGET_KINDS)[number];

export const TargetKindSchema = Schema.Literals(TARGET_KINDS);

/**
 * The `<kind>:<id>` join key used across the vote/report/divan surfaces. One codec, so a
 * format change propagates instead of drifting per feature. `id` may itself contain `:`,
 * so {@link parseTargetKey} splits on the FIRST separator only.
 */
export const targetKey = (kind: TargetKind, id: string): string => `${kind}:${id}`;

/**
 * The inverse of {@link targetKey}; `null` on a malformed key or unknown kind. Callers
 * must treat `null` as unresolvable — the divan collapses it to the invisible `Denied`,
 * keeping a hand-crafted request opaque.
 */
export const parseTargetKey = (key: string): {kind: TargetKind; id: string} | null => {
	const sep = key.indexOf(":");
	if (sep <= 0 || sep === key.length - 1) return null;
	const kind = key.slice(0, sep);
	if (!(TARGET_KINDS as ReadonlyArray<string>).includes(kind)) return null;
	return {kind: kind as TargetKind, id: key.slice(sep + 1)};
};
