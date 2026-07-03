import {expect, type Locator, type Page} from "@playwright/test";

/**
 * Assert a vote score reaches AND HOLDS an expected value against SERVER TRUTH,
 * bounded with backoff — the fix for the vote-spec false-fail class (#1885).
 *
 * The score after a vote is (a) optimistically patched client-side, then (b)
 * overwritten by a live SSE push carrying the server-resolved score. On the live
 * preview + real D1 the read-back that feeds that push can lag: the frame can
 * arrive late, or (the failure this defends against) arrive carrying a STALE
 * value that overwrites the correct optimistic score and the DOM then settles
 * there with no further re-fetch. A passive `expect.poll` on the DOM cannot
 * recover from that — the settled value never changes on its own.
 *
 * So the robust form actively RELOADS the page between polls: a reload forces a
 * fresh fate-loader read of the current server state (the same escape hatch
 * `22-pano-live.spec.ts` uses to reconcile a missed live frame), re-rendering the
 * score from server truth rather than a possibly-stale live frame. We reload and
 * re-check until the score is stably `expected` or the bound expires — mirroring
 * the suite's generous live-D1 read-back windows (10–15s in `22`, `23`).
 */
export async function expectScoreConsistent(
	page: Page,
	score: Locator,
	expected: string,
	options: {timeout?: number; reloadInterval?: number} = {},
): Promise<void> {
	const timeout = options.timeout ?? 30_000;
	// Give the optimistic patch + a timely live frame a first chance to land
	// before we spend a reload — most passes resolve inside this window.
	const reloadInterval = options.reloadInterval ?? 6_000;
	const deadline = Date.now() + timeout;

	// First pass: wait for the DOM to reach `expected` without a reload — the
	// common case where the optimistic value holds or a timely live frame is
	// already correct. A reload would needlessly re-run auth/navigation.
	if (await reachedWithin(score, expected, Math.min(reloadInterval, remaining(deadline)))) {
		return;
	}

	// The DOM settled on a wrong value (stale live frame) or the read-back is
	// still lagging — reload to force a fresh server-truth read, then re-check.
	// Repeat under the bound with backoff so we absorb read-back lag but still
	// fail a genuinely-wrong score that never becomes `expected`.
	while (remaining(deadline) > 0) {
		await page.reload();
		await expect(score).toBeVisible({timeout: Math.min(10_000, remaining(deadline))});
		if (await reachedWithin(score, expected, Math.min(reloadInterval, remaining(deadline)))) {
			return;
		}
	}

	// Bound exhausted — surface a normal assertion failure with the last read so
	// a genuinely-wrong score (a "0" that never becomes "1") still fails loudly.
	await expect(score).toHaveText(expected, {timeout: 2_000});
}

function remaining(deadline: number): number {
	return Math.max(0, deadline - Date.now());
}

async function reachedWithin(score: Locator, expected: string, timeout: number): Promise<boolean> {
	if (timeout <= 0) return false;
	try {
		await expect(score).toHaveText(expected, {timeout});
		return true;
	} catch {
		return false;
	}
}
