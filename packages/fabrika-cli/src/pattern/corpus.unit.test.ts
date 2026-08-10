import {describe, expect, it} from "vitest";
import {docSlugs, readCorpus} from "./corpus.ts";
import {parseIndex} from "./index-table.ts";

const INDEX = `# Patterns

## Index — services

| Doc | Topic | Read when |
|---|---|---|
| [registered.md](./registered.md) | x | y |
| [gone.md](./gone.md) | x | y |
| [../.decisions/0001-a.md](../.decisions/0001-a.md) | x | y |
`;

describe("docSlugs", () => {
	// v1's `list-pattern-docs.sh` listed `index.md` as a pattern doc. It is the registry, not a member.
	it("excludes index.md and sorts ascending", () => {
		expect(docSlugs(["b.md", "index.md", "a.md", "notes.txt"])).toEqual(["a", "b"]);
	});
});

describe("readCorpus", () => {
	it("answers `absent` with no docs when the directory is not in the tree", () => {
		expect(readCorpus({present: false, names: [], index: null})).toMatchObject({
			outcome: "absent",
			members: [],
		});
	});

	it("answers `none` for a directory holding only its index", () => {
		expect(readCorpus({present: true, names: ["index.md"], index: null})).toMatchObject({
			outcome: "none",
			members: [],
		});
	});

	// `unknown` is the third value, and it is what keeps a false negative out: rendering an
	// unknowable registration as `unregistered` would report a defect this verb never proved.
	it("reports every registration `unknown` when the index parsed to no table", () => {
		const reading = readCorpus({present: true, names: ["a.md", "b.md"], index: null});
		expect(reading.members.map((m) => m.registration)).toEqual(["unknown", "unknown"]);
		expect(reading.unknown).toBe(2);
		expect(reading.unregistered).toBe(0);
		expect(reading.dangling).toEqual([]);
	});

	it("splits registered from unregistered and carries the registered doc's section", () => {
		const reading = readCorpus({
			present: true,
			names: ["registered.md", "orphan.md", "index.md"],
			index: parseIndex(INDEX),
		});
		expect(reading.members).toEqual([
			{slug: "orphan", registration: "unregistered", section: "-"},
			{slug: "registered", registration: "registered", section: "Index — services"},
		]);
		expect(reading.unregistered).toBe(1);
	});

	it("reports a row pointing outside the corpus as dangling, in document order", () => {
		const reading = readCorpus({
			present: true,
			names: ["registered.md"],
			index: parseIndex(INDEX),
		});
		expect(reading.dangling).toEqual([
			{target: "./gone.md", section: "Index — services"},
			{target: "../.decisions/0001-a.md", section: "Index — services"},
		]);
	});
});
