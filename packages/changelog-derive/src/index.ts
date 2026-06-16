/**
 * `@kampus/changelog-derive` — the derived-changelog projection decided in ADR 0069
 * (issue #394). The core (`deriveChangelog` and friends) is a pure, IO-free transform
 * from shipped-work entries (closed-issue title + triaged `type:*` label + merged-PR
 * backlink) to a Keep a Changelog body; `bin.ts` wires it to an `effect/unstable/cli`
 * surface that reads a gathered entries JSON and emits/writes `CHANGELOG.md`. The
 * git-log range selection + `gh` gathering lives at the workflow boundary (the
 * `.github/workflows/` release step), never as entry text.
 */
export {
	CATEGORY_ORDER,
	type Category,
	type CategoryGroup,
	type ChangelogEntry,
	categoryFor,
	deriveChangelog,
	groupByType,
	type ReleaseMeta,
	renderSection,
	TYPE_CATEGORY,
} from "./changelog.ts";
