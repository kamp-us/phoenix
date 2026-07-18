import {assert, describe, it} from "@effect/vitest";
import {findCommentLeaks, findLeaks, isSelfExempt, isSharedArtifact} from "./leak-guard.ts";

const hasLeak = (filePath: string, text: string): boolean => findLeaks(filePath, text).length > 0;
const hasCommentLeak = (text: string): boolean => findCommentLeaks(text).length > 0;

describe("findLeaks — BLOCK matrix (a real local path in a shared artifact)", () => {
	it("blocks an absolute /Users/<name> path in a .md", () => {
		const leaks = findLeaks("docs/notes.md", "see /Users/foo/project for details");
		assert.isAbove(leaks.length, 0);
		assert.strictEqual(leaks[0]?.matched, "/Users/foo");
	});

	it("blocks ~/.usirin/vault in a .md", () => {
		assert.isTrue(hasLeak("README.md", "the vault lives at ~/.usirin/vault"));
	});

	it("blocks a ~/.claude directory-internal path in a .md (#3475 — internals stay flagged)", () => {
		assert.isTrue(hasLeak("guide.md", "session log at ~/.claude/projects/foo/bar.jsonl"));
	});

	it("blocks ~/code sibling-repo clone in a .md", () => {
		assert.isTrue(hasLeak("lineage.md", "rebuilt from ~/code/github.com/kamp-us/kampus"));
	});

	it("blocks /vault path in a .md", () => {
		assert.isTrue(hasLeak("notes.md", "stored under /vault/secrets"));
	});

	it("blocks a leak inside a .decisions/ file (dir-scoped, any extension)", () => {
		assert.isTrue(hasLeak(".decisions/0099-thing.md", "path /Users/foo/x"));
	});
});

describe("findLeaks — ALLOW matrix (legitimate content must NOT be flagged)", () => {
	it("allows repo-relative paths in a .md", () => {
		assert.isFalse(hasLeak("README.md", "see apps/web/worker and .claude/skills/report"));
	});

	it("allows bare /tmp scratch paths in a .md", () => {
		assert.isFalse(hasLeak("notes.md", "progress at /tmp/write-code-progress.md"));
		assert.isFalse(hasLeak("notes.md", "verdict at /tmp/review-code-verdict-12.md"));
	});

	it("allows ~/.config documented product paths in a .md", () => {
		assert.isFalse(hasLeak("docs.md", "credentials in ~/.config/kampus/creds"));
	});

	it("allows ~/.alchemy documented tool dir in a .md (see .patterns/alchemy-ci-cd.md)", () => {
		assert.isFalse(hasLeak("docs.md", "profiles live at ~/.alchemy/profiles.json"));
	});

	it("allows a bare ~/Documents home path in a .md (not a #158 leak dir)", () => {
		assert.isFalse(hasLeak("notes.md", "saved to ~/Documents/report.pdf"));
	});

	it("allows /Users inside a .ts (non-doc source is out of scope)", () => {
		assert.isFalse(hasLeak("src/fixture.ts", 'const p = "/Users/foo/x"'));
	});

	it("allows a Windows drive-prefixed C:/Users/... path in a doc surface (#3070)", () => {
		assert.isFalse(hasLeak("docs/notes.md", "on Windows the URL is file:///C:/Users/ci/proj/x"));
	});

	it("allows edits to a self-exempt skill (it names the tokens as patterns)", () => {
		assert.isFalse(hasLeak("skills/report/SKILL.md", "never cite /Users/... or ~/.usirin paths"));
	});

	it("allows clean prose with a bare ~ (no slash) in a .md", () => {
		assert.isFalse(hasLeak("notes.md", "the cost was ~5ms, roughly ~half the budget"));
	});

	it("allows a clean shared artifact with no local paths", () => {
		assert.isFalse(hasLeak("README.md", "this is ordinary prose with no paths at all"));
	});
});

describe("~/.claude public-config-file carve-out (#3475 — narrowed by shape, both surfaces)", () => {
	// The three provably-safe public, machine-agnostic config FILES must PASS on BOTH the doc
	// surface (findLeaks) and the guard-4 landed-comment surface (findCommentLeaks) — they are
	// the literal subject of packages/pipeline-crew-mcp and reveal nothing operator-specific.
	const PUBLIC_CONFIG_FILES = [
		"registers the server into ~/.claude.json",
		"edit ~/.claude/settings.json to add the crew server",
		"the project MCP config lives in .mcp.json",
	] as const;
	// The directory internals + operator-specific / config-file-lookalike forms must STILL trip
	// the detector — the carve-out is pinned to the two exact public leaves by shape.
	const STILL_FLAGGED = [
		"session log at ~/.claude/projects/foo/bar.jsonl",
		"todo state at ~/.claude/todos/list.json",
		"the ~/.claude directory holds machine state",
		"local override at ~/.claude/settings.local.json",
		"backup at ~/.claude.json.bak",
		"vault at ~/.usirin/vault",
		"agent home ~/.agent/state",
		"a real machine path /Users/someone/code/x",
	] as const;

	for (const text of PUBLIC_CONFIG_FILES) {
		it(`allows "${text}" on the doc surface`, () => assert.isFalse(hasLeak("guide.md", text)));
		it(`allows "${text}" on the comment surface (guard-4)`, () =>
			assert.isFalse(hasCommentLeak(text)));
	}
	// The end-to-end guard-4 case from #3475: one crew-mcp comment naming all three at once passes.
	it("allows a crew-mcp comment naming all three config files at once (guard-4, #3475 e2e)", () =>
		assert.isFalse(
			hasCommentLeak(
				"pipeline-crew-mcp registers servers into ~/.claude.json, ~/.claude/settings.json, and the project .mcp.json",
			),
		));

	for (const text of STILL_FLAGGED) {
		it(`still flags "${text}" on the doc surface`, () => assert.isTrue(hasLeak("guide.md", text)));
		it(`still flags "${text}" on the comment surface (guard-4)`, () =>
			assert.isTrue(hasCommentLeak(text)));
	}
});

