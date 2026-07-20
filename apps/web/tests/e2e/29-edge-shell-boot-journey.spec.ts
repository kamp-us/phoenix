import {expect, type Page, test} from "@playwright/test";

/**
 * The first-paint contract for the edge-resolved shell (ADR 0179, epic #2926). Its containment
 * flag retired with #3672, so this is no longer a `@journey:`-registered reachability spec — it
 * stays as the in-browser regression proof for the now-permanent worker-first render.
 *
 * It proves the CLIENT half of the `window.__BOOT__` contract deterministically, by forcing the
 * payload at the NETWORK seam ({@link routeBoot}) rather than seeding it client-side. That is a
 * hard requirement since #3672: the worker now injects `__BOOT__` into `<head>` on every HTML
 * `GET`, and that inline script runs AFTER `page.addInitScript`, so an init-script seed is
 * overwritten before the app reads it. Rewriting the document response instead puts the payload
 * under test on the exact wire the edge uses, and is the only way the absent-`__BOOT__` half is
 * reachable at all.
 *
 * That absent half is not optional: when the never-hang guard (ADR 0179 §4) degrades to an
 * untransformed asset there is no `__BOOT__`, and the shell must still render through the client
 * fetch path. The fallback test below is that proof.
 */

declare global {
	interface Window {
		// Set by the injected observer: the cumulative layout shift attributed to the shell.
		__shellCLS?: number;
	}
}

/** A layout-shift performance entry — not in the DOM lib's `PerformanceEntry`, so declared here. */
interface LayoutShiftEntry extends PerformanceEntry {
	readonly value: number;
	readonly hadRecentInput: boolean;
	readonly sources?: ReadonlyArray<{readonly node?: Node | null}>;
}

// The `__BOOT__` boolean members are the shell flag-key STRINGS (shell-keys.ts); `user` is the
// edge-resolved identity (ADR 0185). Serialized into the document from the test process, so a
// plain shape, not typed here against BootPayload (the worker owns that type).
type SeedBoot = Record<string, unknown>;

// On-path: the two mecmua nav flags on, signed out — the nav shows mecmua in its final
// geometry from the first frame.
const BOOT_NAV_ON: SeedBoot = {
	"mecmua-public-read": true,
	"mecmua-feed": true,
	user: null,
};

// A signed-in edge payload: `__BOOT__.user` present drives signed-in-at-first-paint (the giriş-yap
// CTA is suppressed from frame one). Field shape mirrors BootUser (shell-keys.ts); values are inert
// for the CTA assertion (they only late-fill the chips).
const BOOT_SIGNED_IN: SeedBoot = {
	"mecmua-public-read": false,
	"mecmua-feed": false,
	user: {
		id: "boot-e2e-user",
		email: "boot@example.test",
		name: "Boot Kullanıcı",
		image: null,
		username: "bootkullanici",
		tier: "caylak",
		isModerator: false,
		emailFailing: false,
	},
};

/**
 * The worker's injected boot tag, as `bootScriptTag` emits it (`shell-boot.ts`). `JSON.stringify`
 * output is `<`-escaped there, so no payload value can contain a literal `</script>` — the lazy
 * match cannot terminate early on user content.
 */
const WORKER_BOOT_SCRIPT = /<script>\s*window\.__BOOT__\s*=[\s\S]*?<\/script>/gi;

/** Serialize a payload into the same inline tag the edge injects (mirrors `bootScriptTag`). */
const bootTag = (boot: SeedBoot): string =>
	`<script>window.__BOOT__=${JSON.stringify(boot).replace(/</g, "\\u003c")}</script>`;

/**
 * Force the exact `window.__BOOT__` a navigation boots with, at the network seam — rewriting the
 * document response the way the edge does, instead of racing it from a page script.
 *
 * Pass a payload to substitute one; pass `null` to serve the shell with NO boot script, which is
 * the never-hang fallback's wire shape (ADR 0179 §4) and unreachable any other way now that the
 * worker injects unconditionally (#3672). Returns the count of documents actually rewritten, so a
 * test can assert the seam ran rather than pass vacuously if interception silently no-ops.
 *
 * The matcher is scoped to the shell navigation (`/`) rather than `**\/*` deliberately: routing
 * every request proxies the web fonts through the test process too, which delays the font swap
 * past first paint and manufactures a nav reflow the zero-CLS test would then blame on the shell.
 */
async function routeBoot(page: Page, boot: SeedBoot | null): Promise<() => number> {
	let rewritten = 0;
	await page.route(
		(url) => url.pathname === "/",
		async (route) => {
			if (route.request().resourceType() !== "document") return route.continue();
			const response = await route.fetch();
			const headers = {...response.headers()};
			if (!(headers["content-type"] ?? "").includes("text/html")) return route.fulfill({response});
			// The fetched body is already decoded and re-length'd by the fulfill, so the upstream
			// framing headers would contradict it.
			delete headers["content-length"];
			delete headers["content-encoding"];
			const stripped = (await response.text()).replace(WORKER_BOOT_SCRIPT, "");
			const body =
				boot === null ? stripped : stripped.replace(/<\/head>/i, `${bootTag(boot)}</head>`);
			rewritten += 1;
			await route.fulfill({status: response.status(), headers, body});
		},
	);
	return () => rewritten;
}

/**
 * Install a layout-shift observer scoped to the shell (`.kp-topbar`). Only shifts whose source
 * node lives inside the topbar accrue to `window.__shellCLS`, so below-fold content settling
 * (the pano feed, images) never pollutes the shell-geometry measurement the AC is about.
 */
