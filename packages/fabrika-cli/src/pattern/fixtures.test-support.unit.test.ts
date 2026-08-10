/**
 * The binding, proven: this file is what makes the scripted bytes a *read* of the fixtures rather
 * than a copy of them.
 *
 * A copy passes every test that consumes it, which is why the 93-versus-179-byte `PLAIN_DOC` drift
 * lived unnoticed (#5362). So each case below induces a mismatch and asserts it reds: bytes that
 * disagree with the file, a fixture that moved, and a fixture that reads as nothing.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describe, expect, it} from "vitest";
import {
	ANCHORED_DOC,
	FIXTURE_MANIFEST,
	FIXTURES,
	fixtureBytes,
	nonEmptyFixture,
	PLAIN_DOC,
	THREE_SECTIONS_INDEX,
	UNANCHORED_DOC,
} from "./fixtures.test-support.ts";

/** The second reader — a plain read of the same file, so the assertion is not the code restated. */
const onDisk = (relativePath: string): string =>
	readFileSync(
		fileURLToPath(new URL(`../../../../${FIXTURES}/${relativePath}`, import.meta.url)),
		"utf8",
	);

const BOUND = [
	["anchored/worker-queue-retry.md", ANCHORED_DOC],
	["anchored/plain-doc.md", PLAIN_DOC],
	["anchored/workspace.yaml", FIXTURE_MANIFEST],
	["unanchored-doc/worker-queue-retry.md", UNANCHORED_DOC],
	["three-sections/index.md", THREE_SECTIONS_INDEX],
] as const;

/**
 * This block reds for one edit and says so plainly: a constant that stops being a read and goes back
 * to being a literal that drifted. Fixture *content* drift cannot reach it any more — the constants
 * follow the file — and a fixture that moves or empties reds louder still, at import.
 */
describe("every scripted constant is its fixture file, byte for byte", () => {
	it.each(BOUND)("%s", (relativePath, scripted) => {
		const real = onDisk(relativePath);
		expect(scripted.length).toBe(real.length);
		expect(scripted).toBe(real);
	});
});

describe("the binding bites — an induced mismatch reds", () => {
	it("reds when the scripted bytes and the file diverge by a single byte", () => {
		expect(() => expect(`${PLAIN_DOC} `).toBe(onDisk("anchored/plain-doc.md"))).toThrow();
	});

	it("refuses a fixture that moved out from under the examples", () => {
		// Rehearsed against the real tree: moving `plain-doc.md` away reds every file that imports
		// these constants, at import, rather than scripting the seam with a stale copy.
		expect(() => fixtureBytes("anchored/moved-away.md")).toThrow(/ENOENT/);
	});

	it("refuses a fixture that reads as empty rather than scripting the seam with nothing", () => {
		expect(() => nonEmptyFixture("anchored/plain-doc.md", "\n")).toThrow(/read as empty/);
	});
});