describe("findCommentLeaks — PR/issue comment body scan (#2796, stricter than the file surface)", () => {
	const MKTEMP = "/var/folders/8f/r3k3t6817cgbsxsxvxk83q4c0000gn/T/tmp.TgExIt22qT";

	it("blocks a /var/folders mktemp path (the #2816/#2818 @<sha>-field recurrence)", () => {
		const leaks = findCommentLeaks(`review-code: PASS @${MKTEMP} — merge-ready`);
		assert.isAbove(leaks.length, 0);
	});
	it("blocks a whole-body @filepath scratchpad ref (the #2789 case)", () =>
		assert.isTrue(hasCommentLeak("@/private/tmp/claude-501/session/scratchpad/verdict.md")));
	it("blocks a /private/tmp scratchpad path", () =>
		assert.isTrue(hasCommentLeak("wrote it to /private/tmp/claude/scratchpad/verdict.md")));
	it("blocks a bare /tmp scratch path (no doc carve-out on a public comment)", () =>
		assert.isTrue(hasCommentLeak("verdict staged at /tmp/review-code-verdict-12.md")));
	it("blocks an absolute /Users/<name> path", () =>
		assert.isTrue(hasCommentLeak("see /Users/foo/project/notes")));
	// #3070 — the drive-letter carve-out: a Windows `C:/Users/...` file URL is not a macOS-home
	// leak, so quoting one in a verdict comment must not fail-closed-block enqueue (the #3063 FP);
	// a bare POSIX `/Users/<name>/` above still fires (true positive preserved).
	it("allows a Windows drive-prefixed file:///C:/Users/... URL (#3070 FP dropped)", () =>
		assert.isFalse(
			hasCommentLeak("derivation-contract example: file:///C:/Users/ci/proj/alchemy.run.ts"),
		));
	it("blocks a temp path that sits in verdict PROSE, not a SHA field", () =>
		assert.isTrue(hasCommentLeak(`review-code: advisory — see thread\n\nnotes at ${MKTEMP}`)));

	it("allows an inline verdict body with repo-relative paths and a real SHA", () =>
		assert.isFalse(
			hasCommentLeak(
				`review-code: PASS @ ${"a".repeat(40)} — verified apps/web/worker and packages/pipeline-cli`,
			),
		));
	it("allows a §CP advisory with a clean Reviewed-head anchor", () =>
		assert.isFalse(
			hasCommentLeak(
				`review-code: advisory — blocking-set PR (manual merge)\n\nReviewed-head: @ ${"b".repeat(40)}`,
			),
		));
	it("allows a GitHub PR URL (not a machine-local path)", () =>
		assert.isFalse(
			hasCommentLeak("cross-linked with https://github.com/kamp-us/phoenix/pull/2796"),
		));
	it("reports each leak once, no double-fire on /private/tmp vs /tmp", () => {
		const leaks = findCommentLeaks("staged at /private/tmp/claude/scratchpad/verdict.md");
		assert.strictEqual(leaks.length, 1);
	});
});

describe("findLeaks — file surface keeps its /tmp carve-out (unchanged by the comment scan)", () => {
	it("still allows a bare /tmp path in a doc surface", () =>
		assert.isFalse(hasLeak("notes.md", "progress at /tmp/write-code-progress.md")));
	it("still allows /var/folders in a doc surface (temp roots are comment-body-only)", () =>
		assert.isFalse(hasLeak("notes.md", "ran under /var/folders/8f/T/tmp.abc")));
});

describe("surface predicates", () => {
	it("isSharedArtifact: .md / .mdx / .markdown and .decisions/.patterns dirs", () => {
		assert.isTrue(isSharedArtifact("x.md"));
		assert.isTrue(isSharedArtifact("x.mdx"));
		assert.isTrue(isSharedArtifact("x.markdown"));
		assert.isTrue(isSharedArtifact(".decisions/0001.txt"));
		assert.isTrue(isSharedArtifact(".patterns/foo.json"));
		assert.isFalse(isSharedArtifact("src/index.ts"));
	});

	it("isSelfExempt: the guard's own files (old package + moved tool) and the path-hygiene skills", () => {
		assert.isTrue(isSelfExempt("packages/leak-guard/src/leak-guard.ts"));
		assert.isTrue(isSelfExempt("packages/pipeline-cli/src/tools/leak-guard/leak-guard.ts"));
		assert.isTrue(isSelfExempt("packages/pipeline-cli/src/tools/leak-guard/command.ts"));
		assert.isTrue(isSelfExempt("skills/review-doc/SKILL.md"));
		assert.isTrue(isSelfExempt("skills/report/footer.sh"));
		// the `.claude/skills` symlink path resolves too — its suffix still ends with
		// the canonical `/skills/<name>/...`, so editing through either path is exempt.
		assert.isTrue(isSelfExempt(".claude/skills/triage/SKILL.md"));
		// the triager agent's ## Output privacy rule names the forbidden machine-local
		// shapes as illustrative text (#1956), so it is self-exempt like the skills.
		assert.isTrue(isSelfExempt("agents/triager.md"));
		assert.isTrue(isSelfExempt(".claude/agents/triager.md"));
		assert.isFalse(isSelfExempt("README.md"));
	});
});
