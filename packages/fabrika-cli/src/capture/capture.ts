/**
 * The impure Playwright leg: drive a headless chromium over a capture plan,
 * write each surface's PNG to disk, and return the bytes + the on-disk path.
 * Thin by design — the plan selection (`plan.ts`) and the upload classification
 * (`upload.ts`) hold the unit-tested logic; this file launches a browser, visits
 * each `Shot.url` at its viewport, screenshots it, and persists it.
 *
 * `localPath` is the PRIMARY judged artifact, so capture ALWAYS
 * produces it on success — losing it is never acceptable. Each capture also
 * collects the runtime errors thrown into the page during the render
 * (`pageErrors`) — the crash signal the gate fails on (see `page-errors.ts`).
 */
import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {type BrowserContext, chromium, type Page} from "@playwright/test";
import {Effect} from "effect";
import * as Schema from "effect/Schema";
import {readSessionProof, type SessionProof} from "./auth.ts";
import {
	type ForcedFlags,
	flagProbeBody,
	type OverrideProof,
	readOverrideProof,
} from "./flag-override.ts";
import {type LocaleProof, type LocaleSeed, readLocaleProof} from "./locale-seed.ts";
import {type PageError, toPageError} from "./page-errors.ts";
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
	/** Runtime errors thrown into the page during this render — the crash signal. */
	readonly pageErrors: readonly PageError[];
	/**
	 * The navigation's HTTP status, absent when the navigation served no response.
	 *
	 * Playwright resolves `goto` on a 404 like any other response, so a gate that only sees pixels
	 * judges an error page as composition. Carried so a caller can seat "unreachable" as its own
	 * proven outcome instead of inferring it from an image.
	 */
	readonly status?: number;
	/**
	 * Whether this context was signed in when the shot was taken, present only when the caller asked
	 * for the proof. Pixels cannot answer it: a cookie that does not authenticate renders the
	 * visitor's page, which is a valid PNG under the signed-in name.
	 */
	readonly sessionProof?: SessionProof;
	/**
	 * Whether the forced flags took, present only when the caller forced any. Pixels cannot answer
	 * it either: an unhonored override renders the flag-off page, a valid PNG under the flag-on
	 * name.
	 */
	readonly overrideProof?: OverrideProof;
	/**
	 * Whether the page rendered in the seeded locale, present only when the caller seeded one. A
	 * seed the app never read paints the default-locale page, a valid PNG under the requested name.
	 */
	readonly localeProof?: LocaleProof;
}

