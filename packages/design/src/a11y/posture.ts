/**
 * The warning-to-enforced posture registry — see `.patterns/property-based-a11y.md`
 * for the promotion loop. Demotion (enforced → warning) must never be used to route
 * around a real failure; fix the primitive instead.
 */

export type Posture = "enforced" | "warning";

export type InvariantId =
	| "accessible-name"
	| "valid-aria"
	| "focusable"
	| "color-contrast"
	| "tap-target";

export interface InvariantMeta {
	readonly id: InvariantId;
	readonly posture: Posture;
	/** The ADR 0162 pillar-4 rule this invariant enforces, in one line. */
	readonly rule: string;
}

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
