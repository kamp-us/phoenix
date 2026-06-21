/**
 * `@kampus/gh-phoenix` lint core — the pure, IO-free matcher that flags
 * GraphQL-path / Projects-classic `gh` invocations in the skill corpus (issue
 * #743). It enforces the "REST only on this org" convention mechanically instead
 * of by memory, so a reflexive `gh project` / GraphQL `gh pr edit` written into a
 * skill is caught at lint time.
 *
 * Fails CLOSED on zero scope (ADR 0092): `lintCorpus` returns the set of files
 * scanned alongside the findings, and `isZeroScope` reports when nothing was
 * scanned — the CI/bin layer turns that into a FAIL, never a silent PASS. A lint
 * that scanned no files is a broken lint, not a clean one.
 *
 * The IO (reading the skill files) is done by the caller and the contents are
 * handed in, keeping this core pure and unit-testable. The match is line-scoped:
 * each finding carries the file, the 1-based line number, the matched text, and
 * a reason, so the report points at the exact offending line.
 */

export interface Finding {
	readonly file: string;
	/** 1-based line number of the offending line. */
	readonly line: number;
	/** The exact substring that matched a GraphQL-path pattern. */
	readonly matched: string;
	/** Why this line is flagged — the report line for this finding. */
	readonly reason: string;
}

export interface ScanFile {
	readonly file: string;
	readonly content: string;
}

export interface LintResult {
	readonly findings: ReadonlyArray<Finding>;
	/** Every file path actually scanned — the scope this run looked at (ADR 0092). */
	readonly scanned: ReadonlyArray<string>;
}

interface LintPattern {
	readonly pattern: RegExp;
	readonly reason: string;
}

/**
 * The GraphQL-path / Projects-classic `gh` invocations that break on this org.
 * Each `g` flag drives the per-line `matchAll` scan. Scoped to `gh`-prefixed
 * commands and the explicit GraphQL surfaces so prose mentioning the words in
 * passing isn't flagged (the patterns require the `gh` verb or `gh api graphql`).
 */
const LINT_PATTERNS: ReadonlyArray<LintPattern> = [
	{
		// `gh project ...` — the classic-Projects noun, GraphQL-backed, no REST surface.
		pattern: /\bgh\s+project\b/g,
		reason: "`gh project` is GraphQL/Projects-classic — use the REST issues/labels API",
	},
	{
		// `gh pr edit` / `gh issue edit` — porcelain that hits the GraphQL mutation path.
		pattern: /\bgh\s+(?:pr|issue)\s+edit\b/g,
		reason: "`gh pr/issue edit` hits the GraphQL edit path — use `gh api -X PATCH repos/...`",
	},
	{
		// `gh api graphql` — explicit GraphQL transport, breaks on Projects-classic.
		pattern: /\bgh\s+api\s+graphql\b/g,
		reason: "`gh api graphql` is the GraphQL transport — use `gh api repos/...` REST",
	},
];

/**
 * A skill file may legitimately NAME these patterns — the convention doc itself,
 * the wrapper's own corpus, and skills that explain the REST-only rule. Such
 * files are self-exempt by suffix so the lint doesn't flag the very text that
 * documents what it forbids. Mirrors leak-guard's DOC_SELF_EXEMPT design.
 */
const SELF_EXEMPT_SUFFIXES = [
	"/skills/write-code/SKILL.md",
	"/skills/review-code/SKILL.md",
	"/skills/ship-it/SKILL.md",
	"/skills/gh-issue-intake-formats.md",
	"/packages/gh-phoenix/README.md",
] as const;

const normalize = (path: string): string => `/${path.replace(/\\/g, "/").replace(/^\/+/, "")}`;

export const isSelfExempt = (path: string): boolean => {
	const p = normalize(path);
	return SELF_EXEMPT_SUFFIXES.some((s) => p.endsWith(s));
};

/** Every GraphQL-path `gh` finding in one file's text (line-scoped). */
export const scanFile = (file: string, content: string): ReadonlyArray<Finding> => {
	if (isSelfExempt(file)) return [];
	const findings: Finding[] = [];
	const lines = content.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const lineText = lines[i] ?? "";
		for (const {pattern, reason} of LINT_PATTERNS) {
			// Reset lastIndex per line — these are `g`-flagged shared RegExp instances.
			pattern.lastIndex = 0;
			for (const match of lineText.matchAll(pattern)) {
				findings.push({file, line: i + 1, matched: match[0], reason});
			}
		}
	}
	return findings;
};

/**
 * Scan the whole handed-in corpus. Returns both the findings and the scope (the
 * non-exempt files actually scanned). The caller pairs this with `isZeroScope`
 * to fail closed when scope is empty (ADR 0092).
 */
export const lintCorpus = (files: ReadonlyArray<ScanFile>): LintResult => {
	const scanned: string[] = [];
	const findings: Finding[] = [];
	for (const {file, content} of files) {
		if (isSelfExempt(file)) continue;
		scanned.push(file);
		findings.push(...scanFile(file, content));
	}
	return {findings, scanned};
};

/**
 * Zero-scope test (ADR 0092): true when the lint scanned NO files. A zero-scope
 * run is a FAIL, never a silent PASS — a lint that looked at nothing protects
 * nothing. The caller maps `true` → non-zero exit.
 */
export const isZeroScope = (result: LintResult): boolean => result.scanned.length === 0;
