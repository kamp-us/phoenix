import {render, screen} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {AgentChatInput} from "../AgentChatInput";
import {useAgentChatInput} from "./Root";

function Part() {
	const {variant, connection} = useAgentChatInput();
	return <p>{`${variant}/${connection}`}</p>;
}

describe("AgentChatInput.Root", () => {
	it("names itself when a part is rendered outside a Root", () => {
		// React re-throws through its own logging, which is noise rather than a second failure.
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(() => render(<Part />)).toThrow(
			"AgentChatInput parts must be rendered inside <AgentChatInput.Root>.",
		);
		logged.mockRestore();
	});

	it("provides its state to a part rendered inside it", () => {
		render(
			<AgentChatInput.Root variant="focused">
				<Part />
			</AgentChatInput.Root>,
		);
		expect(screen.getByText("focused/loading")).toBeTruthy();
	});
});
