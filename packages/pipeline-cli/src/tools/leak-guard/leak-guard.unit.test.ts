import {assert, describe, it} from "@effect/vitest";
import {findLeaks, isSelfExempt, isSharedArtifact} from "./leak-guard.ts";

const hasLeak = (filePath: string, text: string): boolean => findLeaks(filePath, text).length > 0;

describe("findLeaks — BLOCK matrix (a real local path in a shared artifact)", () => {
	it("blocks an absolute /Users/<name> path in a .md", () => {
		const leaks = findLeaks("docs/notes.md", "see /Users/foo/project for details");
		assert.isAbove(leaks.length, 0);
		assert.strictEqual(leaks[0]?.matched, "/Users/foo");
	});

	it("blocks ~/.usirin/vault in a .md", () => {
		assert.isTrue(hasLeak("README.md", "the vault lives at ~/.usirin/vault"));
	});

	it("blocks ~/.claude in a .md", () => {
		assert.isTrue(hasLeak("guide.md", "edit ~/.claude/settings.json"));
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
