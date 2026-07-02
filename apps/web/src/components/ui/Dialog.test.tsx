/**
 * Pins the shared Dialog.Body empty-collapse contract (#1638): a delete-confirm
 * dialog whose body renders only on error must NOT paint a hollow padded band
 * between head and foot when there's no error. Body renders nothing when empty,
 * and still renders its content (role="alert" error) when present — the guard the
 * pano/sözlük delete-confirm surfaces and DeleteAccountDialog/VouchSheet rely on.
 */
import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {Dialog} from "./Dialog";

describe("Dialog.Body — empty collapses, content renders", () => {
	it("renders nothing (no padded box) when it has no children", () => {
		const {container} = render(<Dialog.Body>{null}</Dialog.Body>);
		expect(container.querySelector(".kp-dialog__body")).toBeNull();
	});

	it("renders nothing when a conditional child evaluates to false", () => {
		const hasError = false;
		const {container} = render(<Dialog.Body>{hasError ? <p>err</p> : null}</Dialog.Body>);
		expect(container.querySelector(".kp-dialog__body")).toBeNull();
	});

	it("renders the padded body when it has content", () => {
		const {container, getByRole} = render(
			<Dialog.Body>
				<p role="alert">bir şeyler ters gitti</p>
			</Dialog.Body>,
		);
		expect(container.querySelector(".kp-dialog__body")).not.toBeNull();
		expect(getByRole("alert").textContent).toBe("bir şeyler ters gitti");
	});
});
