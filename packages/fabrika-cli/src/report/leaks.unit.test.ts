import {describe, expect, it} from "vitest";
import {isBareAtReference, renderLeaks, scanBody} from "./leaks.ts";

describe("scanBody", () => {
	it("classifies the three shapes and keeps the class root in the mask", () => {
		const body = ["~/notes/todo.md", "/Users/someone/code/x.ts", "/var/folders/ab/cd/T/y"].join(
			"\n",
		);
		const scan = scanBody(body);
		expect(scan.leaks.map((l) => l.class)).toEqual([
			"home-relative",
			"absolute home root",
			"temp root",
		]);
		expect(scan.redacted.split("\n")).toEqual([
			"~/<redacted>",
			"/Users/<redacted>",
			"/var/folders/<redacted>",
		]);
	});

	it("does not fold the temp roots together — which root it came from IS the evidence", () => {
		const scan = scanBody("/tmp/a /private/tmp/b /private/var/c /var/folders/d/e");
		expect(scan.redacted).toBe(
			"/tmp/<redacted> /private/tmp/<redacted> /private/var/<redacted> /var/folders/<redacted>",
		);
	});

	it("replaces the LONGER root first, so /private/tmp never degrades to /tmp", () => {
		const scan = scanBody("see /private/tmp/session/body.md");
		expect(scan.leaks).toHaveLength(1);
		expect(scan.redacted).toBe("see /private/tmp/<redacted>");
	});

	it("drops the leaf filename — a filename can itself identify a person or a machine", () => {
		expect(scanBody("/Users/someone/Desktop/invoice-someone.pdf").redacted).toBe(
			"/Users/<redacted>",
		);
	});

	it("carves out the two machine-agnostic claude config leaves, by exact leaf", () => {
		const scan = scanBody("~/.claude.json and ~/.claude/settings.json");
		expect(scan.leaks).toEqual([]);
		expect(scan.redacted).toBe("~/.claude.json and ~/.claude/settings.json");
	});

	it("still matches a deeper descent or a longer name under the carved-out leaf", () => {
		const scan = scanBody("~/.claude/settings.local.json ~/.claude/projects/x");
		expect(scan.leaks).toHaveLength(2);
		expect(scan.redacted).toBe("~/<redacted> ~/<redacted>");
	});

	it("reports the 1-based line of each hit", () => {
		const scan = scanBody(["clean", "clean", "/tmp/x/y"].join("\n"));
		expect(scan.leaks).toEqual([{line: 3, class: "temp root", text: "/tmp/x/y"}]);
		expect(renderLeaks(scan.leaks)).toEqual(["  line 3, temp root"]);
	});

	it("leaves prose alone: a bare root with no segment is not a path", () => {
		const scan = scanBody("the /tmp directory, a ~ in a table, and /home on its own");
		expect(scan.leaks).toEqual([]);
		expect(scan.redacted).toBe("the /tmp directory, a ~ in a table, and /home on its own");
	});

	it("does not swallow the sentence punctuation that follows a path", () => {
		expect(scanBody("it lives at /tmp/session/body.md.").redacted).toBe(
			"it lives at /tmp/<redacted>.",
		);
	});

	it("leaves a repo-relative path untouched — the Pointers section is repo-relative by contract", () => {
		const body = "packages/fabrika-cli/src/report/leaks.ts and apps/web/worker/http/retry.ts";
		expect(scanBody(body)).toEqual({leaks: [], redacted: body});
	});

	/**
	 * #5687 moved `build check`'s COMMITTED-file scan off this function onto `build/doc-leaks.ts`,
	 * which is deliberately looser on three shapes. This body surface is ungated — no CI stands
	 * behind an issue body — so it keeps refusing all three, and these pin that it still does.
	 */
	describe("still refuses everything the committed-file scanner now lets through", () => {
		it("takes a home marker inside a fenced code block", () => {
			const body = ["```bash", "grep -nE '(~/|/Users/|/home/)' -- .", "```"].join("\n");
			expect(scanBody(body).leaks).toEqual([
				{line: 2, class: "home-relative", text: "~/|/Users/|/home"},
			]);
		});

		it("takes a scratch root a doc may legitimately cite", () => {
			expect(scanBody("scratch lands under /tmp/fabrika-build/x").leaks).toEqual([
				{line: 1, class: "temp root", text: "/tmp/fabrika-build/x"},
			]);
		});

		it("has no self-exempt list — the shapes are refused whoever writes them", () => {
			expect(scanBody("the Lineage bullets name ~/code/github.com/o/r").leaks).toHaveLength(1);
		});
	});
});

describe("isBareAtReference", () => {
	it("catches the composed body having never arrived (#3086)", () => {
		expect(isBareAtReference("@/tmp/body.md")).toBe(true);
		expect(isBareAtReference("  \n@~/notes/body.md\n")).toBe(true);
	});

	it("is not fooled by an @mention or an email in prose", () => {
		expect(isBareAtReference("@usirin said the retry helper drops the reason")).toBe(false);
		expect(isBareAtReference("## Summary\nsee @/tmp/x later")).toBe(false);
	});
});
