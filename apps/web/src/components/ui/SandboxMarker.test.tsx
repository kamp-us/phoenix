/**
 * `SandboxMarker` render contract (#6427, epic #4306): the badge the pure `sandboxMarker`
 * ruling names is the badge that lands in the DOM, the çaylak marker carries its meaning as
 * announced text rather than colour, and the flag-off wire shape renders nothing at all.
 * The decision table itself is pinned DOM-free in `sandbox-marker.unit.test.ts`.
 */
import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {SandboxMarker} from "./SandboxMarker";

describe("SandboxMarker (#6427)", () => {
	it("renders the çaylak marker on somebody else's hazırlık-stage item", () => {
		render(<SandboxMarker isOwn={false} sandboxedInPlace={true} />);
		expect(screen.getByTestId("caylak-badge").textContent).toBe(
			"çaylak katkısı, hazırlık aşamasında",
		);
		expect(screen.queryByTestId("incelemede-badge")).toBeNull();
	});

	it("leaves the owner's incelemede badge exactly as it was", () => {
		render(<SandboxMarker isOwn={true} sandboxed={true} />);
		expect(screen.getByTestId("incelemede-badge").textContent).toBe("incelemede");
		expect(screen.queryByTestId("caylak-badge")).toBeNull();
	});

	it("renders the owner's badge alone when both fields are true on one item", () => {
		render(<SandboxMarker isOwn={true} sandboxed={true} sandboxedInPlace={true} />);
		expect(screen.getByTestId("incelemede-badge")).toBeTruthy();
		expect(screen.queryByTestId("caylak-badge")).toBeNull();
	});

	it("renders nothing when the wire field is false", () => {
		const {container} = render(
			<SandboxMarker isOwn={false} sandboxed={false} sandboxedInPlace={false} />,
		);
		expect(container.innerHTML).toBe("");
	});

	// Flag off ⇒ the resolver never widens the viewer, so the field arrives false (or, on a
	// read that doesn't stamp it, absent) and no marker exists to render.
	it("renders nothing for the flag-off wire shape, field false or absent", () => {
		const off = render(<SandboxMarker isOwn={false} sandboxedInPlace={false} />);
		expect(off.container.innerHTML).toBe("");
		const absent = render(<SandboxMarker isOwn={false} />);
		expect(absent.container.innerHTML).toBe("");
	});

	it("announces the marker as text, so it never leans on colour alone", () => {
		render(<SandboxMarker isOwn={false} sandboxedInPlace={true} />);
		const badge = screen.getByTestId("caylak-badge");
		expect(badge.textContent).toContain("çaylak");
		expect(badge.querySelector(".kp-visually-hidden")?.textContent).toBe(", hazırlık aşamasında");
	});
});
