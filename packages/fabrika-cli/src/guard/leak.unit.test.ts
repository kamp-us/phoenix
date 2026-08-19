/**
 * The leak gate's BLOCK/ALLOW matrix, ported from `pipeline-cli`'s `leak-guard.unit.test.ts` and
 * `path-matcher.unit.test.ts` (#173, #3070, #3401, #3475, #4496).
 *
 * Every literal below is a *shape*, not anyone's path — this file names the forbidden forms because
 * its subject is the rule, which is why it sits in `DOC_SELF_EXEMPT`.
 */
import {describe, expect, it} from "vitest";
import {DOC_SELF_EXEMPT, findLeaks, isSelfExempt, surfaceOf} from "./leak.ts";

const flags = (file: string, text: string): boolean => findLeaks(file, text).length > 0;

describe("findLeaks — blocks a real machine-local path in a shared artifact", () => {
	it("blocks an absolute /Users/<name> path in a .md", () => {
		const leaks = findLeaks("guide.md", "see /Users/alice/notes/todo.md");
		expect(leaks).toHaveLength(1);
		expect(leaks[0]?.matched).toBe("/Users/alice");
	});

	it("blocks an agent home dir in a .md", () => {
		expect(flags("guide.md", "the vault lives at ~/.usirin/vault")).toBe(true);
		expect(flags("guide.md", "logs under ~/.agent/runs")).toBe(true);
	});

	// #3475: the carve-out is the two public config FILES, never the directory tree.
	it("blocks a ~/.claude directory-internal path in a .md", () => {
		expect(flags("guide.md", "see ~/.claude/projects/x/memory.md")).toBe(true);
	});

	it("blocks a sibling-repo clone path in a .md", () => {
		expect(flags("guide.md", "cloned to ~/code/github.com/acme/thing")).toBe(true);
	});

	it("blocks a vault path in a .md", () => {
		expect(flags("guide.md", "notes in /vault/daily/2026-01-01.md")).toBe(true);
	});

	it("blocks a leak inside a .decisions/ file whatever its extension", () => {
		expect(flags(".decisions/0001-x.txt", "recorded at /Users/bob/x")).toBe(true);
	});
});

describe("findLeaks — leaves legitimate content alone", () => {
	it("allows repo-relative paths in a .md", () => {
		expect(flags("guide.md", "run apps/web/worker/index.ts and packages/fabrika-cli/src")).toBe(
			false,
		);
	});

	// The temp-root arms are a comment-body rule; a doc has legitimate bare-/tmp examples.
	it("allows a bare /tmp scratch path in a .md", () => {
		expect(flags("guide.md", "write it to /tmp/scratch/out.json")).toBe(false);
	});

	it("allows documented product home dirs in a .md", () => {
		expect(flags("guide.md", "config at ~/.config/kampus and state in ~/.alchemy")).toBe(false);
	});

	it("allows a bare home subdir that is not a clone shape", () => {
		expect(flags("guide.md", "saved under ~/Documents/report.pdf")).toBe(false);
	});

	// A drive-prefixed Windows file URL is not a macOS home leak, and flagging it blocked real PRs.
	it("allows a Windows drive-prefixed C:/Users path in a doc surface", () => {
		expect(flags("guide.md", "open file:///C:/Users/ci/build/log.txt")).toBe(false);
	});

	it("allows a /Users path inside a .ts — non-doc source is out of scope entirely", () => {
		expect(flags("src/thing.ts", "const p = '/Users/alice/x'")).toBe(false);
	});

	it("allows a bare ~ with no slash", () => {
		expect(flags("guide.md", "type ~ then enter")).toBe(false);
	});

	it("allows a clean shared artifact", () => {
		expect(flags("guide.md", "# Title\n\nNothing local here.\n")).toBe(false);
	});
});

