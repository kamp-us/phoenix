/**
 * The capture→upload merge (`mergeRecord`) — the correctness core of the reshape:
 * the judged image (`localPath`) is ALWAYS carried onto the record, decoupled
 * from the upload. The load-bearing invariant is that the upload FALLBACK path
 * (endpoint down) still yields a record with `localPath` — losing the image
 * exactly when the undocumented endpoint fails is what this reshape fixes.
 */
import {assert, describe, it} from "@effect/vitest";
import type {CapturedSurface} from "./capture.ts";
import {mergeRecord} from "./orchestrate.ts";

const captured: CapturedSurface = {
	surface: "/sozluk:empty",
	route: "/sozluk",
	state: "empty",
	localPath: "/tmp/out/sozluk-empty@desktop.png",
	fileName: "sozluk-empty@desktop.png",
	pngBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

describe("mergeRecord — localPath is always preserved", () => {
	it("carries the hosted URL through on a successful upload", () => {
		const url = "https://github.com/user-attachments/assets/abc";
		const rec = mergeRecord(captured, {hostedUrl: url, uploadError: null});
		assert.deepStrictEqual(rec, {
			surface: "/sozluk:empty",
			route: "/sozluk",
			state: "empty",
			localPath: "/tmp/out/sozluk-empty@desktop.png",
			hostedUrl: url,
			uploadError: null,
		});
	});

	it("KEEPS localPath when the upload fell back (hostedUrl null, uploadError set)", () => {
		const rec = mergeRecord(captured, {hostedUrl: null, uploadError: "HTTP 500: boom"});
		// The correctness fix: the judged artifact survives an upload failure.
		assert.strictEqual(rec.localPath, "/tmp/out/sozluk-empty@desktop.png");
		assert.strictEqual(rec.hostedUrl, null);
		assert.strictEqual(rec.uploadError, "HTTP 500: boom");
	});

	it("emits exactly the {surface, route, state, localPath, hostedUrl, uploadError} shape", () => {
		const rec = mergeRecord(captured, {hostedUrl: null, uploadError: "x"});
		assert.deepStrictEqual(Object.keys(rec).sort(), [
			"hostedUrl",
			"localPath",
			"route",
			"state",
			"surface",
			"uploadError",
		]);
	});
});
