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
import {type AccentProof, type AccentRequest, readAccentProof} from "./accent.ts";
import {readSessionProof, type SessionProof} from "./auth.ts";
import {readSchemeProof, type SchemeProof, type SchemeRequest} from "./color-scheme.ts";
import {
	type ForcedFlags,
	flagProbeBody,
	type OverrideProof,
	readOverrideProof,
} from "./flag-override.ts";
import {
	foldInteractionProof,
	type Interaction,
	type InteractionProof,
	type InteractionProven,
	type InteractionRefused,
	type InteractionStep,
	PSEUDO_CLASS,
	readMatchCount,
	readPseudoProof,
	readVisibleProof,
	type StepProof,
} from "./interaction.ts";
import {type LocaleProof, type LocaleSeed, readLocaleProof} from "./locale-seed.ts";
import {type PageError, toPageError} from "./page-errors.ts";
import type {Shot} from "./plan.ts";

/** What one shot read off its page, whether or not it went on to write a PNG. */
export interface ShotReads {
	readonly surface: string;
	readonly route: string;
	readonly state: string | null;
	/** The filesystem-safe PNG name (basename of `localPath`) — also the upload attachment name. */
	readonly fileName: string;
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
	/**
	 * The scheme the page published on its declared root attribute, present only when the shot asked
	 * for one. An emulated preference the app overrode paints the other scheme, a valid PNG under the
	 * requested name.
	 */
	readonly schemeProof?: SchemeProof;
	/**
	 * The accent the page's root carried after the requested one was set, present only when the
	 * caller asked for one. An app that re-asserts its own accent paints that one, a valid PNG under
	 * the requested name.
	 */
	readonly accentProof?: AccentProof;
}

/** The captured bytes + on-disk path for one surface. */
export interface CapturedSurface extends ShotReads {
	/** Absolute/relative path to the PNG on disk — the artifact the gate judges. */
	readonly localPath: string;
	readonly pngBytes: Uint8Array;
	/**
	 * What the shot's interaction proved, present only when the shot ran one. Pixels cannot answer
	 * it: a hover the page never registered paints the at-rest surface, a valid PNG under the
	 * interacted name.
	 */
	readonly interactionProof?: InteractionProven;
}

/**
 * A shot whose interaction stopped short of its proof. No screenshot was taken and no file was
 * written: the page past a failed step is not the state the label names.
 */
export interface UnwrittenSurface extends ShotReads {
	readonly interactionProof: InteractionRefused;
}

export type ShotCapture = CapturedSurface | UnwrittenSurface;

export const isWritten = (capture: ShotCapture): capture is CapturedSurface =>
	capture.interactionProof?._tag !== "Refused";

/** A Playwright launch/navigation/screenshot/write failure — surfaced, never swallowed. */
export class CaptureError extends Schema.TaggedError<CaptureError>()(
	"@kampus/fabrika-cli/capture/CaptureError",
	{
		message: Schema.String,
		cause: Schema.optional(Schema.Unknown),
	},
) {}

/**
 * The captures of a plan, read as written ones by a caller whose plans never carry an interaction.
 * An unwritten one there is a plan this caller did not build, so it fails rather than being dropped.
 */
export const requireWritten = (
	captures: readonly ShotCapture[],
): Effect.Effect<readonly CapturedSurface[], CaptureError> => {
	const unwritten = captures.find((capture): capture is UnwrittenSurface => !isWritten(capture));
	return unwritten === undefined
		? Effect.succeed(captures.filter(isWritten))
		: Effect.fail(
				new CaptureError({
					message: `${unwritten.surface} wrote no capture: ${unwritten.interactionProof.reason}`,
				}),
			);
};

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
	/** How long the scheme proof waits for the root attribute to name the requested scheme (default 10s). */
	readonly schemeSettleMs?: number;
	/**
	 * A root attribute set on every shot's page once it has navigated, then proved against the page's
	 * own `document.documentElement` before the shot. Absent ⇒ nothing is set and `accentProof` stays
	 * absent.
	 */
	readonly accent?: AccentRequest;
	/** How long the accent proof waits for the root attribute to name the requested accent (default 10s). */
	readonly accentSettleMs?: number;
	/** How long one interaction step waits for its element and its action before it refuses (default 5s). */
	readonly interactionStepMs?: number;
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

