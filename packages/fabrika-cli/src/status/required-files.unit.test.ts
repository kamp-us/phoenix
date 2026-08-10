import {describe, expect, it} from "vitest";
import {classifySubject, parseRequiredFiles, splitDisposition} from "./required-files.ts";

const table = (rows: string): string =>
	`# skill\n\n## Required repo files\n\n| Must exist | Why | When missing |\n| --- | --- | --- |\n${rows}\n\n## Next section\n`;

describe("the `## Required repo files` reader", () => {
	it("reports a skill with no section as null, so the caller can render `undeclared`", () => {
		expect(parseRequiredFiles("# skill\n\nNo declarations here.\n")).toBeNull();
	});

	it("drops the header row and keeps every declaration", () => {
		const rows = parseRequiredFiles(
			table(
				"| `ROADMAP.md` | why | **degrade** — it is inert |\n| `a.md` | why | **fail-loud** — stop |",
			),
		);
		expect(rows?.map((r) => r.disposition)).toEqual(["degrade", "fail-loud"]);
	});

	it("keeps a row that does not carry three cells rather than dropping it", () => {
		const rows = parseRequiredFiles(table("| only one cell |"));
		expect(rows).toHaveLength(1);
		expect(rows?.[0]?.subject).toEqual({
			_tag: "Unprobeable",
			reason: "row does not carry three cells",
		});
	});

	it("reads the id token and never derives a slug from prose", () => {
		const rows = parseRequiredFiles(
			table("| `id:design-manifest` `x.md` | why | **degrade** — n |"),
		);
		expect(rows?.[0]?.surfaceId).toBe("design-manifest");
		expect(
			parseRequiredFiles(table("| The board label taxonomy | w | **degrade** — n |"))?.[0]
				?.surfaceId,
		).toBe("-");
	});

	// #5298: an absent id token sets the id column and decides nothing else.
	it("still classifies the subject of a row with no id token, so its presence stays the probe's answer", () => {
		const rows = parseRequiredFiles(table("| `ROADMAP.md` | why | **degrade** — n |"));
		expect(rows?.[0]?.surfaceId).toBe("-");
		expect(rows?.[0]?.subject).toEqual({_tag: "Path", path: "ROADMAP.md"});
	});
});

describe("the disposition is read by cell position, never by scanning for a bolded token", () => {
	it("takes the third cell's leading bolded word", () => {
		expect(splitDisposition("**fail-loud** — the run stops").disposition).toBe("fail-loud");
	});

	it("reports an unrecognized word verbatim rather than refusing or normalizing it", () => {
		expect(splitDisposition("**warn** — a fourth word").disposition).toBe("warn");
	});

	it("ignores a bolded word in the SECOND cell — the `**creates**` trap", () => {
		const rows = parseRequiredFiles(
			table("| `x.md` | `POST /labels` **creates** an unknown label | **fail-loud** — stop |"),
		);
		expect(rows?.[0]?.disposition).toBe("fail-loud");
	});
});

describe("subject classification", () => {
	it("reads a cell that OPENS with a backticked path as that path", () => {
		expect(classifySubject("`ROADMAP.md` with a `## Focus` section")).toEqual({
			_tag: "Path",
			path: "ROADMAP.md",
		});
	});

	it("reads the board taxonomy's tokens as labels", () => {
		expect(
			classifySubject("The board label taxonomy — `status:triaged`, `type:feature`, `p0`"),
		).toEqual({_tag: "Labels", labels: ["status:triaged", "type:feature", "p0"]});
	});

	/**
	 * The regression the contract names by example: this row must be `unprobeable`, and a
	 * `word:word` label grammar reads `lint:worktree` as a label and reports a missing label the
	 * table never declared.
	 */
	it("does NOT read a `package.json` script pair as a label", () => {
		const subject = classifySubject("The `package.json` scripts `typecheck` and `lint:worktree`");
		expect(subject._tag).toBe("Unprobeable");
	});

	it("does not probe a path named mid-sentence as a qualifier on some other subject", () => {
		expect(
			classifySubject("A dev server that actually comes ready — `design-harness.json`'s `command`")
				._tag,
		).toBe("Unprobeable");
	});

	it("has no probe for a subject that is neither a path nor a label", () => {
		expect(classifySubject("A merge queue enabled on the base branch")._tag).toBe("Unprobeable");
	});
});
