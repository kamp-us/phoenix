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