const readRootAttribute = (attribute: string): string =>
	`document.documentElement.getAttribute(${JSON.stringify(attribute)})`;
const rootAttributeIs = (attribute: string, value: string): string =>
	`${readRootAttribute(attribute)} === ${JSON.stringify(value)}`;

/**
 * Wait for the page's declared root attribute to name the requested scheme, then read it back. An
 * app may publish its resolved scheme from an effect after mount, so the same settle-then-read
 * shape as {@link proveLocale} applies, and it is total on the same terms.
 */
const proveScheme = async (
	page: Page,
	request: SchemeRequest,
	settleMs: number,
): Promise<SchemeProof> => {
	await page
		.waitForFunction(rootAttributeIs(request.rootAttribute, request.scheme), undefined, {
			timeout: settleMs,
		})
		.catch(() => undefined);
	return page
		.evaluate<unknown>(readRootAttribute(request.rootAttribute))
		.then((value) => readSchemeProof(request, value))
		.catch(
			(cause): SchemeProof => ({
				_tag: "Unreadable",
				reason: `${request.rootAttribute} read failed: ${String(cause)}`,
			}),
		);
};

const setRootAttribute = (attribute: string, value: string): string =>
	`document.documentElement.setAttribute(${JSON.stringify(attribute)}, ${JSON.stringify(value)})`;

/**
 * Set the requested accent on the page's root, then wait for the attribute to name it and read it
 * back. The write runs after navigation because an attribute in the served markup would overwrite
 * one set before the parser created `<html>`. The write is not the answer — the read after the wait
 * is, so an app that re-asserts its own accent is caught. Total on the terms {@link proveLocale} is.
 */
const proveAccent = async (
	page: Page,
	request: AccentRequest,
	settleMs: number,
): Promise<AccentProof> => {
	await page
		.evaluate(setRootAttribute(request.rootAttribute, request.value))
		.catch(() => undefined);
	await page
		.waitForFunction(rootAttributeIs(request.rootAttribute, request.value), undefined, {
			timeout: settleMs,
		})
		.catch(() => undefined);
	return page
		.evaluate<unknown>(readRootAttribute(request.rootAttribute))
		.then((value) => readAccentProof(request, value))
		.catch(
			(cause): AccentProof => ({
				_tag: "Unreadable",
				reason: `${request.rootAttribute} read failed: ${String(cause)}`,
			}),
		);
};

/** Playwright's errors carry a call log after the first line; the first line is the answer. */
const firstLine = (cause: unknown): string => String(cause).split("\n")[0] ?? "";

/** The one element-side call a proof makes, typed structurally: this package has no DOM lib. */
interface Matchable {
	matches(selector: string): boolean;
}

/**
 * Run one step and read back what it claims. A locator step first waits for its element and
 * refuses unless exactly one matches, so no step acts on whichever of several the browser picked.
 */
const runStep = async (page: Page, step: InteractionStep, stepMs: number): Promise<StepProof> => {
	if (step.verb === "press") {
		await page.keyboard.press(step.key);
		return {_tag: "Acted"};
	}
	const locator = page.locator(step.locator);
	const attached = await locator
		.first()
		.waitFor({state: "attached", timeout: stepMs})
		.then(() => true)
		.catch(() => false);
	if (!attached) {
		return {_tag: "Refused", reason: `no element matched ${step.locator} within ${stepMs}ms`};
	}
	const counted = readMatchCount(step, await locator.count());
	if (counted !== null) return counted;
	const matches = (pseudo: string): Promise<unknown> =>
		locator.evaluate((el: Matchable, selector: string) => el.matches(selector), pseudo, {
			timeout: stepMs,
		});
	switch (step.verb) {
		case "click":
			await locator.click({timeout: stepMs});
			return {_tag: "Acted"};
		case "hover":
			await locator.hover({timeout: stepMs});
			return readPseudoProof(
				{verb: "hover", locator: step.locator},
				await matches(PSEUDO_CLASS.hover),
			);
		case "focus":
			await locator.focus({timeout: stepMs});
			return readPseudoProof(
				{verb: "focus", locator: step.locator},
				await matches(PSEUDO_CLASS.focus),
			);
		case "expect":
			// An element may be attached before it is shown — a menu mid-animation — so visibility is
			// waited for, and the read after the wait decides.
			await locator.waitFor({state: "visible", timeout: stepMs}).catch(() => undefined);
			return readVisibleProof(step, await locator.isVisible());
	}
};

