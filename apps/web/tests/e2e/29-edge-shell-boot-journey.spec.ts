import {expect, test} from "@playwright/test";

/**
 * The reachability journey for the edge-resolved shell-boot vertical (ADR 0173 §2, ADR 0179,
 * epic #2926). `reachability-guard` asserts the `@journey:phoenix-edge-shell-boot` tag exists;
 * the e2e job runs the spec.
 *
 * It proves the CLIENT half of the `window.__BOOT__` contract deterministically, independent of a
 * live Flagship flip: `page.addInitScript` seeds `window.__BOOT__` exactly as the edge injects it
 * (into `<head>`, before the app module runs — ADR 0179 §2), then a hard reload measures whether
 * the shell paints its final geometry immediately with zero layout shift. Seeding the payload is
 * the faithful stand-in for the worker render — `useFlag` resolves a shell-key-manifest member
 * synchronously off `__BOOT__` with no fetch (ADR 0179 §3), so the seeded values reproduce the
 * on-path first paint the worker produces when `PHOENIX_EDGE_SHELL_BOOT` is on. This mirrors the
 * split `28-reaction-bar-darkship` uses: the unit tests own the pure resolution logic, this e2e
 * owns the in-browser first-paint proof.
 *
 * Dark-ship compatible (AC4): with no `__BOOT__` (the flag-off / never-hang fallback, the default
 * in local/CI where Flagship resolves the containment flag to its safe default) the shell degrades
 * to today's edge-direct, client-fetched render — proven by the dark-path test below.
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
// edge-resolved identity (ADR 0185). Seeded via addInitScript, so a plain shape, not typed here
// against BootPayload (the worker owns that type).
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

/** Seed `window.__BOOT__` before any page script — the addInitScript stand-in for edge injection. */
function seedBoot(boot: SeedBoot): void {
	window.__BOOT__ = boot as typeof window.__BOOT__;
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

test.describe("edge-resolved shell boot @journey:phoenix-edge-shell-boot", () => {
	test("edge-resolved __BOOT__ paints the topnav in final geometry with zero shell layout shift", async ({
		page,
	}) => {
		await page.addInitScript(installShellClsObserver);
		await page.addInitScript(seedBoot, BOOT_NAV_ON);
		await page.goto("/");

		const topbar = page.locator(".kp-topbar");
		await expect(topbar).toBeVisible({timeout: 10_000});

		// The nav is in its final geometry at first paint: the mecmua entry is present immediately,
		// resolved synchronously off __BOOT__ by useFlag (no fetch, no pop-in). akış is not a
		// topbar entry — it is a mecmua SUB-destination in the mecmua Subnav zone (#2603).
		const mecmua = page.locator(".kp-topbar__nav a", {hasText: /^mecmua$/i});
		await expect(mecmua).toBeVisible();

		// The consuming UI observed the edge-boot mode (the reachability-guard tie-in, ADR 0173 §1a).
		await expect(page.locator('[data-testid="edge-shell-boot"]')).toHaveAttribute(
			"data-active",
			"true",
		);

		// Capture the shell geometry, let the page hydrate + settle, and assert nothing moved.
		const topbarBefore = await topbar.boundingBox();
		const mecmuaBefore = await mecmua.boundingBox();
		await page.waitForLoadState("networkidle").catch(() => {});
		await page.waitForTimeout(1_500);
		expect(await topbar.boundingBox()).toEqual(topbarBefore);
		expect(await mecmua.boundingBox()).toEqual(mecmuaBefore);

		// And the shell's cumulative layout shift stays effectively zero across first-paint →
		// hydrate → settle. The bounding-box equality above is the strict geometry proof (the nav
		// slots do not move); this bounds any residual sub-pixel font-metric reflow well under the
		// CLS "good" threshold (0.1, web.dev/cls) — orders of magnitude below a perceptible shift.
		expect(await page.evaluate(() => window.__shellCLS ?? 0)).toBeLessThan(0.01);
	});

	test("edge-resolved __BOOT__.user suppresses the giriş-yap flash at first paint", async ({
		page,
	}) => {
		await page.addInitScript(seedBoot, BOOT_SIGNED_IN);
		await page.goto("/");

		await expect(page.locator(".kp-topbar")).toBeVisible({timeout: 10_000});
		// __BOOT__.user drives signed-in-at-first-paint (ADR 0185, #2933): the giriş-yap CTA never
		// renders and the signed-in affordance does — no CTA flash-then-swap. At `/` that
		// affordance is the topbar user pill (the pano `+ gönderi` action now lives in pano's
		// own Subnav zone), so it carries the positive half of the guarantee.
		await expect(page.getByRole("button", {name: /giriş yap/i})).toHaveCount(0);
		await expect(page.locator(".kp-topbar__user")).toBeVisible();
	});

	test("without __BOOT__ the shell degrades gracefully — dark-ship compatible", async ({page}) => {
		await page.addInitScript(() => {
			window.__BOOT__ = undefined;
		});
		await page.goto("/");

		await expect(page.locator(".kp-topbar")).toBeVisible({timeout: 10_000});
		// The base product nav still renders — the dark shell is byte-identical to today.
		await expect(page.locator(".kp-topbar__nav a", {hasText: /^sözlük$/i})).toBeVisible();
		await expect(page.locator(".kp-topbar__nav a", {hasText: /^pano$/i})).toBeVisible();
		// __BOOT__ absent ⇒ the client resolves through its fetch fallback, never assuming injection.
		expect(await page.evaluate(() => window.__BOOT__)).toBeUndefined();
		// The consuming marker reports the inactive mode (flag off in this env, no injection).
		await expect(page.locator('[data-testid="edge-shell-boot"]')).toHaveAttribute(
			"data-active",
			"false",
		);
	});
});
