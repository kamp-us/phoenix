import {render, screen, waitFor, within} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {ExhibitStage} from "../ExhibitStage";
import {getExhibit} from "../registry";

// The atölye shows the composer both ways — taken whole and assembled from its compound parts —
// and the parts one is only worth showing if it draws the same composer. A part rendered outside a
// Root throws, so a broken assembly is a blank stage rather than a wrong-looking one.
describe("Agent Chat Input exhibits — whole and composed from parts", () => {
	it.each([
		["agent-chat-input"],
		["agent-chat-input-parts"],
	])("renders the composer on the %s stage", async (id) => {
		const exhibit = getExhibit(id);
		expect(exhibit).toBeDefined();

		render(<ExhibitStage exhibit={exhibit!} />);
		const stage = screen.getByTestId("exhibit-stage");

		const composer = await waitFor(() => within(stage).getByTestId("agent-chat-input"));
		expect(within(composer).getByLabelText("Pi'ye mesaj yaz")).toBeTruthy();
	});
});
