/**
 * The impure Playwright leg: drive a headless chromium over a capture plan and
 * return each surface's PNG bytes. Thin by design — the plan selection
 * (`plan.ts`) and the upload classification (`upload.ts`) hold the unit-tested
 * logic; this file just launches a browser, visits each `Shot.url` at its
 * viewport, and screenshots it.
 *
 * It captures over the EXISTING per-PR preview deploy (ADR 0165 / #2247): the
 * caller passes URLs already rooted at the preview the `preview-deploy` bot
 * stood up — this helper never serves the app itself.
 */
import {chromium} from "@playwright/test";
import {Data, Effect} from "effect";
import type {Shot} from "./plan.ts";

/** The captured bytes for one shot, ready to hand to `uploadAsset`. */
export interface CapturedShot {
	readonly label: string;
	readonly url: string;
	readonly pngBytes: Uint8Array;
}

/** A Playwright launch/navigation/screenshot failure — surfaced, never swallowed. */
export class CaptureError extends Data.TaggedError("CaptureError")<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export interface CaptureOptions {
	/** Per-navigation timeout in ms (default 30s). */
	readonly navigationTimeoutMs?: number;
	/** Full-page screenshot (default) vs. above-the-fold only. */
	readonly fullPage?: boolean;
}

/**
 * Launch one chromium instance, shoot every plan entry serially (each in its own
 * page at the entry's viewport), and close the browser on every exit path
 * (`acquireUseRelease`). A failure on any single shot fails the whole effect with
 * a `CaptureError` naming the offending label + URL.
 */
export const captureShots = (
	shots: readonly Shot[],
	options: CaptureOptions = {},
): Effect.Effect<readonly CapturedShot[], CaptureError> => {
	const navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
	const fullPage = options.fullPage ?? true;
	return Effect.acquireUseRelease(
		Effect.tryPromise({
			try: () => chromium.launch(),
			catch: (cause) => new CaptureError({message: "failed to launch chromium", cause}),
		}),
		(browser) =>
			Effect.forEach(
				shots,
				(shot) =>
					Effect.tryPromise({
						try: async (): Promise<CapturedShot> => {
							const page = await browser.newPage({
								viewport: {width: shot.viewport.width, height: shot.viewport.height},
							});
							try {
								await page.goto(shot.url, {waitUntil: "networkidle", timeout: navigationTimeoutMs});
								const buffer = await page.screenshot({type: "png", fullPage});
								return {label: shot.label, url: shot.url, pngBytes: new Uint8Array(buffer)};
							} finally {
								await page.close();
							}
						},
						catch: (cause) =>
							new CaptureError({
								message: `failed to capture ${shot.label} at ${shot.url}`,
								cause,
							}),
					}),
				{concurrency: 1},
			),
		(browser) => Effect.promise(() => browser.close()),
	);
};
