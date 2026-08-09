/**
 * The render-crash signal the review-design gate fails on (#2594).
 *
 * A single screenshot only sees pixels. A mount/init race — e.g. the #2593
 * composer null-editor `TypeError: Cannot read properties of null (reading
 * 'commands')`, thrown when `setContent` runs before the tiptap instance exists —
 * throws a runtime exception into the page on a "bad tick" while the captured
 * frame still looks acceptable. The six visual prohibitions never see it, so the
 * gate green-lit a component that hard-crashes for a fraction of loads. The fix:
 * the capture render also LISTENS for runtime errors, and a thrown uncaught
 * exception is a hard FAIL regardless of how the frame looks.
 *
 * This is the pure classification + failure-formatting core (`capture.ts` wires
 * the Playwright `pageerror`/`console` listeners that feed it; the review-design
 * skill reads each surface's `pageErrors` to decide the deterministic FAIL). An
 * uncaught `pageerror` is the crash signal; a `console.error` is captured too but
 * only advises — console.error is noisy in dev (React key/prop warnings), so
 * failing on it would trip the gate on benign output, against its
 * fail-conservative calibration.
 */

/** A runtime error observed in the page during a capture render. */
export interface PageError {
	/**
	 * `pageerror` = an uncaught exception (the hard-FAIL crash signal);
	 * `console.error` = an error logged via the console (advisory — noisy in dev).
	 */
	readonly kind: "pageerror" | "console.error";
	/** The error text as the page reported it (message, or `(no message)`). */
	readonly text: string;
}

/** One captured surface's observed page errors — the input to the gate decision. */
export interface SurfacePageErrors {
	readonly surface: string;
	readonly pageErrors: readonly PageError[];
}

/** Normalize a raw page-event string into a {@link PageError}, defaulting empty text. */
export const toPageError = (kind: PageError["kind"], text: string): PageError => {
	const trimmed = text.trim();
	return {kind, text: trimmed.length === 0 ? "(no message)" : trimmed};
};

export const isRenderCrash = (error: PageError): boolean => error.kind === "pageerror";

/**
 * The deterministic gate FAIL: name every uncaught exception thrown during the
 * capture render plus the surface it crashed on, or `null` when nothing threw.
 * `console.error` entries are excluded here — they surface as advisory, never a
 * hard FAIL. The summary is what the review-design verdict cites so a `write-code`
 * repair round can act on it cold (the error message + the surface under review).
 */
export const renderCrashFailure = (surfaces: readonly SurfacePageErrors[]): string | null => {
	const lines = surfaces.flatMap((s) =>
		s.pageErrors.filter(isRenderCrash).map((e) => `- ${s.surface}: ${e.text}`),
	);
	if (lines.length === 0) {
		return null;
	}
	const n = lines.length;
	const noun = n === 1 ? "exception" : "exceptions";
	return `${n} uncaught runtime ${noun} thrown during capture render:\n${lines.join("\n")}`;
};