/**
 * Run an interaction's steps in order, stopping at the first refusal. Total on the terms
 * {@link proveSession} is: a step that throws or times out is a fact about the step, and letting it
 * throw would classify the surface `Unreachable`.
 */
const proveInteraction = async (
	page: Page,
	interaction: Interaction,
	stepMs: number,
): Promise<InteractionProof> => {
	const answers: Array<{readonly step: InteractionStep; readonly proof: StepProof}> = [];
	for (const step of interaction.steps) {
		const proof = await runStep(page, step, stepMs).catch(
			(cause): StepProof => ({_tag: "Refused", reason: firstLine(cause)}),
		);
		answers.push({step, proof});
		if (proof._tag === "Refused") break;
	}
	return foldInteractionProof(answers);
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
): Effect.Effect<readonly ShotCapture[], CaptureError> => {
	const navigationTimeoutMs = options.navigationTimeoutMs ?? 30_000;
	const fullPage = options.fullPage ?? true;
	const localeSettleMs = options.localeSettleMs ?? 10_000;
	const schemeSettleMs = options.schemeSettleMs ?? 10_000;
	const accentSettleMs = options.accentSettleMs ?? 10_000;
	const interactionStepMs = options.interactionStepMs ?? 5_000;
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
						try: async (): Promise<ShotCapture> => {
							// A context per shot (not `browser.newPage`) so a shot's `deviceScaleFactor`
							// (the downscale lever) and the run's `cookies` (the dev-override cookie)
							// can be seeded before navigation — both are context-level in Playwright.
							const context = await browser.newContext({
								viewport: {width: shot.viewport.width, height: shot.viewport.height},
								...(shot.deviceScaleFactor === undefined
									? {}
									: {deviceScaleFactor: shot.deviceScaleFactor}),
								// Emulated `prefers-color-scheme`, so no app's storage key is written here.
								...(shot.scheme === undefined ? {} : {colorScheme: shot.scheme.scheme}),
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
								const schemeProof =
									shot.scheme === undefined
										? undefined
										: await proveScheme(page, shot.scheme, schemeSettleMs);
								const accent = options.accent;
								const accentProof =
									accent === undefined
										? undefined
										: await proveAccent(page, accent, accentSettleMs);
								// After the page proofs, so the steps act on the page those answered about.
								const interactionProof =
									shot.interaction === undefined
										? undefined
										: await proveInteraction(page, shot.interaction, interactionStepMs);
								const reads: ShotReads = {
									surface: shot.surface.surface,
									route: shot.surface.route,
									state: shot.surface.state,
									fileName: shot.fileName,
									pageErrors,
									...(response === null ? {} : {status: response.status()}),
									...(sessionProof === undefined ? {} : {sessionProof}),
									...(overrideProof === undefined ? {} : {overrideProof}),
									...(localeProof === undefined ? {} : {localeProof}),
									...(schemeProof === undefined ? {} : {schemeProof}),
									...(accentProof === undefined ? {} : {accentProof}),
								};
								if (interactionProof?._tag === "Refused") {
									return {...reads, interactionProof};
								}
								// A clip crops to the changed region; Playwright rejects clip + fullPage
								// together, so a clipped shot is never full-page. An interaction has just
								// started the transitions its state paints with, so its shot fast-forwards them
								// to their end rather than freezing a frame halfway to the state it names. An accent
								// set after load starts the colour transitions it paints with, on the same terms.
								const settle = interactionProof !== undefined || accentProof !== undefined;
								const buffer = await page.screenshot({
									type: "png",
									...(shot.clip === undefined ? {fullPage} : {clip: shot.clip}),
									...(settle ? {animations: "disabled" as const} : {}),
								});
								const localPath = join(outDir, shot.fileName);
								await writeFile(localPath, buffer);
								return {
									...reads,
									localPath,
									pngBytes: new Uint8Array(buffer),
									...(interactionProof === undefined ? {} : {interactionProof}),
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
