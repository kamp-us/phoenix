/**
 * `@kampus/aria-voice-guard` — the pure verdict for whether an `apps/web/src` file
 * introduces a Title-Case aria-label or persistent menu-item string, drifting off the
 * lowercase anti-hype Turkish voice (issue #1670). The core (`findDrift` +
 * `firstCasedIsUpper`) is a pure, IO-free, Turkish-locale-correct matcher; `bin.ts`
 * is the thin Effect CLI shell the `aria-voice-guard` CI job runs to fail the PR when
 * a new Title-Case a11y/menu string lands.
 */
export {
	type Finding,
	findDrift,
	firstCasedIsUpper,
	toLowerVoice,
} from "./aria-voice-guard.ts";
