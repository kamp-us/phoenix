/**
 * The vote/report **target kind** — the closed set of entities a vote or a
 * report can target (`definition` | `post` | `comment`). One typed source for a
 * taxonomy that spans the vote engine, the report engine, and two D1 columns.
 *
 * Lives in `db/` — below both feature directories — because the `vote/`↔`report/`
 * boundary pins forbid a sibling-feature edge, yet both features and the schema
 * share this one set. `TARGET_KINDS` is the one runtime tuple the
 * `user_vote.target_kind` / `content_report.target_kind` D1 enums source from
 * (so a column can't drift from the union), exactly as `REPORT_STATUSES` /
 * `RESOLUTIONS` anchor `content_report.status` / `.resolution`. A typo
 * (`"defintion"`) can no longer compile and write a corrupt PK.
 */
import * as Schema from "effect/Schema";

/** The closed target set, as the one runtime tuple the D1 enums source from. */
export const TARGET_KINDS = ["definition", "post", "comment"] as const;

export type TargetKind = (typeof TARGET_KINDS)[number];

/** The one wire/decode schema for `targetKind` — sourced from {@link TARGET_KINDS}. */
export const TargetKindSchema = Schema.Literals(TARGET_KINDS);

/**
 * The `<kind>:<id>` composite target key — the load-bearing join key across the
 * vote/report/divan surfaces (a fate view `id`, a merge-map key, a fabricated
 * fallback report id). One codec so every site encodes and decodes the same
 * spelling: a change to the format propagates instead of drifting per feature.
 *
 * `id` may itself contain `:` (a domain row id is opaque), so decode splits on the
 * FIRST separator only — `parseTargetKey(targetKey(k, id)) === {kind: k, id}` for
 * every `TargetKind` and every non-empty `id`.
 */
export const targetKey = (kind: TargetKind, id: string): string => `${kind}:${id}`;

/**
 * Split a `<kind>:<id>` key back into its target, or `null` if malformed (no
 * separator, empty kind, or empty id) or the kind is not a {@link TargetKind}. The
 * inverse of {@link targetKey} for a well-formed key. A `null` is an unresolvable
 * target — e.g. the divan collapses it to the invisible `Denied`, keeping a
 * hand-crafted request opaque.
 */
export const parseTargetKey = (key: string): {kind: TargetKind; id: string} | null => {
	const sep = key.indexOf(":");
	if (sep <= 0 || sep === key.length - 1) return null;
	const kind = key.slice(0, sep);
	if (!(TARGET_KINDS as ReadonlyArray<string>).includes(kind)) return null;
	return {kind: kind as TargetKind, id: key.slice(sep + 1)};
};
