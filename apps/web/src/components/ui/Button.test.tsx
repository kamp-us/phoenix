import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Button} from "./Button";

describe("Button — the widened primitive (#2163)", () => {
	it("keeps its baseline behavior when the new props are unset (no extra attrs/nodes)", () => {
		const {container} = render(<Button variant="primary">tamam</Button>);
		const btn = container.querySelector("button")!;
		expect(btn.getAttribute("type")).toBe("button");
		expect(btn.classList.contains("kp-btn")).toBe(true);
		expect(btn.getAttribute("data-variant")).toBe("primary");
		expect(btn.hasAttribute("aria-pressed")).toBe(false);
		expect(btn.hasAttribute("aria-busy")).toBe(false);
		expect(btn.hasAttribute("disabled")).toBe(false);
		expect(container.querySelector(".kp-btn__icon")).toBeNull();
		expect(container.querySelector('[data-part="spinner"]')).toBeNull();
	});

	it("pressed sets aria-pressed", () => {
		const {container} = render(<Button pressed>x</Button>);
		const btn = container.querySelector("button")!;
		expect(btn.getAttribute("aria-pressed")).toBe("true");
	});

	it("icon renders in a leading decorative slot", () => {
		const {container, getByTestId} = render(
			<Button icon={<span data-testid="g">g</span>}>kaydet</Button>,
		);
		const slot = container.querySelector(".kp-btn__icon")!;
		expect(slot).not.toBeNull();
		expect(slot.getAttribute("aria-hidden")).toBe("true");
		expect(getByTestId("g")).not.toBeNull();
	});

	it("loading disables, marks aria-busy, shows the spinner, and keeps the label", () => {
		const {container} = render(<Button loading>kaydet</Button>);
		const btn = container.querySelector("button")!;
		expect(btn.getAttribute("aria-busy")).toBe("true");
		expect(btn.hasAttribute("disabled")).toBe(true);
		expect(container.querySelector('[data-part="spinner"]')).not.toBeNull();
		expect(container.querySelector(".kp-btn__icon")).toBeNull();
		expect(btn.textContent).toContain("kaydet");
	});
});

// A paint fact jsdom cannot compute, so it is locked at the stylesheet SOURCE — the idiom the
// topbar's accent axis uses. The control-leading rule is ONLY load-bearing at 0-3-0: written
// any weaker (folded back into the `:where()` base, which is 0-1-0) every feature sheet that
// sets `font: var(--t-*)` on a button silently drags the 1.45 prose leading back in, because
// `font` is a shorthand that resets line-height. That failure is invisible in a unit test and
// showed up across a dozen buttons, so the weight itself is what gets pinned here.
describe("Button control leading (the `font:` shorthand trap)", () => {
	// The path goes through a variable so Vite does not statically rewrite
	// `new URL(..., import.meta.url)` into an asset URL — the entry-row-spine idiom.
	const readSource = (rel: string): string =>
		readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
	const BUTTON_CSS = readSource("./Button.css");
	const ruleFor = (selector: string) =>
		BUTTON_CSS.match(
			new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`),
		);

	it("declares line-height at the anatomy's own weight, not inside the :where() base", () => {
		const control = ruleFor('.kp-btn[data-scope="button"][data-part="root"]');
		expect(control).not.toBeNull();
		expect(control?.[1]).toMatch(/line-height:\s*1\b/);
		// The base rule must NOT carry it: there it would be 0-1-0 and lose to feature classes.
		const base = ruleFor('.kp-btn:where([data-scope="button"][data-part="root"])');
		expect(base).not.toBeNull();
		expect(base?.[1]).not.toMatch(/line-height/);
	});

	it("lets the link variant opt back out, since it sits in running text", () => {
		const link = ruleFor(
			'.kp-btn[data-scope="button"][data-part="root"]:where([data-variant="link"])',
		);
		expect(link).not.toBeNull();
		expect(link?.[1]).toMatch(/line-height:\s*inherit/);
	});
});
