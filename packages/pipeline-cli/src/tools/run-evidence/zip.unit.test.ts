import {assert, describe, it} from "@effect/vitest";
import {bundleZipFor, makeZip} from "./fixtures.ts";
import {hasZipMagic, magicOf, readZipEntry, ZIP_MAGIC} from "./zip.ts";

const decoder = new TextDecoder();

// The #3693 payload class: a GitHub outage answers the artifact download with a JSON error body.
// Written where an archive was expected, it has to be positively recognizable as "not an archive".
const ERROR_BODY = new TextEncoder().encode(
	JSON.stringify({message: "Server Error", documentation_url: "https://docs.github.com"}),
);

describe("hasZipMagic — an archive is proven by its magic bytes, never assumed", () => {
	it("a real archive opens with PK\\x03\\x04", () => {
		const zip = bundleZipFor("deadbeef");
		assert.isTrue(hasZipMagic(zip));
		assert.strictEqual(magicOf(zip), ZIP_MAGIC);
	});

	it("a JSON error body does not", () => {
		assert.isFalse(hasZipMagic(ERROR_BODY));
	});

	it("an empty payload does not — the `gh api --silent` 0-byte class", () => {
		assert.isFalse(hasZipMagic(new Uint8Array(0)));
	});
});

describe("readZipEntry — three outcomes, and a non-archive is Malformed not NotFound", () => {
	it("reads a deflated entry out of a real archive", () => {
		const read = readZipEntry(bundleZipFor("c0ffee"), "manifest.json");
		assert.strictEqual(read._tag, "Found");
		if (read._tag !== "Found") return;
		assert.strictEqual(JSON.parse(decoder.decode(read.bytes)).commit, "c0ffee");
	});

	it("reads a stored entry too", () => {
		const read = readZipEntry(makeZip([{name: "a.txt", content: "hello"}]), "a.txt");
		assert.strictEqual(read._tag, "Found");
		if (read._tag !== "Found") return;
		assert.strictEqual(decoder.decode(read.bytes), "hello");
	});

	it("a well-formed archive missing the entry is NotFound, and names what it does carry", () => {
		const read = readZipEntry(
			makeZip([{name: "junit.xml", content: "<testsuites/>"}]),
			"manifest.json",
		);
		assert.strictEqual(read._tag, "NotFound");
		if (read._tag !== "NotFound") return;
		assert.deepStrictEqual(read.names, ["junit.xml"]);
	});

	it("a JSON error body is Malformed — the failed-read signal, not a missing entry", () => {
		const read = readZipEntry(ERROR_BODY, "manifest.json");
		assert.strictEqual(read._tag, "Malformed");
		if (read._tag !== "Malformed") return;
		assert.match(read.reason, /not a ZIP archive/);
		assert.include(read.reason, ZIP_MAGIC);
	});

	it("a truncated archive is Malformed", () => {
		const zip = bundleZipFor("deadbeef");
		const read = readZipEntry(zip.subarray(0, zip.length - 8), "manifest.json");
		assert.strictEqual(read._tag, "Malformed");
	});
});
