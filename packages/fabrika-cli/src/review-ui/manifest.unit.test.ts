import {assert, describe, it} from "@effect/vitest";
import {
	type CaptureEntry,
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
	set: "judged",
	pr: 4321,
	head: HEAD,
	previewUrl: "https://pr-4321.example.test",
	captures: [
		{
			surface: "/pano",
			viewport: "desktop",
			path: "/tmp/fabrika-review-ui/4321-03135b91/judged/pano@desktop.png",
			width: 1280,
			height: 2140,
			sha256: "9c41",
			pageErrors: {rows: [], more: 0},
		},
		{
			surface: "/pano",
			viewport: "mobile",
			path: "/tmp/fabrika-review-ui/4321-03135b91/judged/pano@mobile.png",
			width: 390,
			height: 3200,
			sha256: "1f7b",
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
	it("parses back exactly what it serialized, viewport label and all", () => {
		const read = parseManifest(serializeManifest(manifest));
		assert.deepStrictEqual(read, {_tag: "Manifest", value: manifest});
	});

	// Two shots of one surface differ only by the label, so an entry that lost it could not say what
	// width its pixels are of — and the two would read as one capture recorded twice.
	it("refuses an entry carrying no viewport label", () => {
		const {viewport: _dropped, ...unlabelled} = manifest.captures[0] as CaptureEntry;
		assert.strictEqual(
			parseManifest(JSON.stringify({...manifest, captures: [unlabelled]}))._tag,
			"Malformed",
		);
	});

	it("round-trips a scheme-crossed entry, requested and proven scheme both", () => {
		const schemed: CaptureManifest = {
			...manifest,
			captures: [
				{
					...(manifest.captures[0] as CaptureEntry),
					scheme: {requested: "dark", proven: "dark"},
					path: "/tmp/fabrika-review-ui/4321-03135b91/judged/pano@desktop-dark.png",
				},
			],
		};
		assert.deepStrictEqual(parseManifest(serializeManifest(schemed)), {
			_tag: "Manifest",
			value: schemed,
		});
	});

	it("round-trips an accented entry, requested and proven accent both", () => {
		const accented: CaptureManifest = {
			...manifest,
			captures: [
				{...(manifest.captures[0] as CaptureEntry), accent: {requested: "amber", proven: "amber"}},
			],
		};
		assert.deepStrictEqual(parseManifest(serializeManifest(accented)), {
			_tag: "Manifest",
			value: accented,
		});
	});

	it("refuses an accent field that is not a requested/proven pair, rather than dropping it", () => {
		for (const accent of ["amber", {requested: "amber"}, {requested: "amber", proven: ""}, null]) {
			assert.strictEqual(
				parseManifest(JSON.stringify({...manifest, captures: [{...manifest.captures[0], accent}]}))
					._tag,
				"Malformed",
			);
		}
	});

	it("refuses a scheme field that is not a light/dark pair, rather than dropping it", () => {
		for (const scheme of ["dark", {requested: "dark"}, {requested: "dark", proven: "dim"}, null]) {
			assert.strictEqual(
				parseManifest(JSON.stringify({...manifest, captures: [{...manifest.captures[0], scheme}]}))
					._tag,
				"Malformed",
			);
		}
	});

	it("round-trips an interacted entry beside a scheme, label, steps and proofs all", () => {
		const interacted: CaptureManifest = {
			...manifest,
			captures: [
				...manifest.captures,
				{
					...(manifest.captures[0] as CaptureEntry),
					scheme: {requested: "dark", proven: "dark"},
					interaction: {
						label: "sil-highlighted",
						steps: ['click:role=button[name="Aç"]', 'hover:role=menuitem[name="Sil"]'],
						proven: ['role=menuitem[name="Sil"] matches :hover'],
					},
					path: "/tmp/fabrika-review-ui/4321-03135b91/judged/pano~sil-highlighted@desktop-dark.png",
				},
			],
		};
		assert.deepStrictEqual(parseManifest(serializeManifest(interacted)), {
			_tag: "Manifest",
			value: interacted,
		});
		// The at-rest entries beside it gain no field, so they read exactly as a set without one.
		assert.notProperty(manifest.captures[0], "interaction");
	});

	it("refuses an interaction field that is not a label with its steps and proofs, rather than dropping it", () => {
		for (const interaction of [
			"sil",
			{label: "sil", steps: ["hover:a"]},
			{label: "", steps: ["hover:a"], proven: ["a"]},
			{label: "sil", steps: [], proven: ["a"]},
			{label: "sil", steps: ["hover:a"], proven: [1]},
			null,
		]) {
			assert.strictEqual(
				parseManifest(
					JSON.stringify({...manifest, captures: [{...manifest.captures[0], interaction}]}),
				)._tag,
				"Malformed",
			);
		}
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

	it("refuses a set with zero captures — a set with no member is not a set", () => {
		assert.strictEqual(
			parseManifest(JSON.stringify({...manifest, captures: []}))._tag,
			"Malformed",
		);
	});

	it("carries a capture's page errors capped, with the dropped rows counted", () => {
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
