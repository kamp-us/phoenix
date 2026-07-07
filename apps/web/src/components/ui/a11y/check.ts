/**
 * The invariant checker for the property-based a11y loop (#2175, ADR 0162 pillar
 * 4): given one rendered primitive, run the jsdom-decidable pillar-4 invariants
 * and return the violations. The geometry/paint invariants (contrast, tap-target)
 * are NOT run here — jsdom has no layout engine and applies no CSS, so they are
 * reported once per primitive as warnings by the suite (see `posture.ts`), never
 * asserted per render.
 *
 * axe is the engine for name + ARIA correctness; its violations are bucketed onto
 * the `accessible-name` / `valid-aria` invariant ids. `focusable` is a direct DOM
 * probe (focus the control, read `document.activeElement`) — the honest test of
 * keyboard operability, which axe alone does not assert.
 */
import axe from "axe-core";
import type {InvariantId} from "./posture.ts";
import type {InteractiveSpec, PrimitiveSpec} from "./registry.tsx";

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

/** Map an axe rule id onto the invariant it belongs to (name rules → accessible-name). */
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

/** Run the enforced (jsdom-decidable) pillar-4 invariants; [] means clean. */
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
