import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Card, Surface} from "./Card";

describe("Surface / Card — the composite shell primitive (#2163)", () => {
	it("emits only the role-token classes for the props it is given (flat default)", () => {
		const {container} = render(<Surface>x</Surface>);
		const el = container.firstElementChild!;
		expect(el.classList.contains("kp-surface")).toBe(true);
		expect(el.classList.contains("kp-surface--tone-default")).toBe(true);
		// flat / no-radius / no-pad / no-border carry no class
		expect(el.className).not.toMatch(/kp-surface--elev-/);
		expect(el.className).not.toMatch(/kp-surface--radius-/);
		expect(el.className).not.toMatch(/kp-surface--pad-/);
		expect(el.classList.contains("kp-surface--border")).toBe(false);
	});

	it("maps tone / elevation / radius / padding / border onto their token classes", () => {
		const {container} = render(
			<Surface tone="raised" elevation="dropdown" radius="sm" padding="lg" border />,
		);
		const el = container.firstElementChild!;
		expect(el.classList.contains("kp-surface--tone-raised")).toBe(true);
		expect(el.classList.contains("kp-surface--elev-dropdown")).toBe(true);
		expect(el.classList.contains("kp-surface--radius-sm")).toBe(true);
		expect(el.classList.contains("kp-surface--pad-lg")).toBe(true);
		expect(el.classList.contains("kp-surface--border")).toBe(true);
	});

	it("renders as the requested element and passes through attributes + className", () => {
		const {container} = render(
			<Surface as="article" className="kp-feature" data-testid="s" aria-label="k" />,
		);
		const el = container.querySelector("article")!;
		expect(el).not.toBeNull();
		expect(el.getAttribute("data-testid")).toBe("s");
		expect(el.getAttribute("aria-label")).toBe("k");
		expect(el.classList.contains("kp-feature")).toBe(true);
	});

	it("Card is the opinionated bordered/raised/padded default, overridable by props", () => {
		const {container} = render(<Card interactive>c</Card>);
		const el = container.firstElementChild!;
		expect(el.classList.contains("kp-card")).toBe(true);
		expect(el.classList.contains("kp-card--interactive")).toBe(true);
		expect(el.classList.contains("kp-surface--border")).toBe(true);
		expect(el.classList.contains("kp-surface--radius-md")).toBe(true);
		expect(el.classList.contains("kp-surface--elev-raised")).toBe(true);
	});

	it("Card lets a prop override a default (radius)", () => {
		const {container} = render(<Card radius="sm">c</Card>);
		const el = container.firstElementChild!;
		expect(el.classList.contains("kp-surface--radius-sm")).toBe(true);
		expect(el.classList.contains("kp-surface--radius-md")).toBe(false);
	});
});
