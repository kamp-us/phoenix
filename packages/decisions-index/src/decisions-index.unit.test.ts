import {assert, describe, it} from "@effect/vitest";
import {
	type AdrFile,
	buildIndex,
	DuplicateIdError,
	FrontmatterError,
	findDuplicateId,
	findRootDir,
	parseAdrFile,
	parseFrontmatter,
	renderIndex,
	sortEntries,
} from "./decisions-index.ts";

const adr = (id: string, title: string, status: string, date: string, slug = "x"): AdrFile => ({
	file: `${id}-${slug}.md`,
	text: `---\nid: ${id}\ntitle: ${title}\nstatus: ${status}\ndate: ${date}\ntags: [a, b]\n---\n\n# ${id} — ${title}\n\nbody\n`,
});

describe("parseFrontmatter", () => {
	it("reads id/title/status/date and ignores tags + body", () => {
		const fm = parseFrontmatter(
			"---\nid: 0001\ntitle: No export default\nstatus: accepted\ndate: 2026-05-09\ntags: [x]\n---\n# body\nid: ignored-in-body\n",
		);
		assert.deepStrictEqual(fm, {
			id: "0001",
			title: "No export default",
			status: "accepted",
			date: "2026-05-09",
		});
	});

	it("strips surrounding double quotes (titles with leading backtick / colon)", () => {
		const fm = parseFrontmatter(
			'---\nid: 0063\ntitle: "`skills/**` is code-gated: a note"\nstatus: accepted\ndate: 2026-06-15\n---\n',
		);
		assert.strictEqual(fm.title, "`skills/**` is code-gated: a note");
	});

	it('unescapes \\" inside a double-quoted title (round-trips inner quotes)', () => {
		const fm = parseFrontmatter(
			'---\nid: 0065\ntitle: "extends the boundary from \\"by path\\" toward \\"by nature\\""\nstatus: accepted\ndate: 2026-06-15\n---\n',
		);
		assert.strictEqual(fm.title, 'extends the boundary from "by path" toward "by nature"');
	});

	it("preserves inline markdown in status verbatim", () => {
		const fm = parseFrontmatter(
			"---\nid: 0003\ntitle: T\nstatus: superseded by [0009](0009-x.md)\ndate: 2026-05-16\n---\n",
		);
		assert.strictEqual(fm.status, "superseded by [0009](0009-x.md)");
	});

	it("returns empty when there is no front-matter block", () => {
		assert.deepStrictEqual(parseFrontmatter("# just a heading\n"), {});
	});
});

describe("parseAdrFile", () => {
	it("parses a well-formed file into an entry linking to its own filename", () => {
		const entry = parseAdrFile(adr("0034", "T", "accepted", "2026-05-29", "fate"));
		assert.deepStrictEqual(entry, {
			id: "0034",
			title: "T",
			status: "accepted",
			date: "2026-05-29",
			file: "0034-fate.md",
		});
	});

	it("throws FrontmatterError on a missing field", () => {
		const bad: AdrFile = {
			file: "0099-x.md",
			text: "---\nid: 0099\ntitle: T\ndate: 2026-01-01\n---\n",
		};
		assert.throws(() => parseAdrFile(bad), FrontmatterError);
	});
});

describe("sortEntries — deterministic ascending by id", () => {
	it("orders numerically, not lexically (input order irrelevant)", () => {
		const files = [
			adr("0010", "ten", "accepted", "d"),
			adr("0002", "two", "accepted", "d"),
			adr("0001", "one", "accepted", "d"),
		];
		const ids = sortEntries(files.map(parseAdrFile)).map((e) => e.id);
		assert.deepStrictEqual(ids, ["0001", "0002", "0010"]);
	});

	it("places a lettered id (0034a) between 0034 and 0035", () => {
		const files = [
			adr("0035", "c", "accepted", "d"),
			adr("0034a", "b", "accepted", "d"),
			adr("0034", "a", "accepted", "d"),
		];
		const ids = sortEntries(files.map(parseAdrFile)).map((e) => e.id);
		assert.deepStrictEqual(ids, ["0034", "0034a", "0035"]);
	});
});

