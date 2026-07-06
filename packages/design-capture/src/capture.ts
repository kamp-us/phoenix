/**
 * The impure Playwright leg: drive a headless chromium over a capture plan,
 * write each surface's PNG to disk, and return the bytes + the on-disk path.
 * Thin by design — the plan selection (`plan.ts`) and the upload classification
 * (`upload.ts`) hold the unit-tested logic; this file launches a browser, visits
 * each `Shot.url` at its viewport, screenshots it, and persists it.
 *
 * `localPath` is the PRIMARY judged artifact (ADR 0165): the review-design gate
 * reads the local PNG bytes to reach its verdict, decoupled from whether the
 * upload later succeeds. So capture ALWAYS produces `localPath` on success —
 * losing it is never acceptable.
 *
 * Captures over the EXISTING per-PR preview deploy (#2247): the caller passes
 * URLs already rooted at the preview the `preview-deploy` bot stood up — this
 * helper never serves the app itself.
 */
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {chromium} from "@playwright/test";
import {Data, Effect} from "effect";
import type {Shot} from "./plan.ts";

/** The captured bytes + on-disk path for one surface. */
export interface CapturedSurface {
	readonly surface: string;
	readonly route: string;
	readonly state: string | null;
	/** Absolute/relative path to the PNG on disk — the artifact the gate judges. */
	readonly localPath: string;
	/** The filesystem-safe PNG name (basename of `localPath`) — also the upload attachment name. */
	readonly fileName: string;
	readonly pngBytes: Uint8Array;
}

/** A Playwright launch/navigation/screenshot/write failure — surfaced, never swallowed. */
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
 * page at the entry's viewport), write each PNG under `outDir`, and close the
 * browser on every exit path (`acquireUseRelease`). A failure on any single shot
 * fails the whole effect with a `CaptureError` naming the offending surface + URL.
 */
export const captureShots = (
	shots: readonly Shot[],
	outDir: string,
	options: CaptureOptions = {},
): Effect.Effect<readonly CapturedSurface[], CaptureError> => {
	const navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
	const fullPage = options.fullPage ?? true;
	return Effect.acquireUseRelease(
		Effect.tryPromise({
			try: async () => {
				await mkdir(outDir, {recursive: true});
				return await chromium.launch();
			},
			catch: (cause) => new CaptureError({message: "failed to launch chromium", cause}),
		}),
		(browser) =>
			Effect.forEach(
				shots,
				(shot) =>
					Effect.tryPromise({
						try: async (): Promise<CapturedSurface> => {
							const page = await browser.newPage({
								viewport: {width: shot.viewport.width, height: shot.viewport.height},
							});
							try {
								await page.goto(shot.url, {waitUntil: "networkidle", timeout: navigationTimeoutMs});
								const buffer = await page.screenshot({type: "png", fullPage});
								const localPath = join(outDir, shot.fileName);
								await writeFile(localPath, buffer);
								return {
									surface: shot.surface.surface,
									route: shot.surface.route,
									state: shot.surface.state,
									localPath,
									fileName: shot.fileName,
									pngBytes: new Uint8Array(buffer),
								};
							} finally {
								await page.close();
							}
						},
						catch: (cause) =>
							new CaptureError({
								message: `failed to capture ${shot.surface.surface} at ${shot.url}`,
								cause,
							}),
					}),
				{concurrency: 1},
			),
		(browser) => Effect.promise(() => browser.close()),
	);
};
