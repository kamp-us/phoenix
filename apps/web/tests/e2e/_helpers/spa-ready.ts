import type {Page} from "@playwright/test";
import {isCloudflarePlaceholder404} from "../../integration/_edge-ready";

// Each `test()` gets a fresh Playwright context whose own connection can route to a Cloudflare
// edge PoP the single-context `preview-ready` warm gate never touched — one that hasn't yet
// propagated the SPA fallback for a route and so serves the typed CF edge-placeholder-404 on first
// paint. `gotoSpaReady` polls THROUGH that bounded readiness window (ADR 0127) until the real shell
// is served. Tolerance is scoped to the typed placeholder ONLY: a structured worker JSON 404, or any
// other response, returns at once for the caller's assertion to judge — a genuine failure still reds.
export const SPA_READY_DEADLINE_MS = 30_000;
const SPA_READY_POLL_MS = 1_500;

export async function gotoSpaReady(page: Page, route: string): Promise<void> {
	const deadline = Date.now() + SPA_READY_DEADLINE_MS;
	while (Date.now() < deadline) {
		const res = await page.goto(route);
		if (!res || res.status() !== 404) return;
		if (!isCloudflarePlaceholder404(res.status(), await res.text())) return;
		await page.waitForTimeout(SPA_READY_POLL_MS);
	}
}