/** A Playwright launch/navigation/screenshot/write failure — surfaced, never swallowed. */
export class CaptureError extends Schema.TaggedError<CaptureError>()(
	"@kampus/fabrika-cli/capture/CaptureError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

/** A cookie to seed into the capture browser context before navigation. */
export interface CaptureCookie {
	readonly name: string;
	readonly value: string;
	/** Either `url`, or both `domain` and `path`, per Playwright's `addCookies`. */
	readonly url?: string;
	readonly domain?: string;
	readonly path?: string;
	/** Required for a `__Secure-`-prefixed name — Playwright rejects one set without it. */
	readonly secure?: boolean;
}

export interface CaptureOptions {
	/** Per-navigation timeout in ms (default 30s). */
	readonly navigationTimeoutMs?: number;
	/** Full-page screenshot (default) vs. above-the-fold only. */
	readonly fullPage?: boolean;
	/**
	 * Cookies seeded into every shot's browser context before navigation — the session cookie an
	 * `:auth` shot presents (`auth.ts`) and the flag-override cookie a forced shot
	 * carries (`flag-override.ts`). Absent ⇒ no cookies.
	 */
	readonly cookies?: readonly CaptureCookie[];
	/**
	 * Absolute URL of the session probe to hit from each shot's context after the cookies are seeded
	 * and before it navigates. Absent ⇒ no proof is taken and `sessionProof` stays absent.
	 */
	readonly sessionProbeUrl?: string;
	/**
	 * The flag-evaluation probe to run from each shot's context once the cookies are seeded — the
	 * URL to ask, and the flags whose forced values the answer is checked against. Absent ⇒ no proof
	 * is taken and `overrideProof` stays absent.
	 */
	readonly flagProbe?: {readonly url: string; readonly flags: ForcedFlags};
	/**
	 * A `localStorage` entry written in every document of each shot's context before any page
	 * script runs, then proved against the page's `document.documentElement.lang` before the shot.
	 * Absent ⇒ nothing is seeded and `localeProof` stays absent.
	 */
	readonly locale?: LocaleSeed;
	/** How long the locale proof waits for `lang` to name the seeded value (default 10s). */
	readonly localeSettleMs?: number;
}

/**
 * Ask the preview whether this context is signed in. The request goes through the context's own
 * `request` fixture, which carries its cookie jar — a bare `fetch` would carry nothing and answer
 * anonymous for every context alike.
 */
const proveSession = (context: BrowserContext, probeUrl: string): Promise<SessionProof> =>
	context.request
		.get(probeUrl)
		.then(async (response) => readSessionProof(response.status(), await response.text()))
		// Total on purpose, and not the enclosing `tryPromise`'s job: a rejected probe is a fact about
		// the PROBE, and letting it throw would classify the surface `Unreachable` — an accusation
		// against a page that may render perfectly well.
		.catch(
			(cause): SessionProof => ({
				_tag: "Unreadable",
				reason: `session probe failed: ${String(cause)}`,
			}),
		);

/**
 * Ask the preview what the forced flags evaluated to for this context. Same context, same cookie
 * jar, and total on the same terms as {@link proveSession}: a rejected probe is a fact about the
 * probe, and letting it throw would accuse the page of being unreachable.
 */
const proveOverride = (
	context: BrowserContext,
	probe: {readonly url: string; readonly flags: ForcedFlags},
): Promise<OverrideProof> =>
	context.request
		.post(probe.url, {
			headers: {"content-type": "application/json"},
			data: flagProbeBody(probe.flags),
		})
		.then(async (response) =>
			readOverrideProof(response.status(), await response.text(), probe.flags),
		)
		.catch(
			(cause): OverrideProof => ({
				_tag: "Unreadable",
				reason: `flag probe failed: ${String(cause)}`,
			}),
		);

/**
 * The page-side scripts, as source text: this package compiles without the DOM lib, so a function
 * body naming `document` or `localStorage` would not typecheck. Every operand is embedded through
 * `JSON.stringify`, so a key or value is always a string literal in the page, never code.
 */
const seedScript = (seed: LocaleSeed): string =>
	`try { localStorage.setItem(${JSON.stringify(seed.storageKey)}, ${JSON.stringify(seed.value)}); } catch {}`;
const langIs = (value: string): string =>
	`document.documentElement.lang === ${JSON.stringify(value)}`;
const READ_LANG = "document.documentElement.lang";

/**
 * Wait for the page's `lang` to name the seeded locale, then read it back. An app may set `lang`
 * only after an asynchronously loaded catalog lands, so first paint is not the answer; a wait that
 * times out is not a failure here, because the read after it is what decides. Total on the same
 * terms as {@link proveSession}: an evaluation that throws is a fact about the probe.
 */
const proveLocale = async (page: Page, value: string, settleMs: number): Promise<LocaleProof> => {
	await page.waitForFunction(langIs(value), undefined, {timeout: settleMs}).catch(() => undefined);
	return page
		.evaluate<unknown>(READ_LANG)
		.then((lang) => readLocaleProof(value, lang))
		.catch(
			(cause): LocaleProof => ({
				_tag: "Unreadable",
				reason: `lang read failed: ${String(cause)}`,
			}),
		);
};

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
	const localeSettleMs = options.localeSettleMs ?? 10_000;
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
							// A context per shot (not `browser.newPage`) so a shot's `deviceScaleFactor`
							// (the downscale lever) and the run's `cookies` (the dev-override cookie)
							// can be seeded before navigation — both are context-level in Playwright.
							const context = await browser.newContext({
								viewport: {width: shot.viewport.width, height: shot.viewport.height},
								...(shot.deviceScaleFactor === undefined
									? {}
									: {deviceScaleFactor: shot.deviceScaleFactor}),
							});
							if (options.cookies && options.cookies.length > 0) {
								await context.addCookies(options.cookies);
							}
							// The proof runs on the same context the shot is taken from, so what it
							// answers about is the seeded cookie and not a second, luckier one.
							const sessionProof =
								options.sessionProbeUrl === undefined
									? undefined
									: await proveSession(context, options.sessionProbeUrl);
							const overrideProof =
								options.flagProbe === undefined
									? undefined
									: await proveOverride(context, options.flagProbe);
							// An init script rather than a write after load, so the app's first read of the
							// key already sees the seed. The script guards its own write, because an
							// opaque-origin document (the initial about:blank) throws on `localStorage` access.
							const locale = options.locale;
							if (locale !== undefined) {
								await context.addInitScript({content: seedScript(locale)});
							}
							const page = await context.newPage();
							// Listen across the WHOLE navigation window (attached before goto), so a
							// runtime error thrown during mount/init is caught even when the frame
							// still renders acceptably. `networkidle` already settles past
							// React mount + effects, so no arbitrary sleep is needed — the events
							// have fired by the time goto resolves.
							const pageErrors: PageError[] = [];
							page.on("pageerror", (err) => pageErrors.push(toPageError("pageerror", String(err))));
							page.on("console", (msg) => {
								if (msg.type() === "error")
									pageErrors.push(toPageError("console.error", msg.text()));
							});
							try {
								const response = await page.goto(shot.url, {
									waitUntil: "networkidle",
									timeout: navigationTimeoutMs,
								});
								// Before the screenshot, so the pixels are of the page the proof answered about.
								const localeProof =
									locale === undefined
										? undefined
										: await proveLocale(page, locale.value, localeSettleMs);
								// A clip crops to the changed region; Playwright rejects clip + fullPage
								// together, so a clipped shot is never full-page.
								const buffer = await page.screenshot(
									shot.clip === undefined
										? {type: "png", fullPage}
										: {type: "png", clip: shot.clip},
								);
								const localPath = join(outDir, shot.fileName);
								await writeFile(localPath, buffer);
								return {
									surface: shot.surface.surface,
									route: shot.surface.route,
									state: shot.surface.state,
									localPath,
									fileName: shot.fileName,
									pngBytes: new Uint8Array(buffer),
									pageErrors,
									...(response === null ? {} : {status: response.status()}),
									...(sessionProof === undefined ? {} : {sessionProof}),
									...(overrideProof === undefined ? {} : {overrideProof}),
									...(localeProof === undefined ? {} : {localeProof}),
								};
							} finally {
								await context.close();
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
		(browser) =>
			Effect.tryPromise({
				try: () => browser.close(),
				catch: (cause) => new CaptureError({message: "failed to close chromium", cause}),
			}),
	);
};
