import {assert, describe, it} from "@effect/vitest";
import {
	type CaptureManifest,
	isKebabSetName,
	manifestPath,
	parseManifest,
	serializeManifest,
	setDirectory,
	sha256Hex,
} from "./manifest.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";

const manifest: CaptureManifest = {
	set: "judged",
	pr: 4321,
	head: HEAD,
	previewUrl: "https://pr-4321.example.test",
	captures: [
		{
			surface: "/pano",
			path: "/tmp/fabrika-review-ui/4321-03135b91/judged/pano.png",
			width: 1280,
			height: 2140,
			sha256: "9c41",
			pageErrors: [],
		},
	],
};

describe("the set path", () => {
	it("is derived from the PR and the head, so a later verb re-resolves it (v1 S4)", () => {
		assert.strictEqual(
			setDirectory("/tmp", 4321, HEAD, "judged"),
			"/tmp/fabrika-review-ui/4321-03135b91/judged",
		);
		assert.strictEqual(
			manifestPath(setDirectory("/tmp", 4321, HEAD, "judged")),
			"/tmp/fabrika-review-ui/4321-03135b91/judged/manifest.json",
		);
	});

	it("holds --out to kebab-case, so a set name is a safe path segment", () => {
		assert.isTrue(isKebabSetName("judged"));
		assert.isTrue(isKebabSetName("second-round-2"));
		assert.isFalse(isKebabSetName("Judged"));
		assert.isFalse(isKebabSetName("../escape"));
		assert.isFalse(isKebabSetName(""));
	});
});

describe("the manifest round-trip", () => {
	it("parses back exactly what it serialized", () => {
		const read = parseManifest(serializeManifest(manifest));
		assert.deepStrictEqual(read, {_tag: "Manifest", value: manifest});
	});

	it("refuses a document it cannot read whole, rather than defaulting a field", () => {
		assert.strictEqual(parseManifest("{")._tag, "Malformed");
		assert.strictEqual(parseManifest("[]")._tag, "Malformed");
		assert.strictEqual(parseManifest(JSON.stringify({...manifest, head: 3}))._tag, "Malformed");
		assert.strictEqual(
			parseManifest(JSON.stringify({...manifest, captures: [{surface: "/pano"}]}))._tag,
			"Malformed",
		);
	});

	it("refuses a set with zero captures — a set with no member is not a set (ADR 0092)", () => {
		assert.strictEqual(
			parseManifest(JSON.stringify({...manifest, captures: []}))._tag,
			"Malformed",
		);
	});
});

describe("sha256Hex", () => {
	it("is the content address a later verb re-derives the bytes against", () => {
		assert.strictEqual(
			sha256Hex(new TextEncoder().encode("abc")),
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});
