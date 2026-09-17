/**
 * The pure core behind `edgeBootUser` (29-edge-shell-boot-journey.spec.ts): given one shell
 * document, what did this attempt actually observe, and how long must the next one wait.
 *
 * It lives apart from the spec because the thing worth testing here is the classification, and a
 * classification that can only be exercised by booting a browser against a deployed preview is one
 * nobody checks. Same split as `_setup/preview-ready-policy.cjs` — the harness's policy is a module,
 * the Playwright half is the I/O around it.
 */

/** The edge-resolved identity half of `window.__BOOT__`, as the test process reads it back. */
export type BootUser = Record<string, unknown>;

/**
 * The worker's injected payload, as `bootScriptTag` emits it (`worker/features/flagship/
 * shell-boot.ts`). `JSON.stringify` output is `<`-escaped there, so no payload value can carry a
 * literal `</script>` — the lazy match cannot terminate early on user content.
 */
const INJECTED_BOOT = /window\.__BOOT__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i;

/**
 * One never-hang window (`SHELL_BOOT_READ_TIMEOUT`, `worker/features/flagship/shell-boot-route.ts`,
 * 1s) plus margin. A retry issued sooner than the bound it is retrying cannot outlive the timeout
 * that degraded the previous read, so anything at or under 1s makes the loop one sample wearing
 * three hats rather than three independent reads.
 */
export const EDGE_BOOT_RETRY_DELAY_MS = 1_200;

/**
 * What one read of the shell document yielded. The three unusable modes cost very different things
 * to chase, which is the whole reason they are separate: a degraded guard is an edge-side timeout
 * (ADR 0179 §4), a null `user` is the session not reaching the worker, and an unreadable payload is
 * this harness's own matcher having drifted from `bootScriptTag`.
 */
export type EdgeBootAttempt =
	| {readonly outcome: "resolved"; readonly user: BootUser}
	| {readonly outcome: "unusable"; readonly reason: string};

/**
 * Classify attempt number `attempt` (1-based — the number reads straight out of the thrown message)
 * from the shell document it fetched.
 */
export function classifyEdgeBootAttempt(attempt: number, html: string): EdgeBootAttempt {
	const injected = INJECTED_BOOT.exec(html);
	if (!injected) {
		return {
			outcome: "unusable",
			reason: html.includes("window.__BOOT__")
				? `#${attempt}: the document carried a window.__BOOT__ this harness's matcher could not read — it has drifted from bootScriptTag`
				: `#${attempt}: the document carried no window.__BOOT__ at all — the never-hang guard degraded`,
		};
	}
	const {user} = JSON.parse(injected[1]) as {user: BootUser | null};
	if (user) return {outcome: "resolved", user};
	return {
		outcome: "unusable",
		reason: `#${attempt}: the edge resolved __BOOT__.user as null — the sign-up session did not reach it`,
	};
}

/**
 * The message thrown once every attempt came back unusable. It carries each attempt's own reason
 * rather than the last one seen, so a red names which modes the loop actually hit — the difference
 * between "the spec's wait is too short" and "the edge really does drop `__BOOT__.user`", which no
 * single overwritten string could tell apart.
 */
export function formatEdgeBootFailure(reasons: readonly string[]): string {
	return `edgeBootUser: ${reasons.length} attempts, none usable — ${reasons.join("; ")}`;
}
