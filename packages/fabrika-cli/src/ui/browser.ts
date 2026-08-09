/**
 * The impure browser leg `ui render` injects: navigate one surface, classify what happened, and write
 * the PNG. Thin by construction — every decision the exit matrix routes on is *typed here and judged
 * in the verb*, so the whole render orchestration is unit-testable with a fake leg and no browser.
 *
 * The three classifications are the contract's, and each is a different fact: a status ≥ 400 or a
 * navigation that threw is **unreachable** (`15` — no route, dark flag, gated tier), a runtime error
 * thrown into the page is a **crashed** render (`14`, #2594's signal, read through the shared
 * `../capture/page-errors.ts` predicate), and anything else that goes wrong leaves the capture
 * **unknown** (`11`) rather than valid.
 *
 * A missing browser provision surfaces here as `Unknown` carrying the exact remediation command —
 * never a silent skip, and never a "surface is fine" reading.
 */
import {mkdir, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {type Browser, chromium} from "@playwright/test";
import {Effect} from "effect";
import {isRenderCrash, type PageError, toPageError} from "../capture/page-errors.ts";
import {legFailed} from "./leg-failed.ts";
import type {BrowseLeg, ShotOutcome, ShotRequest} from "./render-verb.ts";

/** The one string an operator is ever asked to run — and only after a provisioning failure. */
export const PROVISION_REMEDIATION = "pnpm exec playwright install chromium";

const NAVIGATION_TIMEOUT_MS = 30_000;

/** Settle a promise into its value or its failure, so no path here needs a `try`. */
const attempt = <A>(promise: Promise<A>): Promise<A | Error> =>
	promise.then(
		(value) => value,
		(cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))),
	);

const isProvisionFailure = (message: string): boolean =>
	message.includes("Executable doesn't exist") || message.includes("playwright install");

const shoot = async (browser: Browser, request: ShotRequest): Promise<ShotOutcome> => {
	const context = await attempt(browser.newContext({viewport: {...request.viewport}}));
	if (context instanceof Error) return {_tag: "Unknown", reason: context.message};
	const page = await attempt(context.newPage());
	if (page instanceof Error) return {_tag: "Unknown", reason: page.message};

	const pageErrors: PageError[] = [];
	page.on("pageerror", (err) => pageErrors.push(toPageError("pageerror", String(err))));
	page.on("console", (msg) => {
		if (msg.type() === "error") pageErrors.push(toPageError("console.error", msg.text()));
	});
	const response = await attempt(
		page.goto(request.url, {waitUntil: "networkidle", timeout: NAVIGATION_TIMEOUT_MS}),
	);
	if (response instanceof Error) {
		await attempt(context.close());
		return {_tag: "Unreachable", reason: `navigation failed: ${response.message}`};
	}
	const status = response?.status() ?? 0;
	const crash = pageErrors.find(isRenderCrash);
	const outcome = await (async (): Promise<ShotOutcome> => {
		if (status === 0) return {_tag: "Unreachable", reason: "the navigation returned no response"};
		if (status >= 400) return {_tag: "Unreachable", reason: `HTTP ${status}`};
		if (crash !== undefined) return {_tag: "Crashed", error: crash.text};
		const buffer = await attempt(page.screenshot({type: "png", fullPage: true}));
		if (buffer instanceof Error) return {_tag: "Unknown", reason: buffer.message};
		const written = await attempt(
			mkdir(dirname(request.outPath), {recursive: true}).then(() =>
				writeFile(request.outPath, buffer),
			),
		);
		return written instanceof Error
			? {_tag: "Unknown", reason: written.message}
			: {_tag: "Captured"};
	})();
	await attempt(context.close());
	return outcome;
};

/** Drive one page in a fresh context, and hand back the proven outcome. */
export const playwrightBrowse: BrowseLeg = (request) =>
	Effect.tryPromise({
		try: async (): Promise<ShotOutcome> => {
			const browser = await attempt(chromium.launch());
			if (browser instanceof Error) {
				return {
					_tag: "Unknown",
					reason: isProvisionFailure(browser.message)
						? `the headless browser is not provisioned (${browser.message.split("\n")[0]}) — run \`${PROVISION_REMEDIATION}\``
						: `chromium did not launch: ${browser.message}`,
				};
			}
			const outcome = await shoot(browser, request);
			await attempt(browser.close());
			return outcome;
		},
		catch: legFailed,
	}).pipe(
		Effect.catch((cause) => Effect.succeed<ShotOutcome>({_tag: "Unknown", reason: cause.reason})),
	);
