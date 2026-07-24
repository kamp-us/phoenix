/**
 * `gh-phoenix` lint core — the pure, IO-free matchers that gate the skill
 * corpus. Two independent checks, both fail-closed on zero scope (ADR 0092):
 *
 *  1. GraphQL-path `gh` invocations (issue #743) — flags a reflexive `gh project`
 *     / GraphQL `gh pr edit` / `gh api graphql`, enforcing "REST only on this org"
 *     mechanically instead of by memory.
 *  2. Frontmatter YAML validity (issue #1766) — parses each SKILL.md / agent .md
 *     `---`-fenced frontmatter block as strict YAML and flags any that does not
 *     parse. This is the durable gate for the recurring defect where an unquoted
 *     `description:` whose prose carries a mid-sentence colon-space (`ritual:
 *     pre-flight`) reparses as a nested mapping and breaks GitHub's renderer
 *     (#1281 shipper.md ×2, #1769 release/SKILL.md) — the tolerant harness loader
 *     accepts it, strict parsers reject it, so it shipped uncaught ≥3×.
 *
 * Fails CLOSED on zero scope (ADR 0092): `lintCorpus` returns the set of files
 * scanned alongside the findings, and `isZeroScope` reports when nothing was
 * scanned — the CI/bin layer turns that into a FAIL, never a silent PASS. A lint
 * that scanned no files is a broken lint, not a clean one.
 *
 * The IO (reading the skill files) is done by the caller and the contents are
 * handed in, keeping this core pure and unit-testable. The gh-call match is
 * line-scoped; each finding carries the file, the 1-based line number, the matched
 * text, and a reason, so the report points at the exact offending line.
 */
import {parseDocument} from "yaml";

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

/** A file whose `---`-fenced frontmatter block did not parse as strict YAML (#1766). */
export interface FrontmatterFinding {
	readonly file: string;
	/** The strict-YAML parse error(s) — GitHub's renderer fails the same way. */
	readonly reason: string;
}

export interface LintResult {
	readonly findings: ReadonlyArray<Finding>;
	/** Files whose frontmatter block failed to parse as strict YAML (#1766). */
	readonly frontmatterFindings: ReadonlyArray<FrontmatterFinding>;
	/** Every file path the gh-call scan looked at — its scope (ADR 0092). */
	readonly scanned: ReadonlyArray<string>;
	/** Every file path the frontmatter check looked at — its scope (ADR 0092). */
	readonly frontmatterScanned: ReadonlyArray<string>;
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
	"/packages/pipeline-cli/src/tools/gh-phoenix/README.md",
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
 * The frontmatter check's scope: skill definitions (`.../SKILL.md`) and agent
 * definitions (`.../agents/<name>.md`) — the files that carry a `---`-fenced
 * frontmatter block a strict consumer (GitHub's renderer, a stricter loader)
 * parses. Unlike the gh-call scan, this is NOT narrowed by `isSelfExempt`: the
 * self-exempt skills (write-code, ship-it, …) are real skills whose frontmatter
 * must still be valid YAML — exempting them from the gh-grep never meant
 * exempting them from having parseable frontmatter (#1766).
 */
export const isFrontmatterScoped = (path: string): boolean => {
	const p = normalize(path);
	return p.endsWith("/SKILL.md") || /\/agents\/[^/]+\.md$/.test(p);
};

/**
 * The strict-YAML frontmatter check for one file. Returns a finding iff the file
 * is in frontmatter scope AND its `---`-fenced block does not parse as strict
 * YAML. A file with no frontmatter fence at all is NOT a finding here — this gate
 * is about invalid frontmatter, not missing frontmatter (a distinct concern). The
 * parse uses `yaml`'s `parseDocument({strict:true})` and collects `doc.errors`,
 * the same failure GitHub's renderer surfaces (`mapping values are not allowed` /
 * `Nested mappings are not allowed in compact mappings`), so a green gate means
 * GitHub will render the frontmatter.
 */
export const checkFrontmatter = (file: string, content: string): FrontmatterFinding | null => {
	if (!isFrontmatterScoped(file)) return null;
	// A leading `---` fence, its body, and a closing `---` on its own line. No fence ⇒ no
	// frontmatter to validate (not this gate's concern).
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (match === null) return null;
	const block = match[1] ?? "";
	const doc = parseDocument(block, {strict: true});
	if (doc.errors.length === 0) return null;
	const reason = doc.errors.map((e) => e.message.split("\n")[0]).join("; ");
	return {file, reason};
};

/**
 * Scan the whole handed-in corpus. Runs BOTH checks and returns their findings
 * and their (independent) scopes. The caller pairs this with `isZeroScope` to
 * fail closed when EITHER scope is empty (ADR 0092).
 */
export const lintCorpus = (files: ReadonlyArray<ScanFile>): LintResult => {
	const scanned: string[] = [];
	const findings: Finding[] = [];
	const frontmatterScanned: string[] = [];
	const frontmatterFindings: FrontmatterFinding[] = [];
	for (const {file, content} of files) {
		if (isFrontmatterScoped(file)) {
			frontmatterScanned.push(file);
			const fm = checkFrontmatter(file, content);
			if (fm !== null) frontmatterFindings.push(fm);
		}
		if (isSelfExempt(file)) continue;
		scanned.push(file);
		findings.push(...scanFile(file, content));
	}
	return {findings, frontmatterFindings, scanned, frontmatterScanned};
};

/**
 * Zero-scope test (ADR 0092): true when EITHER check scanned NO files. A
 * zero-scope run is a FAIL, never a silent PASS — a lint that looked at nothing
 * protects nothing. The caller maps `true` → non-zero exit. Both scopes must be
 * non-empty: a corpus with no frontmatter-bearing file is as broken a scope for
 * the frontmatter gate as an empty gh-call scope is for the grep.
 */
export const isZeroScope = (result: LintResult): boolean =>
	result.scanned.length === 0 || result.frontmatterScanned.length === 0;