describe("the ~/.claude public-config-file carve-out is a shape, not a list", () => {
	for (const text of [
		"registered in ~/.claude.json",
		"set it in ~/.claude/settings.json",
		"both ~/.claude.json and ~/.claude/settings.json are public",
	]) {
		it(`allows "${text}"`, () => expect(flags("guide.md", text)).toBe(false));
	}

	for (const text of [
		"see ~/.claude/settings.local.json",
		"back it up as ~/.claude.json.bak",
		"look in ~/.claude/todos",
		"the ~/.claude dir",
	]) {
		it(`still flags "${text}"`, () => expect(flags("guide.md", text)).toBe(true));
	}
});

describe("the generic sibling-clone arm matches any clone root and forge host", () => {
	for (const text of [
		"~/dev/github.com/acme/thing",
		"~/projects/gitlab.com/acme/thing",
		"~/work/codeberg.org/acme/thing",
	]) {
		it(`flags "${text}"`, () => expect(flags("guide.md", text)).toBe(true));
	}

	// The host segment is one dotted pair, so a multi-label host is out of the arm's reach — the
	// price of a shape narrow enough not to match every home subdir.
	it("does not reach a multi-label forge host", () => {
		expect(flags("guide.md", "~/src/git.sr.ht/acme/thing")).toBe(false);
	});

	// A single clone-root segment is deliberate: more would match a reverse-DNS bundle path.
	for (const text of ["~/Library/Application Support/com.acme.app/x", "~/.config/kampus/creds"]) {
		it(`allows "${text}"`, () => expect(flags("guide.md", text)).toBe(false));
	}
});

describe("the shell surface", () => {
	it("flags a machine-local home path in a .sh", () => {
		expect(flags("scripts/run.sh", 'root="/Users/alice/work"')).toBe(true);
	});

	// A `.sh` is scanned whole: a comment is the likeliest place for a real leak to sit.
	it("flags a machine-local path in a shell COMMENT", () => {
		expect(flags("scripts/run.sh", "# tested against ~/code/github.com/acme/thing")).toBe(true);
	});

	it("passes a .sh citing repo-relative paths only", () => {
		expect(
			flags("scripts/run.sh", "node packages/fabrika-cli/src/bin.ts guard readme-guard check"),
		).toBe(false);
	});
});

describe("surface classification", () => {
	it("names the doc surface by suffix and by directory", () => {
		expect(surfaceOf("a.md")).toBe("doc");
		expect(surfaceOf("a.mdx")).toBe("doc");
		expect(surfaceOf("a.markdown")).toBe("doc");
		expect(surfaceOf(".decisions/0001-x.txt")).toBe("doc");
		expect(surfaceOf(".patterns/x.txt")).toBe("doc");
	});

	it("names the shell surface, including under a doc dir", () => {
		expect(surfaceOf("scripts/run.sh")).toBe("shell");
		expect(surfaceOf(".patterns/run.sh")).toBe("shell");
	});

	it("is null for anything else", () => {
		expect(surfaceOf("src/a.ts")).toBeNull();
		expect(surfaceOf("package.json")).toBeNull();
	});
});

describe("self-exemption", () => {
	it("exempts the gate's own files and the path-hygiene docs", () => {
		expect(isSelfExempt("packages/fabrika-cli/src/guard/leak.ts")).toBe(true);
		expect(isSelfExempt("CLAUDE.md")).toBe(true);
		expect(isSelfExempt("claude-plugins/kampus-pipeline/skills/triage/SKILL.md")).toBe(true);
	});

	it("exempts the verify harness but not its sibling scripts", () => {
		expect(isSelfExempt("skills/write-code/scripts/verify-fail-closed.sh")).toBe(true);
		expect(isSelfExempt("skills/write-code/scripts/other.sh")).toBe(false);
	});

	it("still reds a non-exempt .sh carrying a planted path", () => {
		expect(flags("skills/write-code/scripts/other.sh", "cd ~/code/github.com/a/b")).toBe(true);
	});

	// The exemption is a suffix match, so every declared entry is rooted.
	it("declares every exemption as a rooted path", () => {
		for (const entry of DOC_SELF_EXEMPT) expect(entry.startsWith("/")).toBe(true);
	});
});
