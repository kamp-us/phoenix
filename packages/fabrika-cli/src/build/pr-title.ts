/**
 * The pure read `build pr` makes over the served issue's title before it becomes the PR title.
 *
 * The incident this module answers is #5771: the repo squash-merges with
 * `squash_merge_commit_title: COMMIT_OR_PR_TITLE`, so on a multi-commit PR the PR title becomes the
 * commit subject on `main` — and release-please cannot route a subject with no conventional prefix,
 * so the change lands with no version bump and no changelog line. Issue titles are descriptive
 * sentences; the prefix is derived here, from the served issue's `type:` label, so every builder PR
 * squashes to a subject release-please can parse.
 *
 * The second incident is #5946: a subject carrying a literal `<details>` lands in the Release PR
 * body's changelog, and release-please parses that body as HTML — a stray tag with no `<summary>`
 * crashes every later run. Angle brackets are stripped here for the same reason the prefix is added
 * here: this is the one place an issue title becomes a commit subject.
 */

/** `type:<label>` → conventional-commit type. Anything unlisted falls back to `chore`. */
const PREFIX_BY_LABEL: ReadonlyMap<string, string> = new Map([
	["type:bug", "fix"],
	["type:feature", "feat"],
]);

/**
 * A subject that already leads with a conventional-commit prefix — `type(scope)!: rest` — which the
 * derivation must leave alone rather than double-prefix. The type set is open (any word) on purpose:
 * a hand-titled `docs:` or `perf:` issue is already routable, and `fix: docs: …` helps nobody.
 */
const CONVENTIONAL_SUBJECT = /^[a-z]+(\([^()]*\))?!?: \S/;

/**
 * An HTML-looking tag — `<name …>` or `</name>`. The shape mirrors what an HTML parser reads as an
 * element (`<` then a letter), which is exactly the set that poisons the Release PR body; a `<` that
 * no parser opens a tag on, like `a < b`, is left alone.
 */
const HTML_TAG = /<\/?([A-Za-z][^<>]*)>/g;

/** The tag's own text, minus the brackets that make it a tag: `` `<details>` `` → `` `details` ``. */
const withoutTagBrackets = (text: string): string => text.replace(HTML_TAG, "$1");

/** The served issue's title as a conventional-commit PR title. Pure; the one derivation site. */
export const conventionalTitleOf = (title: string, labels: ReadonlyArray<string>): string => {
	const trimmed = withoutTagBrackets(title.trim());
	if (CONVENTIONAL_SUBJECT.test(trimmed)) return trimmed;
	const type = labels.map((label) => PREFIX_BY_LABEL.get(label)).find((t) => t !== undefined);
	return `${type ?? "chore"}: ${trimmed}`;
};
