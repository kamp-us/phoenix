import {assert, describe, it} from "@effect/vitest";
import {
	type CaptureManifest,
	isKebabSetName,
	manifestPath,
	PAGE_ERROR_CAP,
	parseManifest,
	serializeManifest,
	setDirectory,
	sha256Hex,
} from "./manifest.ts";

const HEAD = "03135b91aa04f7e2c9d8b1640a5c22e9f01b7d3c";

const manifest: CaptureManifest = {
	schemaVersion: 2,
	source: "review-ui-render",
	repository: "o/r",
	set: "judged",
	pr: 4321,
	head: HEAD,
	app: "web",
	previewUrl: "https://pr-4321.example.test",
	flags: [],
	captures: [
		{
			surface: "/pano",
			path: "/tmp/fabrika-review-ui/4321-03135b91/judged/pano.png",
			width: 1280,
			height: 2140,
			sha256: "9c41",
			pageErrors: {rows: [], more: 0},
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

	it("carries a capture's page errors capped, with the dropped rows counted (ADR 0308)", () => {
		const capped: CaptureManifest = {
			...manifest,
			captures: [
				{
					...(manifest.captures[0] as CaptureManifest["captures"][number]),
					pageErrors: {
						rows: [{kind: "console.error", text: "Warning: missing key prop"}],
						more: 41,
					},
				},
			],
		};
		const document = serializeManifest(capped);
		assert.include(document, '"pageErrors":{"rows":[{"kind":"console.error"');
		assert.include(document, '"more":41');
		assert.deepStrictEqual(parseManifest(document), {_tag: "Manifest", value: capped});
	});

	it("refuses the pre-collapse bare array, so a stale writer is Malformed and not silently read", () => {
		const stale = JSON.stringify({
			...manifest,
			captures: [
				{
					...(manifest.captures[0] as CaptureManifest["captures"][number]),
					pageErrors: [{kind: "console.error", text: "Warning: missing key prop"}],
				},
			],
		});
		assert.strictEqual(parseManifest(stale)._tag, "Malformed");
	});
});

describe("the page-error cap", () => {
	it("is a small whole number — the collapse must bound the payload, not echo it", () => {
		assert.isTrue(Number.isInteger(PAGE_ERROR_CAP));
		assert.isTrue(PAGE_ERROR_CAP > 0 && PAGE_ERROR_CAP <= 5);
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
