import {render, screen} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {EmptyState} from "./EmptyState";

describe("EmptyState — the inline empty-state primitive (#2162)", () => {
	it("renders the title, and only the slots it is given", () => {
		const {container} = render(<EmptyState title="henüz yorum yok." />);
		expect(screen.getByText("henüz yorum yok.")).not.toBeNull();
		expect(container.querySelector(".kp-empty-state__description")).toBeNull();
		expect(container.querySelector(".kp-empty-state__icon")).toBeNull();
		expect(container.querySelector(".kp-empty-state__action")).toBeNull();
	});

	it("renders the description, icon, and action slots when provided", () => {
		render(
			<EmptyState
				icon={<span data-testid="glyph">✦</span>}
				title="henüz başlık yok."
				description="ilk başlığı sen aç."
				action={<button type="button">başlık aç</button>}
			/>,
		);
		expect(screen.getByText("ilk başlığı sen aç.")).not.toBeNull();
		expect(screen.getByTestId("glyph")).not.toBeNull();
		expect(screen.getByRole("button", {name: "başlık aç"})).not.toBeNull();
	});

	it("hides the icon slot from assistive tech (decorative)", () => {
		const {container} = render(<EmptyState icon={<span>✦</span>} title="boş" />);
		const icon = container.querySelector(".kp-empty-state__icon");
		expect(icon?.getAttribute("aria-hidden")).toBe("true");
	});
});
