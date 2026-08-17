import {assert, describe, it} from "@effect/vitest";
import {
	findCommentLeaks,
	findLeaks,
	isSelfExempt,
	isSharedArtifact,
	surfaceOf,
} from "./leak-guard.ts";

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
	// named by any MCP-server registration doc and reveal nothing operator-specific.
	const PUBLIC_CONFIG_FILES = [
		"registers the server into ~/.claude.json",
		"edit ~/.claude/settings.json to add the server",
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
	// The end-to-end guard-4 case from #3475: one comment naming all three at once passes.
	it("allows a comment naming all three config files at once (guard-4, #3475 e2e)", () =>
		assert.isFalse(
			hasCommentLeak(
				"an MCP plugin registers servers into ~/.claude.json, ~/.claude/settings.json, and the project .mcp.json",
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

	// #3492 (Option 1) — the /tmp arm has NO socket carve-out: the comment surface fail-closes on
	// ANY bare /tmp/…, including the crew-inbox socket glob. The false positive is fixed emit-side
	// (review-code reviewers write the socket as a bare `kampus-crew-inbox-*.sock` name or fenced),
	// never by weakening scan-pr Step 3.7.
	it("blocks a bare /tmp/…-*.sock socket glob in a verdict comment (#3492 — guard stays strict)", () =>
		assert.isTrue(
			hasCommentLeak(
				"review-code: PASS — the /tmp/kampus-crew-inbox-*.sock runtime path is the crew inbox socket",
			),
		));
	it("blocks a concrete /tmp scratch path in a verdict comment (#3492)", () =>
		assert.isTrue(hasCommentLeak("review-code: notes staged at /tmp/reviewer-scratch/verdict.md")));
});

describe("findLeaks — file surface keeps its /tmp carve-out (unchanged by the comment scan)", () => {
	it("still allows a bare /tmp path in a doc surface", () =>
		assert.isFalse(hasLeak("notes.md", "progress at /tmp/write-code-progress.md")));
	it("still allows /var/folders in a doc surface (temp roots are comment-body-only)", () =>
		assert.isFalse(hasLeak("notes.md", "ran under /var/folders/8f/T/tmp.abc")));
});

// #4496: the shell surface. Epic #4435 extracts pipeline shell out of markdown fences into
// standalone `.sh` files, so without this surface the guard's coverage shrinks with every
// extraction merge while the required check keeps exiting 0 (the #4470 class).
describe("findLeaks — the shell surface (#4496)", () => {
	it("flags a machine-local home path in a `.sh` file", () => {
		const leaks = findLeaks(
			"claude-plugins/kampus-pipeline/skills/ship-it/scripts/step2.sh",
			'root="/Users/ci-fixture/code/github.com/acme/widget"\n',
		);
		assert.lengthOf(leaks, 1);
		assert.strictEqual(leaks[0]?.matched, "/Users/ci-fixture");
	});

	// The deliberate divergence from an *invocation* guard, which skips comment-only lines
	// because a commented call is not run: a machine-local path is a leak wherever it sits in a
	// committed file, and a shell comment is the likeliest place for one to land (agents paste
	// their own worktree paths into explanatory comments).
	it("flags a machine-local path in a shell COMMENT, not just in a command", () =>
		assert.isTrue(hasLeak("scripts/deploy.sh", "# built from ~/code/github.com/acme/widget\n")));

	it("scans a `.sh` whole — a heredoc fence delimiter does not scope the surface", () =>
		assert.isTrue(
			hasLeak(
				"scripts/verdict.sh",
				["cat <<'EOF'", "```bash", "```", "EOF", "cd /Users/ci-fixture/x"].join("\n"),
			),
		));

	it("passes a clean `.sh` that cites repo-relative paths only", () =>
		assert.isFalse(
			hasLeak("scripts/clean.sh", 'root="packages/pipeline-cli/src/tools/leak-guard"\n'),
		));

	// AC: the self-exempt mechanism must still hold — and this entry only became LIVE with the
	// shell surface (it sat in the list unreachable while `.sh` was out of scope).
	it("keeps a path-hygiene `.sh` self-exempt", () =>
		assert.isFalse(hasLeak("skills/report/footer.sh", "cite /Users/ci-fixture/x, never\n")));
});

describe("surface predicates", () => {
	it("isSharedArtifact: .md / .mdx / .markdown, .decisions/.patterns dirs, and .sh", () => {
		assert.isTrue(isSharedArtifact("x.md"));
		assert.isTrue(isSharedArtifact("x.mdx"));
		assert.isTrue(isSharedArtifact("x.markdown"));
		assert.isTrue(isSharedArtifact(".decisions/0001.txt"));
		assert.isTrue(isSharedArtifact(".patterns/foo.json"));
		assert.isTrue(isSharedArtifact("claude-plugins/kampus-pipeline/skills/doctor/doctor.sh"));
		assert.isFalse(isSharedArtifact("src/index.ts"));
	});

	// The scan's per-surface scope tally reads this classifier, so a surface cannot be scanned by
	// one caller and skipped by another. Retained-by-design out of scope: `.ts` / `.yml` / `.json`
	// / `.toml` (see the module docblock — the shell surface exists because its premise expired,
	// which is not true of source or config).
	it("surfaceOf names the surface, and is null for out-of-scope files", () => {
		assert.strictEqual(surfaceOf("notes.md"), "doc");
		assert.strictEqual(surfaceOf(".decisions/0001-x.md"), "doc");
		assert.strictEqual(surfaceOf("scripts/deploy.sh"), "shell");
		assert.isNull(surfaceOf("src/index.ts"));
		assert.isNull(surfaceOf(".github/workflows/leak-guard.yml"));
		assert.isNull(surfaceOf("package.json"));
	});

	// The shell suffix is checked ahead of the doc dirs, so a script vendored under a doc dir is
	// tallied as the shell surface it is. Both surfaces scan identically, so this only pins the
	// scope tally — but an ambiguous classification would make that tally unreadable.
	it("surfaceOf classifies a `.sh` under a doc dir as the shell surface", () =>
		assert.strictEqual(surfaceOf(".patterns/example.sh"), "shell"));

	it("isSelfExempt: the guard's own files (old package + moved tool) and the path-hygiene skills", () => {
		assert.isTrue(isSelfExempt("packages/leak-guard/src/leak-guard.ts"));
		assert.isTrue(isSelfExempt("packages/pipeline-cli/src/tools/leak-guard/leak-guard.ts"));
		assert.isTrue(isSelfExempt("packages/pipeline-cli/src/tools/leak-guard/command.ts"));
		assert.isTrue(isSelfExempt("skills/review-doc/SKILL.md"));
		assert.isTrue(isSelfExempt("skills/report/footer.sh"));
		// the exemption is a suffix match, so the same file under its real plugin prefix
		// still ends with the canonical `/skills/<name>/...` and is exempt either way.
		assert.isTrue(isSelfExempt("claude-plugins/kampus-pipeline/skills/triage/SKILL.md"));
		// the triager agent's ## Output privacy rule names the forbidden machine-local
		// shapes as illustrative text (#1956), so it is self-exempt like the skills.
		assert.isTrue(isSelfExempt("agents/triager.md"));
		assert.isTrue(isSelfExempt(".claude/agents/triager.md"));
		assert.isFalse(isSelfExempt("README.md"));
	});

	// The suffix is narrow on purpose: the exemption covers the one verification harness that has
	// to enumerate the forbidden shapes, and NOT the shell surface it sits on (#4449).
	it("isSelfExempt: the write-code verify harness is exempt, its sibling scripts are not", () => {
		const scripts = "claude-plugins/kampus-pipeline/skills/write-code/scripts";
		assert.isTrue(isSelfExempt(`${scripts}/verify-fail-closed.sh`));
		assert.isFalse(isSelfExempt(`${scripts}/verify-byte-move.sh`));
		assert.isFalse(isSelfExempt(`${scripts}/step4-preflight.sh`));
	});

	it("findLeaks: a non-exempt `.sh` still reds on a planted machine-local path", () =>
		assert.isTrue(
			hasLeak(
				"claude-plugins/kampus-pipeline/skills/write-code/scripts/step4-preflight.sh",
				'WT="/Users/someone/code/repo"',
			),
		));
});
