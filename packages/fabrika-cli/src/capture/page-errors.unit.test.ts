/**
 * The render-crash gate decision: an uncaught runtime exception thrown
 * during the capture render hard-fails review-design regardless of how the frame
 * looks, and the failure names the error + the surface it crashed on. The
 * load-bearing case is a read-only rich-text editor's null-editor `TypeError`,
 * which a single good-tick screenshot missed.
 */
import {assert, describe, it} from "@effect/vitest";
import {
	isRenderCrash,
	type PageError,
	renderCrashFailure,
	type SurfacePageErrors,
	toPageError,
} from "./page-errors.ts";

describe("toPageError — normalization", () => {
	it("trims the reported text", () => {
		assert.deepStrictEqual(toPageError("pageerror", "  TypeError: boom  "), {
			kind: "pageerror",
			text: "TypeError: boom",
		});
	});

	it("defaults empty text to a placeholder rather than an empty string", () => {
		assert.strictEqual(toPageError("console.error", "   ").text, "(no message)");
	});
});

describe("isRenderCrash — only uncaught exceptions hard-fail", () => {
	it("treats an uncaught pageerror as a crash", () => {
		assert.strictEqual(isRenderCrash({kind: "pageerror", text: "TypeError: x"}), true);
	});

	it("does NOT treat a console.error as a crash (advisory — noisy in dev)", () => {
		assert.strictEqual(isRenderCrash({kind: "console.error", text: "Warning: bad key"}), false);
	});
});

describe("renderCrashFailure — the deterministic gate FAIL", () => {
	it("returns null when no surface threw", () => {
		const surfaces: SurfacePageErrors[] = [
			{surface: "/catalog", pageErrors: []},
			{surface: "/feed", pageErrors: []},
		];
		assert.strictEqual(renderCrashFailure(surfaces), null);
	});

	it("catches a null-editor TypeError on a bad tick, naming error + surface", () => {
		// The concrete escape: a read-only editor calls setContent before the
		// editor instance exists — a good-tick screenshot rendered fine, so the six
		// visual prohibitions passed while THIS uncaught exception was thrown.
		const nullEditor: PageError = {
			kind: "pageerror",
			text: "TypeError: Cannot read properties of null (reading 'commands')",
		};
		const surfaces: SurfacePageErrors[] = [
			{surface: "/editor/read-only", pageErrors: [nullEditor]},
		];
		const failure = renderCrashFailure(surfaces);
		assert.isNotNull(failure);
		assert.match(failure as string, /1 uncaught runtime exception thrown during capture render/);
		assert.include(failure as string, "/editor/read-only");
		assert.include(failure as string, "reading 'commands'");
	});

	it("ignores console.error entries — they never flip the verdict", () => {
		const surfaces: SurfacePageErrors[] = [
			{
				surface: "/catalog",
				pageErrors: [{kind: "console.error", text: "Warning: missing key prop"}],
			},
		];
		assert.strictEqual(renderCrashFailure(surfaces), null);
	});

	it("pluralizes and lists every crashed surface", () => {
		const surfaces: SurfacePageErrors[] = [
			{surface: "/a", pageErrors: [{kind: "pageerror", text: "TypeError: a"}]},
			{surface: "/b", pageErrors: [{kind: "console.error", text: "warn"}]},
			{surface: "/c", pageErrors: [{kind: "pageerror", text: "ReferenceError: c"}]},
		];
		const failure = renderCrashFailure(surfaces);
		assert.match(failure as string, /2 uncaught runtime exceptions thrown during capture render/);
		assert.include(failure as string, "/a: TypeError: a");
		assert.include(failure as string, "/c: ReferenceError: c");
		assert.notInclude(failure as string, "/b");
	});
});
