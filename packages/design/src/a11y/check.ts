/**
 * The invariant checker for the property-based a11y loop — see
 * `.patterns/property-based-a11y.md`. Only the jsdom-decidable invariants run here;
 * the geometry/paint ones (contrast, tap-target) never assert per render.
 */
import axe from "axe-core";
import type {InvariantId} from "./posture.ts";
import type {InteractiveSpec, PrimitiveSpec} from "./registry.tsx";

export type {InvariantId, Posture} from "./posture.ts";
// Re-exported because this module is the package's `./a11y` entry point: a consumer running the
// invariants over its own composed markup (apps/tuval's chat window, #7610) needs the spec type to
// name what it is checking, and the registry itself is not a public entry.
export type {InteractiveSpec, PresentationalSpec, PrimitiveSpec} from "./registry.tsx";

export interface InvariantViolation {
	readonly id: InvariantId;
	readonly detail: string;
}

// axe rules that assert an accessible NAME on a control (jsdom-decidable).
const NAME_RULES = new Set([
	"button-name",
	"link-name",
	"input-button-name",
	"image-alt",
	"role-img-alt",
	"svg-img-alt",
	"label",
	"aria-command-name",
	"aria-toggle-field-name",
	"aria-input-field-name",
	"aria-tooltip-name",
]);

// axe rules that assert ARIA/role validity (jsdom-decidable).
const ARIA_RULES = [
	"aria-allowed-attr",
	"aria-allowed-role",
	"aria-required-attr",
	"aria-required-children",
	"aria-required-parent",
	"aria-roles",
	"aria-valid-attr",
	"aria-valid-attr-value",
	"aria-hidden-focus",
	"aria-prohibited-attr",
	"nested-interactive",
	"presentation-role-conflict",
];

const ENFORCED_AXE_RULES = [...NAME_RULES, ...ARIA_RULES];

const invariantForRule = (ruleId: string): InvariantId =>
	NAME_RULES.has(ruleId) ? "accessible-name" : "valid-aria";

const axeOptions: axe.RunOptions = {
	runOnly: {type: "rule", values: ENFORCED_AXE_RULES},
	// jsdom renders no visible layout; `resultTypes: ["violations"]` skips the
	// expensive incomplete/pass bookkeeping we do not consume.
	resultTypes: ["violations"],
};

/**
 * The keyboard-operability probe: an ENABLED interactive control must take focus.
 * A disabled/loading control is intentionally unfocusable, so it is exempt — the
 * invariant is "an operable control is reachable", not "every element is focusable".
 */
const checkFocusable = (root: HTMLElement, spec: InteractiveSpec): InvariantViolation | null => {
	const el = root.querySelector<HTMLElement>(spec.selector);
	if (!el) {
		return {id: "focusable", detail: `no element matched selector "${spec.selector}"`};
	}
	const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
	if (disabled) return null;
	el.focus();
	if (el.ownerDocument.activeElement !== el) {
		return {
			id: "focusable",
			detail: `enabled ${el.tagName.toLowerCase()} did not receive focus (tabindex=${el.tabIndex})`,
		};
	}
	return null;
};

export const runEnforcedInvariants = async (
	root: HTMLElement,
	spec: PrimitiveSpec,
): Promise<ReadonlyArray<InvariantViolation>> => {
	if (spec.kind === "deferred") return [];
	const violations: Array<InvariantViolation> = [];

	const results = await axe.run(root, axeOptions);
	for (const v of results.violations) {
		const nodes = v.nodes.map((n) => n.html).join(" · ");
		violations.push({id: invariantForRule(v.id), detail: `${v.id}: ${v.help} [${nodes}]`});
	}

	if (spec.kind === "interactive") {
		const f = checkFocusable(root, spec);
		if (f) violations.push(f);
	}

	return violations;
};
