import {describe, expect, it} from "vitest";
import {insertRow, linesChangedBeyond, readBackCarries} from "./register.ts";

const INDEX = `# Patterns

Prose between the tables, which no insertion may touch.

## Index — services

| Doc | Topic | Read when |
|---|---|---|
| [cache-invalidation.md](./cache-invalidation.md) | Cache keys | Touching a cached read |

## Index — edge

| Doc | Topic | Read when |
|---|---|---|
| [edge-session-cookies.md](./edge-session-cookies.md) | Session cookies | Changing session handling |
`;

const request = {
	slug: "worker-queue-retry",
	section: "Index — services",
	topic: "Retry and backoff",
	readWhen: "Adding a queue consumer",
};

describe("linesChangedBeyond", () => {
	it("is 0 for an insertion that adds exactly one line", () => {
		expect(linesChangedBeyond("a\nb\nc", "a\nNEW\nb\nc", 1)).toBe(0);
	});

	it("counts a neighbouring line that was rewritten alongside the insertion", () => {
		expect(linesChangedBeyond("a\nb\nc", "a\nNEW\nB\nc", 1)).toBe(1);
	});

	it("counts a deletion, which is not an insertion at all", () => {
		expect(linesChangedBeyond("a\nb\nc", "a\nNEW\nc", 1)).toBeGreaterThan(0);
	});
});

describe("insertRow", () => {
	it("inserts after the section's last row and leaves every other line byte-identical", () => {
		const out = insertRow(INDEX, request);
		if (out._tag !== "Inserted") throw new Error(`expected Inserted, got ${out._tag}`);
		expect(out.section).toBe("Index — services");
		expect(out.row).toBe(
			"| [worker-queue-retry.md](./worker-queue-retry.md) | Retry and backoff | Adding a queue consumer |",
		);
		// The prose and the second table survive verbatim: only one line was added.
		expect(out.text.split("\n").length).toBe(INDEX.split("\n").length + 1);
		expect(out.text).toContain("Prose between the tables, which no insertion may touch.");
		expect(out.text).toContain(
			"| [edge-session-cookies.md](./edge-session-cookies.md) | Session cookies | Changing session handling |",
		);
	});

	it("places the row under the NAMED section, not the first one", () => {
		const out = insertRow(INDEX, {...request, section: "Index — edge"});
		if (out._tag !== "Inserted") throw new Error(`expected Inserted, got ${out._tag}`);
		expect(readBackCarries(out.text, "worker-queue-retry", "Index — edge")).toBe(true);
		expect(readBackCarries(out.text, "worker-queue-retry", "Index — services")).toBe(false);
	});

	it("is a no-op when a row already links the doc — registering twice is not an error", () => {
		expect(insertRow(INDEX, {...request, slug: "cache-invalidation"})).toEqual({
			_tag: "Already",
			section: "Index — services",
		});
	});

	// Never truncated: a caller correcting a flag needs the whole set, so the next invocation is a
	// correction rather than a guess.
	it("names every section carrying a table when the flag names none of them", () => {
		expect(insertRow(INDEX, {...request, section: "Nonexistent Section"})).toEqual({
			_tag: "NoSection",
			present: ["Index — services", "Index — edge"],
		});
	});

	// A different fact with a different remedy: the flag is right and the index needs disambiguating.
	it("refuses an ambiguous section rather than picking one", () => {
		const doubled = `${INDEX}\n## Index — services\n\n| Doc | Topic | Read when |\n|---|---|---|\n| [x.md](./x.md) | a | b |\n`;
		expect(insertRow(doubled, request)).toEqual({_tag: "Ambiguous", count: 2});
	});

	it("reports a document holding no table rather than inventing one", () => {
		expect(insertRow("# Patterns\n\nNothing yet.\n", request)).toEqual({_tag: "NoTable"});
	});
});

describe("readBackCarries", () => {
	it("is false when the row landed under another section", () => {
		const out = insertRow(INDEX, request);
		if (out._tag !== "Inserted") throw new Error(`expected Inserted, got ${out._tag}`);
		expect(readBackCarries(out.text, "worker-queue-retry", "Index — services")).toBe(true);
		expect(readBackCarries(out.text, "no-such-doc", "Index — services")).toBe(false);
	});
});
