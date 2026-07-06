/**
 * a11y regression proof (#2215): the pano vote button's accessible name must
 * TOGGLE with vote state — "Oyunu geri al" (undo) when the viewer's vote is
 * active, "Yukarı oy" otherwise — mirroring the sözlük `DefinitionCard` control.
 * A static aria-label leaves screen-reader users with stale toggle feedback.
 */
import {render} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {VoteControl} from "./PanoPost";

describe("VoteControl — vote button accessible name toggles with state (#2215)", () => {
	it('reads "Yukarı oy" when the vote is not active', () => {
		const {getByTestId} = render(<VoteControl count={3} pressed={false} testIdSuffix="p1" />);
		expect(getByTestId("post-vote-p1").getAttribute("aria-label")).toBe("Yukarı oy");
	});

	it('reads "Oyunu geri al" (the undo affordance) when the vote is active', () => {
		const {getByTestId} = render(<VoteControl count={4} pressed={true} testIdSuffix="p1" />);
		expect(getByTestId("post-vote-p1").getAttribute("aria-label")).toBe("Oyunu geri al");
	});
});
