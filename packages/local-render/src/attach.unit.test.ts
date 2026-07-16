/**
 * The evidence-attach orchestration + its pure cores (#2964). The load-bearing
 * invariants: (a) the markdown is BOUND to the PR head SHA and refuses a non-SHA;
 * (b) before/after are paired by surface, tolerating new/removed surfaces; (c) an
 * upload fallback (endpoint down) degrades one embed to its diagnostic, never loses
 * the paired evidence and never fails the effect. The impure upload leg is injected
 * — no live network.
 */
import type {CapturedSurface, UploadAssetOptions, UploadOutcome} from "@kampus/design-capture";
import {Effect} from "effect";
import {describe, expect, it} from "vitest";
import {
	AttachEvidenceError,
	attachLocalEvidence,
	isHeadSha,
	pairSurfaces,
	renderEvidenceMarkdown,
	type SurfaceEvidence,
	type UploadLeg,
} from "./attach.ts";

const SHA = "a".repeat(40);

const captured = (surface: string, state: string | null, byte: number): CapturedSurface => ({
	surface,
	route: surface.replace(/:.*$/, ""),
	state,
	localPath: `/tmp/out/${surface}.png`,
	fileName: `${surface.replace(/[/:]/g, "-")}.png`,
	pngBytes: new Uint8Array([byte]),
	pageErrors: [],
});

/** A fake upload leg: records the files it was handed, returns a hosted URL per call (no network). */
const recordingUpload = () => {
	const calls: UploadAssetOptions[] = [];
	const leg: UploadLeg = (opts) => {
		calls.push(opts);
		return Effect.succeed<UploadOutcome>({
			hostedUrl: `https://github.com/user-attachments/assets/${opts.fileName}`,
			uploadError: null,
		});
	};
	return {leg, calls};
};

describe("isHeadSha", () => {
	it("accepts a full 40-hex lowercase SHA and rejects everything else", () => {
		expect(isHeadSha(SHA)).toBe(true);
		expect(isHeadSha("abc123")).toBe(false); // too short
		expect(isHeadSha(SHA.toUpperCase())).toBe(false); // uppercase
		expect(isHeadSha(`${SHA}0`)).toBe(false); // too long
		expect(isHeadSha("")).toBe(false);
	});
});

describe("pairSurfaces", () => {
	it("pairs a changed surface into both slots", () => {
		const paired = pairSurfaces([captured("/sozluk", null, 1)], [captured("/sozluk", null, 2)]);
		expect(paired).toHaveLength(1);
		expect(paired[0]?.before?.pngBytes).toEqual(new Uint8Array([1]));
		expect(paired[0]?.after?.pngBytes).toEqual(new Uint8Array([2]));
	});

	it("marks an after-only surface new (before null) and a before-only surface removed (after null)", () => {
		const paired = pairSurfaces([captured("/removed", null, 1)], [captured("/added", null, 2)]);
		const removed = paired.find((p) => p.surface === "/removed");
		const added = paired.find((p) => p.surface === "/added");
		expect(removed?.after).toBeNull();
		expect(added?.before).toBeNull();
		// before-pass surfaces come first, after-only appended
		expect(paired.map((p) => p.surface)).toEqual(["/removed", "/added"]);
	});
});