describe("findDuplicateId — closes the ADR-number collision", () => {
	it("returns null when all ids are unique", () => {
		const entries = [adr("0001", "a", "accepted", "d"), adr("0002", "b", "accepted", "d")].map(
			parseAdrFile,
		);
		assert.strictEqual(findDuplicateId(entries), null);
	});

	it("flags two files sharing an id, naming both files", () => {
		const entries = [
			{file: "0064-a.md", text: adr("0064", "a", "accepted", "d").text},
			{file: "0064-b.md", text: adr("0064", "b", "accepted", "d").text},
		].map(parseAdrFile);
		const dup = findDuplicateId(entries);
		assert.instanceOf(dup, DuplicateIdError);
		assert.strictEqual(dup?.id, "0064");
		assert.deepStrictEqual([...(dup?.files ?? [])].sort(), ["0064-a.md", "0064-b.md"]);
	});
});

describe("renderIndex — canonical markdown", () => {
	it("emits the fixed preamble, table header, and one row per ADR, sorted", () => {
		const entries = [
			adr("0002", "Second", "proposed", "2026-05-10", "second"),
			adr("0001", "First", "accepted", "2026-05-09", "first"),
		].map(parseAdrFile);
		const md = renderIndex(entries);
		assert.strictEqual(
			md,
			"# Decisions\n" +
				"\n" +
				"One row per ADR. Read the file for the why.\n" +
				"\n" +
				"| # | Title | Status | Date |\n" +
				"|---|-------|--------|------|\n" +
				"| [0001](0001-first.md) | First | accepted | 2026-05-09 |\n" +
				"| [0002](0002-second.md) | Second | proposed | 2026-05-10 |\n",
		);
	});

	it("ends in exactly one trailing newline", () => {
		const md = renderIndex([parseAdrFile(adr("0001", "T", "accepted", "d"))]);
		assert.isTrue(md.endsWith("|\n"));
		assert.isFalse(md.endsWith("|\n\n"));
	});

	it("renders inline-markdown status verbatim (linked supersede)", () => {
		const md = renderIndex([
			parseAdrFile(adr("0003", "T", "superseded by [0009](0009-x.md)", "2026-05-16")),
		]);
		assert.include(md, "| superseded by [0009](0009-x.md) |");
	});
});

describe("findRootDir — cwd-independent repo-root resolution (#447)", () => {
	// POSIX dirname for the walk: drops the last segment, "/" is the fixpoint.
	const dirname = (p: string): string => {
		const i = p.lastIndexOf("/");
		if (i <= 0) return "/";
		return p.slice(0, i);
	};

	it("walks up from a package dir to the ancestor carrying the marker", () => {
		// The #447 case: run from packages/decisions-index, marker lives at the root.
		const root = "/repo";
		const hasMarker = (dir: string) => dir === root;
		assert.strictEqual(findRootDir("/repo/packages/decisions-index", hasMarker, dirname), "/repo");
	});

	it("returns the start dir when the marker is already there", () => {
		// The CI case: invoked from the repo root, where cwd === root.
		assert.strictEqual(
			findRootDir("/repo", (dir) => dir === "/repo", dirname),
			"/repo",
		);
	});

	it("returns null when no ancestor carries a marker (foreign-repo fallback to cwd)", () => {
		assert.strictEqual(
			findRootDir("/a/b/c", () => false, dirname),
			null,
		);
	});

	it("stops at the nearest ancestor when several carry the marker", () => {
		const hasMarker = (dir: string) => dir === "/repo" || dir === "/repo/packages";
		assert.strictEqual(
			findRootDir("/repo/packages/decisions-index", hasMarker, dirname),
			"/repo/packages",
		);
	});
});

describe("buildIndex — end-to-end (the stale-detection seam)", () => {
	it("round-trips: a committed index equal to buildIndex output is fresh", () => {
		const files = [
			adr("0001", "First", "accepted", "2026-05-09", "first"),
			adr("0002", "Second", "accepted", "2026-05-10", "second"),
		];
		const committed = buildIndex(files);
		// idempotent: regenerating from the same files yields byte-identical output
		assert.strictEqual(buildIndex(files), committed);
	});

	it("a changed ADR title makes the prior index stale (output differs)", () => {
		const before = buildIndex([adr("0001", "Old", "accepted", "d", "x")]);
		const after = buildIndex([adr("0001", "New", "accepted", "d", "x")]);
		assert.notStrictEqual(before, after);
	});

	it("throws DuplicateIdError before rendering when two files share an id", () => {
		const files: ReadonlyArray<AdrFile> = [
			{file: "0064-a.md", text: adr("0064", "a", "accepted", "d").text},
			{file: "0064-b.md", text: adr("0064", "b", "accepted", "d").text},
		];
		assert.throws(() => buildIndex(files), DuplicateIdError);
	});
});