function installShellClsObserver(): void {
	window.__shellCLS = 0;
	try {
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as LayoutShiftEntry[]) {
				if (entry.hadRecentInput) continue;
				const touchesShell = (entry.sources ?? []).some((source) => {
					const raw = source.node ?? null;
					const element =
						raw instanceof Element ? raw : raw instanceof Node ? raw.parentElement : null;
					return element?.closest(".kp-topbar") != null;
				});
				if (touchesShell) window.__shellCLS = (window.__shellCLS ?? 0) + entry.value;
			}
		});
		observer.observe({type: "layout-shift", buffered: true});
	} catch {
		// A browser without the layout-shift entry type leaves __shellCLS at 0; the bounding-box
		// stability assertion below is the deterministic backstop.
	}
}

test.describe("edge-resolved shell boot", () => {
	test("edge-resolved __BOOT__ paints the topnav in final geometry with zero shell layout shift", async ({
		page,
	}) => {
		await page.addInitScript(installShellClsObserver);
		await routeBoot(page, BOOT_NAV_ON);
		await page.goto("/");

		const topbar = page.locator(".kp-topbar");
		await expect(topbar).toBeVisible({timeout: 10_000});

		// The nav is in its final geometry at first paint: the mecmua entry is present immediately,
		// resolved synchronously off __BOOT__ by useFlag (no fetch, no pop-in). akış is not a
		// topbar entry — it is a mecmua SUB-destination in the mecmua Subnav zone (#2603).
		const mecmua = page.locator(".kp-topbar__nav a", {hasText: /^mecmua$/i});
		await expect(mecmua).toBeVisible();

		// The marker observed the edge-boot mode — `__BOOT__` was injected for this render.
		await expect(page.locator('[data-testid="edge-shell-boot"]')).toHaveAttribute(
			"data-active",
			"true",
		);

		// The nav's SLOT SET at first paint — captured before anything async can have resolved.
		// This is the pop-in proof proper, and it is font-independent: a flag resolved late would
		// add or drop an entry here, whichever way the webfont swap moves the pixels.
		const navEntries = () => page.locator(".kp-topbar__nav a").allInnerTexts();
		const entriesAtFirstPaint = await navEntries();

		// Geometry is captured only once the webfont has swapped. Font-metric reflow moves every
		// nav link a few px and has nothing to do with the __BOOT__ contract — it is the residual
		// the CLS epsilon below is scaled for. Anchoring the strict box comparison after
		// `fonts.ready` keeps that confounder out of the assertion this test is actually making:
		// that hydration and the session/flag settle move nothing.
		await page.evaluate(() => document.fonts.ready);
		const topbarBefore = await topbar.boundingBox();
		const mecmuaBefore = await mecmua.boundingBox();

		await page.waitForLoadState("networkidle").catch(() => {});
		await page.waitForTimeout(1_500);

		expect(await navEntries()).toEqual(entriesAtFirstPaint);
		expect(await topbar.boundingBox()).toEqual(topbarBefore);
		expect(await mecmua.boundingBox()).toEqual(mecmuaBefore);

		// And the shell's cumulative layout shift stays effectively zero across first-paint →
		// hydrate → settle. This is the one assertion that spans the font swap too, so the epsilon
		// bounds it: a real browser produces a few px of font-metric reflow here, still far under
		// the CLS "good" threshold (0.1, web.dev/cls) and below perceptibility.
		expect(await page.evaluate(() => window.__shellCLS ?? 0)).toBeLessThan(0.01);
	});

	test("edge-resolved __BOOT__.user suppresses the giriş-yap flash at first paint", async ({
		page,
	}) => {
		await routeBoot(page, BOOT_SIGNED_IN);
		await page.goto("/");

		await expect(page.locator(".kp-topbar")).toBeVisible({timeout: 10_000});
		// __BOOT__.user drives signed-in-at-first-paint (ADR 0185, #2933): the giriş-yap CTA never
		// renders and the signed-in affordance does — no CTA flash-then-swap. At `/` that
		// affordance is the topbar user pill (the pano `+ gönderi` action now lives in pano's
		// own Subnav zone), so it carries the positive half of the guarantee.
		await expect(page.getByRole("button", {name: /giriş yap/i})).toHaveCount(0);
		await expect(page.locator(".kp-topbar__user")).toBeVisible();
	});

	test("without __BOOT__ the shell degrades gracefully — the never-hang fallback path", async ({
		page,
	}) => {
		const rewritten = await routeBoot(page, null);
		await page.goto("/");

		// The seam ran: without this the worker's own injection would sail through and the
		// absent-payload assertions below would be testing the wrong world.
		expect(rewritten()).toBeGreaterThan(0);
		await expect(page.locator(".kp-topbar")).toBeVisible({timeout: 10_000});
		// The base product nav still renders — the untransformed shell is byte-identical to today.
		await expect(page.locator(".kp-topbar__nav a", {hasText: /^sözlük$/i})).toBeVisible();
		await expect(page.locator(".kp-topbar__nav a", {hasText: /^pano$/i})).toBeVisible();
		// __BOOT__ absent ⇒ the client resolves through its fetch fallback, never assuming injection.
		expect(await page.evaluate(() => window.__BOOT__)).toBeUndefined();
		// The marker reports the inactive mode — no injection reached this render.
		await expect(page.locator('[data-testid="edge-shell-boot"]')).toHaveAttribute(
			"data-active",
			"false",
		);
	});
});