describe("renderEvidenceMarkdown", () => {
	const evidence = (over: Partial<SurfaceEvidence> = {}): SurfaceEvidence => ({
		surface: "/sozluk",
		route: "/sozluk",
		state: null,
		before: {hostedUrl: "https://github.com/user-attachments/assets/before", uploadError: null},
		after: {hostedUrl: "https://github.com/user-attachments/assets/after", uploadError: null},
		...over,
	});

	it("binds the markdown to the head SHA and embeds both images", () => {
		const md = renderEvidenceMarkdown([evidence()], SHA);
		expect(md).toContain(`Captured-head: @ ${SHA}`);
		expect(md).toContain("![before](https://github.com/user-attachments/assets/before)");
		expect(md).toContain("![after](https://github.com/user-attachments/assets/after)");
	});

	it("does NOT emit review-design's Reviewed-head anchor (stays out of ship-it's namespace)", () => {
		expect(renderEvidenceMarkdown([evidence()], SHA)).not.toContain("Reviewed-head:");
	});

	it("degrades a failed-upload side to its diagnostic, keeping the other embed", () => {
		const md = renderEvidenceMarkdown(
			[evidence({before: {hostedUrl: null, uploadError: "HTTP 500: boom"}})],
			SHA,
		);
		expect(md).toContain("_upload failed: HTTP 500: boom_");
		expect(md).toContain("![after](https://github.com/user-attachments/assets/after)");
	});

	it("renders a not-captured slot for a new/removed surface", () => {
		const md = renderEvidenceMarkdown([evidence({before: null})], SHA);
		expect(md).toContain("_not captured this pass_");
	});

	it("qualifies a stated surface title with its state", () => {
		const md = renderEvidenceMarkdown([evidence({surface: "/sozluk", state: "empty"})], SHA);
		expect(md).toContain("- /sozluk:empty");
	});

	it("emits an explicit no-surfaces note rather than a bare header", () => {
		expect(renderEvidenceMarkdown([], SHA)).toContain("_No composed surfaces captured");
	});

	it("throws on a malformed head SHA", () => {
		expect(() => renderEvidenceMarkdown([evidence()], "not-a-sha")).toThrow(/malformed head SHA/);
	});
});

describe("attachLocalEvidence", () => {
	it("uploads before+after per surface through the injected leg and binds the markdown", async () => {
		const {leg, calls} = recordingUpload();
		const result = await Effect.runPromise(
			attachLocalEvidence(
				{
					before: [captured("/sozluk", null, 1)],
					after: [captured("/sozluk", null, 2)],
					headSha: SHA,
					repositoryId: 42,
					token: "gh-token",
				},
				leg,
			),
		);
		// two uploads (before + after), each prefixed so the two passes don't collide by name
		expect(calls.map((c) => c.fileName)).toEqual(["before--sozluk.png", "after--sozluk.png"]);
		expect(calls.every((c) => c.repositoryId === 42 && c.token === "gh-token")).toBe(true);
		expect(result.records).toHaveLength(1);
		expect(result.markdown).toContain(`Captured-head: @ ${SHA}`);
	});

	it("skips the upload for an absent side (new/removed surface) and marks it not-captured", async () => {
		const {leg, calls} = recordingUpload();
		const result = await Effect.runPromise(
			attachLocalEvidence(
				{
					before: [],
					after: [captured("/added", null, 2)],
					headSha: SHA,
					repositoryId: 1,
					token: "t",
				},
				leg,
			),
		);
		// only the after side uploads; the absent before side is never sent to the leg
		expect(calls.map((c) => c.fileName)).toEqual(["after--added.png"]);
		expect(result.records[0]?.before).toBeNull();
		expect(result.markdown).toContain("_not captured this pass_");
	});

	it("fail-closes into AttachEvidenceError on a malformed head SHA before uploading", async () => {
		const {leg, calls} = recordingUpload();
		const exit = await Effect.runPromiseExit(
			attachLocalEvidence(
				{
					before: [captured("/x", null, 1)],
					after: [],
					headSha: "nope",
					repositoryId: 1,
					token: "t",
				},
				leg,
			),
		);
		expect(exit._tag).toBe("Failure");
		// no upload attempted once the SHA is rejected
		expect(calls).toHaveLength(0);
		if (exit._tag === "Failure") {
			const err = exit.cause;
			expect(JSON.stringify(err)).toContain("AttachEvidenceError");
		}
	});

	it("propagates an upload fallback into the record without failing the effect", async () => {
		const failing: UploadLeg = () =>
			Effect.succeed<UploadOutcome>({hostedUrl: null, uploadError: "endpoint down"});
		const result = await Effect.runPromise(
			attachLocalEvidence(
				{
					before: [captured("/sozluk", null, 1)],
					after: [captured("/sozluk", null, 2)],
					headSha: SHA,
					repositoryId: 1,
					token: "t",
				},
				failing,
			),
		);
		expect(result.records[0]?.before?.uploadError).toBe("endpoint down");
		expect(result.markdown).toContain("_upload failed: endpoint down_");
	});
});

// keep AttachEvidenceError import load-bearing (asserted by tag string above)
void AttachEvidenceError;
