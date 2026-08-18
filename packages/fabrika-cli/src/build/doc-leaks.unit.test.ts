import {describe, expect, it} from "vitest";
import {docLeaks, isDocLeakExempt, isDocSurface} from "./doc-leaks.ts";

/**
 * The three ways the body scanner disagreed with the committed-file gate (#5687). Each fixture is
 * bytes `pipeline-cli leak-guard scan` passes clean and `build check --surface prose` used to red.
 */
describe("docLeaks — the three divergences from the body scanner", () => {
	it("does not read a fenced regex literal as a path — a segment must be name-shaped", () => {
		// The reproducing bytes, verbatim from the report line that red the lane in #5687.
		const fenced = ["```bash", "grep -nE '(~/|/Users/|/home/)' -- .", "```"].join("\n");
		expect(docLeaks("reports/snapshot.md", fenced, [])).toEqual([]);
	});

	it("leaves a scratch root alone — temp roots are a comment-surface rule, not a doc one", () => {
		const doc = "Scratch files land under /tmp/fabrika-build/<lane>/notes.\n";
		expect(docLeaks("reports/snapshot.md", doc, [])).toEqual([]);
	});

	it("skips a doc the repo declared exempt, whose subject IS the path shapes", () => {
		const doc = "The Lineage bullets name ~/code/github.com/o/r on purpose.\n";
		expect(docLeaks("CLAUDE.md", doc, [])).toHaveLength(1);
		expect(docLeaks("CLAUDE.md", doc, ["/CLAUDE.md"])).toEqual([]);
	});
});

describe("docLeaks — what it still catches", () => {
	it("reports a real home path with its 1-based line", () => {
		const doc = ["intro", "", "run it from /Users/someone/phoenix", ""].join("\n");
		const leaks = docLeaks("docs/guide.md", doc, []);
		expect(leaks).toHaveLength(1);
		expect(leaks[0]?.line).toBe(3);
		expect(leaks[0]?.matched).toBe("/Users/someone");
	});

	it("scans inside a fence — a fence is a likely place for a real leak to sit", () => {
		const doc = ["```bash", "cd /Users/someone/phoenix && pnpm dev", "```"].join("\n");
		expect(docLeaks("docs/guide.md", doc, [])).toHaveLength(1);
	});

	it("takes a sibling clone under any home root, not just the named one", () => {
		expect(docLeaks("docs/guide.md", "cloned to ~/code/github.com/o/r\n", [])).toHaveLength(1);
		expect(docLeaks("docs/guide.md", "cloned to ~/dev/github.com/o/r\n", [])).toHaveLength(1);
		expect(docLeaks("docs/guide.md", "see ~/Documents/report.pdf\n", [])).toEqual([]);
	});

	it("carves out the claude CLI's two public config leaves, and only those", () => {
		expect(docLeaks("docs/guide.md", "set it in ~/.claude.json\n", [])).toEqual([]);
		expect(docLeaks("docs/guide.md", "set it in ~/.claude/settings.json\n", [])).toEqual([]);
		expect(docLeaks("docs/guide.md", "it wrote ~/.claude/todos/x.json\n", [])).toHaveLength(1);
	});

	it("does not read a Windows file URL as a macOS home leak", () => {
		expect(docLeaks("docs/guide.md", "file:///C:/Users/ci/build.log\n", [])).toEqual([]);
	});

	it("takes a vault path", () => {
		expect(docLeaks("docs/guide.md", "opened /vault/notes/x.md\n", [])).toHaveLength(1);
	});
});

describe("isDocSurface / isDocLeakExempt — the scoping, in one place", () => {
	it("takes markdown by extension and the decision/pattern dirs by path", () => {
		expect(isDocSurface("docs/guide.md")).toBe(true);
		expect(isDocSurface(".decisions/0001-x.markdown")).toBe(true);
		expect(isDocSurface(".patterns/index.md")).toBe(true);
		expect(isDocSurface("apps/web/worker/index.ts")).toBe(false);
	});

	it("scans nothing off a path no prose surface covers", () => {
		expect(docLeaks("scripts/run.sh", "cd /Users/someone/phoenix\n", [])).toEqual([]);
	});

	it("matches an exemption by suffix, so a relative and an absolute path agree", () => {
		expect(isDocLeakExempt("CLAUDE.md", ["/CLAUDE.md"])).toBe(true);
		expect(isDocLeakExempt("/repo/trees/a/CLAUDE.md", ["/CLAUDE.md"])).toBe(true);
		expect(isDocLeakExempt("docs/CLAUDE.md.bak", ["/CLAUDE.md"])).toBe(false);
	});
});
