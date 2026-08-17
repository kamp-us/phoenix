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
 *  3. Bare `git push` in an executable block (issue #4213) — flags any `git … push`
 *     inside a runnable shell block in the corpus, because a bare push cannot report
 *     whether the ref landed: `| tail` eats its exit status (`pipefail` is off here)
 *     and a detached run's output file carries no status at all, so a dead push reads
 *     as a clean one. `pipeline-cli verified-push` is the sanctioned path; this check
 *     is what makes that mechanical rather than attention-based (ADR 0202).
 *  4. Non-portable plugin path literal in a fence (issue #4605) — flags a repo-relative
 *     `./claude-plugins/…` path inside a fenced block. That literal resolves only inside
 *     a phoenix checkout; a marketplace consumer's install lives in their plugin cache,
 *     outside their repo, so the same fence is `No such file or directory` there. This is
 *     the guard that would have caught the live customer-down break, and it exists because
 *     nothing asserted the consumer's case (only the in-repo one).
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
	/** Executable `git push` invocations in the corpus (#4213). */
	readonly barePushFindings: ReadonlyArray<Finding>;
	/** Non-portable `./claude-plugins/…` path literals inside fenced blocks (#4605). */
	readonly portabilityFindings: ReadonlyArray<Finding>;
	/** Every file path the gh-call scan looked at — its scope (ADR 0092). */
	readonly scanned: ReadonlyArray<string>;
	/** Every file path the frontmatter check looked at — its scope (ADR 0092). */
	readonly frontmatterScanned: ReadonlyArray<string>;
	/** Every file path the bare-push scan looked at — its scope (ADR 0092). */
	readonly barePushScanned: ReadonlyArray<string>;
	/** Every file path the fence-portability scan looked at — its scope (ADR 0092). */
	readonly portabilityScanned: ReadonlyArray<string>;
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
	// The two halves of ship-it/SKILL.md that #4448 moved into sourced scripts, and the only two
	// that carry a named pattern: Step 3.6's ADR-0158 §Decision-2 sanctioned GraphQL read, and Step
	// 3z's comment FORBIDDING `gh pr edit` next to the REST close/reopen it mandates instead. Both
	// were already exempt as part of the markdown, so this continues one file's exemption at the
	// same whole-file granularity — deliberately NOT a `scripts/` directory-wide exemption, which
	// would silently exempt every future extracted script from a live lint.
	"/skills/ship-it/scripts/step3_6-threads-read.sh",
	"/skills/ship-it/scripts/step3z-dropped-trigger.sh",
	// review-code's half of the same ADR-0158 sanctioned read, extracted by #4451. Same per-script
	// granularity, same reason.
	"/skills/review-code/scripts/unresolved-threads-read.sh",
	// Same class, same granularity: #4404 moved write-code/SKILL.md's repair mode into repair.md,
	// carrying the line that FORBIDS `gh pr edit` next to the REST PATCH it mandates instead. The
	// text is byte-identical to its pre-move address — only the file changed, so its exemption
	// follows it, still per-file and never a `write-code/`-wide exemption.
	"/skills/write-code/repair.md",
	"/skills/gh-issue-intake-formats.md",
	"/packages/pipeline-cli/src/tools/gh-phoenix/README.md",
	// The one finding the #5004 widening surfaced, and it is prose, not a call: the passage
	// names `gh issue edit --add-label` to explain why an implementer must NOT reach for it
	// (that porcelain rejects an unknown label client-side, which would make the contract's
	// vocabulary precondition look redundant and invite dropping it — after which the REST
	// call starts minting labels). Naming the forbidden form is the explanation, so the file
	// is exempt at whole-file granularity, plugin-qualified — never a `fabrika/`- or
	// `skills/`-wide exemption, which would silently drop future files from a live lint.
	"/fabrika/skills/triage/contract.md",
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
 * A `git push` invocation, allowing the option forms that appear at real push sites —
 * `git -C "$WT" push`, `git --git-dir=… push`, `git -c foo=bar push`. Anchored on the `git`
 * verb so prose that merely says "push" is never matched.
 *
 * The two alternatives inside the `*` are deliberately DISJOINT, and keeping them so is a
 * security property of this line, not a style choice: this is the enforcement mechanism the
 * whole check rests on, `skill-gh-lint.yml` runs it on every `pull_request`, and a hung job
 * presents as *running* rather than failed — so a backtrackable pattern here is a wedge any
 * crafted corpus line can pull. Two alternatives that can both consume the same token give
 * k ways to split each of n tokens, i.e. exponential backtracking on input that never reaches
 * `push` (CodeQL `js/redos`, #4217). Concretely, both of these were exponential and are gone:
 *   - `--\S+=\S+\s+` alongside `-\S+\s+` — subsumed, and `\S+=\S+` re-split at every `=`
 *     (165 chars → 75 s);
 *   - `-[cC]\s+\S+\s+` alongside `-\S+\s+` with an unconstrained value token, which let a
 *     `-c` run be consumed one token or two ways (140 chars → 64 s).
 * The surviving disambiguator is `[^-\s]`: a `-c`/`-C` VALUE may not itself start with `-`,
 * so exactly one alternative can ever consume a given token. 40 KB of the worst shapes now
 * matches in under a millisecond, and `lint.unit.test.ts` pins that with a wall-clock bound.
 */
const BARE_GIT_PUSH = /\bgit\s+(?:-[cC]\s+[^-\s]\S*\s+|-\S+\s+)*push\b/g;

/** Every file the bare-push check looks at: the whole handed-in corpus (`.md` + `.sh`). */
export const isBarePushScoped = (path: string): boolean => {
	const p = normalize(path).toLowerCase();
	return p.endsWith(".md") || p.endsWith(".sh");
};

/**
 * A fence delimiter — ``` or ~~~ — after any blockquote prefix is stripped. The corpus nests
 * runnable blocks inside blockquotes (`> ```bash`), so the prefix strip is what keeps those
 * blocks in scope; without it the most safety-critical blocks in write-code would be invisible
 * to this check.
 */
const stripQuotePrefix = (line: string): string => line.replace(/^\s*(?:>\s?)+/, "");

const FENCE = /^\s*(?:```|~~~)/;

/**
 * `git push` inside an EXECUTABLE region — a fenced code block in markdown, or the whole file
 * for a `.sh`. Scoping to code blocks is what lets the skills keep *writing about* a bare
 * `git push` in prose (they must, to explain why it is forbidden) while making the runnable
 * form impossible to ship. There is deliberately no per-line pragma and no self-exempt list:
 * an escape hatch that an agent can reach for is the attention-based enforcement ADR 0202
 * rules out, and today the corpus needs none — `pipeline-cli verified-push` covers every
 * sanctioned push site.
 */
export const scanBarePush = (file: string, content: string): ReadonlyArray<Finding> => {
	if (!isBarePushScoped(file)) return [];
	const isShell = normalize(file).toLowerCase().endsWith(".sh");
	const findings: Finding[] = [];
	const lines = content.split("\n");
	let inFence = isShell;
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i] ?? "";
		const text = isShell ? raw : stripQuotePrefix(raw);
		if (!isShell && FENCE.test(text)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) continue;
		BARE_GIT_PUSH.lastIndex = 0;
		for (const match of text.matchAll(BARE_GIT_PUSH)) {
			findings.push({
				file,
				line: i + 1,
				matched: match[0].trim(),
				reason:
					"a bare `git push` cannot report whether the ref landed (`| tail` eats its exit status, a detached run's output file carries none) — use `pipeline-cli verified-push`, which confirms the remote ref and emits a PUSH-VERDICT terminal line on stdout (#4213)",
			});
		}
	}
	return findings;
};

/**
 * A repo-relative path literal into the plugin's runnable surface — `./claude-plugins/<plugin>/skills|bin|lib|hooks/…`.
 *
 * This literal resolves ONLY inside a phoenix checkout. A marketplace consumer installs the plugin
 * into its own cache, outside its repo, so the same fence there is a guaranteed `No such file or
 * directory` — a live customer-down break (#4605). The portable literal is `./.claude/.pipeline/…`,
 * a symlink the SessionStart / WorktreeCreate hooks plant at whatever install is live.
 *
 * The leading `(?<![\w./-])` is what keeps a legitimate neighbour out of scope: the marketplace
 * manifest's `source: "./claude-plugins/<plugin>"` (no runnable-surface segment follows, so the
 * trailing group never matches) — a true statement about this repo's own layout, not a command
 * anyone pastes. It also guards any `../claude-plugins/…` relative target (the `.` is preceded
 * by another `.`), the class the retired `.claude/skills` symlink used to sit in.
 */
const NON_PORTABLE_PLUGIN_PATH =
	/(?<![\w./-])\.\/claude-plugins\/[A-Za-z0-9._-]+\/(?:skills|bin|lib|hooks)\//g;

/** Every file the fence-portability check looks at: the markdown corpus (the pasteable surface). */
export const isPortabilityScoped = (path: string): boolean => normalize(path).endsWith(".md");

/**
 * A non-portable plugin path literal inside a FENCED block — the surface an agent actually pastes.
 * Prose may keep naming the old form (it has to, to explain why it is forbidden), and a `.sh` is
 * never pasted by an agent, so neither is in scope; the fence is.
 *
 * There is deliberately no self-exempt list and no per-line pragma: an escape hatch is the
 * attention-based enforcement ADR 0202 rules out, and the corpus needs none — the planted link is
 * reachable from every consuming repo by construction.
 */
export const scanFencePortability = (file: string, content: string): ReadonlyArray<Finding> => {
	if (!isPortabilityScoped(file)) return [];
	const findings: Finding[] = [];
	const lines = content.split("\n");
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const text = stripQuotePrefix(lines[i] ?? "");
		if (FENCE.test(text)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) continue;
		NON_PORTABLE_PLUGIN_PATH.lastIndex = 0;
		for (const match of text.matchAll(NON_PORTABLE_PLUGIN_PATH)) {
			findings.push({
				file,
				line: i + 1,
				matched: match[0],
				reason:
					"a repo-relative `./claude-plugins/…` literal resolves only inside a phoenix checkout — in a marketplace consumer's repo the plugin lives in their cache and this fence is `No such file or directory`; use the hook-planted `./.claude/.pipeline/…` link (#4605)",
			});
		}
	}
	return findings;
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
	const barePushScanned: string[] = [];
	const barePushFindings: Finding[] = [];
	const portabilityScanned: string[] = [];
	const portabilityFindings: Finding[] = [];
	for (const {file, content} of files) {
		if (isPortabilityScoped(file)) {
			portabilityScanned.push(file);
			portabilityFindings.push(...scanFencePortability(file, content));
		}
		if (isFrontmatterScoped(file)) {
			frontmatterScanned.push(file);
			const fm = checkFrontmatter(file, content);
			if (fm !== null) frontmatterFindings.push(fm);
		}
		// Deliberately NOT narrowed by `isSelfExempt`: write-code is the file that owns both
		// push sites, so exempting it would exempt the only thing this check protects.
		if (isBarePushScoped(file)) {
			barePushScanned.push(file);
			barePushFindings.push(...scanBarePush(file, content));
		}
		if (isSelfExempt(file)) continue;
		scanned.push(file);
		findings.push(...scanFile(file, content));
	}
	return {
		findings,
		frontmatterFindings,
		barePushFindings,
		portabilityFindings,
		scanned,
		frontmatterScanned,
		barePushScanned,
		portabilityScanned,
	};
};

/**
 * Zero-scope test (ADR 0092): true when ANY check scanned NO files. A zero-scope run
 * is a FAIL, never a silent PASS — a lint that looked at nothing protects nothing. The
 * caller maps `true` → non-zero exit. Every scope must be non-empty: a corpus with no
 * frontmatter-bearing file is as broken a scope for the frontmatter gate as an empty
 * gh-call scope is for the grep, and an empty push scope would silently stop enforcing
 * the sanctioned push path.
 */
export const isZeroScope = (result: LintResult): boolean =>
	result.scanned.length === 0 ||
	result.frontmatterScanned.length === 0 ||
	result.barePushScanned.length === 0 ||
	result.portabilityScanned.length === 0;
