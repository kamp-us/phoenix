import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {MetaRow} from "./MetaRow";

describe("MetaRow — the metadata-row primitive (#2163)", () => {
	it("renders the shared row shell and passes through a feature className", () => {
		const {container} = render(<MetaRow className="kp-pano-post__meta">x</MetaRow>);
		const el = container.firstElementChild!;
		expect(el.classList.contains("kp-meta-row")).toBe(true);
		expect(el.classList.contains("kp-pano-post__meta")).toBe(true);
	});

	it("renders as the requested element (footer)", () => {
		const {container} = render(<MetaRow as="footer">x</MetaRow>);
		expect(container.querySelector("footer.kp-meta-row")).not.toBeNull();
	});

	it("Dot renders a decorative separator hidden from assistive tech", () => {
		const {container} = render(
			<MetaRow>
				a<MetaRow.Dot />b
			</MetaRow>,
		);
		const dot = container.querySelector(".kp-meta-row__dot")!;
		expect(dot).not.toBeNull();
		expect(dot.getAttribute("aria-hidden")).toBe("true");
		expect(dot.textContent).toBe("·");
	});
});
