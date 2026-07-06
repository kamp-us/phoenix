/**
 * The warning-to-enforced posture registry — the promotion half of the
 * property-based a11y loop (#2175, ADR 0162 pillar 4).
 *
 * Each a11y invariant the harness checks carries a `posture`: `enforced` (a
 * violation fails the gate) or `warning` (a violation is reported but does not
 * fail). This is the *promotion loop*: an invariant that a reviewer keeps
 * catching by hand starts as a `warning` here, and is graduated to `enforced` —
 * a one-line, deliberate, reviewed edit to this map — once every current `ui/`
 * primitive holds it, turning a recurring miss into a standing guardrail.
 *
 * WHY two postures, not one: the harness runs in jsdom, which has no layout
 * engine and does not apply real CSS. Name/role/ARIA/focusability are fully
 * decidable there, so they are `enforced` from day one. Contrast and tap-target
 * are geometry/paint facts jsdom cannot compute (getBoundingClientRect is 0,
 * computed colors are unresolved) — asserting them here would be a false gate,
 * so they start `warning` and are promotion candidates for a real-browser
 * (Playwright) a11y pass, not a jsdom flip.
 *
 * PROMOTION PROCEDURE (documented, so a promotion is a conscious ratchet):
 *   1. Confirm every classified `ui/` primitive already satisfies the invariant
 *      (run `pnpm --filter @kampus/web test:a11y` — no warning lines for it).
 *   2. Flip its entry below from `"warning"` to `"enforced"` in one commit.
 *   3. From then on a regression on ANY primitive fails the gate — the miss is
 *      now a permanent guardrail.
 * Demotion (enforced → warning) is the escape hatch and must never be used to
 * route around a real failure; fix the primitive instead.
 */

export type Posture = "enforced" | "warning";

/** The a11y invariants the harness asserts over each primitive's rendered DOM. */
export type InvariantId =
	| "accessible-name"
	| "valid-aria"
	| "focusable"
	| "color-contrast"
	| "tap-target";

export interface InvariantMeta {
	readonly id: InvariantId;
	readonly posture: Posture;
	/** One-line description — the ADR 0162 pillar-4 rule this invariant enforces. */
	readonly rule: string;
}

/**
 * The single source of posture for every invariant. Enforced invariants are the
 * jsdom-decidable pillar-4 rules (name, ARIA, focusability); the geometry/paint
 * rules (contrast, tap-target) start as warnings — promotion candidates for a
 * real-browser pass — because jsdom cannot compute them.
 */
export const POSTURE: Readonly<Record<InvariantId, InvariantMeta>> = {
	"accessible-name": {
		id: "accessible-name",
		posture: "enforced",
		rule: "every interactive control exposes a non-empty accessible name",
	},
	"valid-aria": {
		id: "valid-aria",
		posture: "enforced",
		rule: "roles and ARIA attributes are valid, allowed, and non-conflicting",
	},
	focusable: {
		id: "focusable",
		posture: "enforced",
		rule: "an enabled interactive control is keyboard-focusable",
	},
	"color-contrast": {
		id: "color-contrast",
		// jsdom applies no CSS → computed colors are unresolved. A promotion
		// candidate for a real-browser (Playwright) pass, not a jsdom flip.
		posture: "warning",
		rule: "text and non-text UI clear the AA/3:1 contrast floors (ADR 0162)",
	},
	"tap-target": {
		id: "tap-target",
		// jsdom has no layout engine → getBoundingClientRect is 0. Promotion
		// candidate for a real-browser pass.
		posture: "warning",
		rule: "interactive controls meet the ≥36px hit-area minimum (ADR 0162)",
	},
} as const;

export const postureOf = (id: InvariantId): Posture => POSTURE[id].posture;
