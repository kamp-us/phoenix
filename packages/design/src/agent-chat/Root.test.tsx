import {act, fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {AgentChatInput} from "../AgentChatInput";
import type {AgentChatInputBridge, PiDeliveryMode} from "../agent-chat-bridge";
import type {AgentChatDeliveryRule} from "./delivery";
import {useAgentChatInput} from "./Root";
import type {ConnectionState} from "./types";

type SentPrompt = Parameters<AgentChatInputBridge["sendPiPrompt"]>[0];

function Part() {
	const {variant, connection} = useAgentChatInput();
	return <p>{`${variant}/${connection}`}</p>;
}

/**
 * A bridge parked in one connection state. `loading` is the load that never answers, which is the
 * state the composer mounts in; `unavailable` is the load that rejects.
 */
function bridgeAt(connection: ConnectionState): {
	bridge: AgentChatInputBridge;
	sent: SentPrompt[];
} {
	const sent: SentPrompt[] = [];
	const state = async (): Promise<Record<string, unknown>> => {
		if (connection === "loading") return new Promise<never>(() => undefined);
		if (connection === "unavailable") throw new Error("no harness");
		return {isStreaming: connection === "working"};
	};
	const bridge: AgentChatInputBridge = {
		loadPiState: state,
		loadPiCommands: async () => [],
		loadPiModels: async () => [],
		loadPiThinkingLevels: async () => [],
		loadPiFiles: async () => [],
		setPiModel: async () => undefined,
		setPiThinkingLevel: async () => undefined,
		setPiProjectTrust: async () => undefined,
		sendPiPrompt: async (options) => {
			sent.push(options);
		},
		abortPi: async () => undefined,
		answerPiExtension: async () => undefined,
		subscribeToPiEvents: () => () => undefined,
	};
	return {bridge, sent};
}

function Composer({picked}: {readonly picked: PiDeliveryMode}) {
	const {connection, setDelivery, typeDraft, submit} = useAgentChatInput();
	return (
		<>
			<p data-testid="connection">{connection}</p>
			<button
				type="button"
				onClick={() => {
					typeDraft("Ship it.");
					setDelivery(picked);
				}}
			>
				compose
			</button>
			<button type="button" onClick={() => void submit()}>
				send
			</button>
		</>
	);
}

async function send(options: {
	readonly connection: ConnectionState;
	readonly picked: PiDeliveryMode;
	readonly variant?: "harness" | "focused";
	readonly deliveryRule?: AgentChatDeliveryRule;
}): Promise<SentPrompt[]> {
	const {bridge, sent} = bridgeAt(options.connection);
	render(
		<AgentChatInput.Root
			bridge={bridge}
			variant={options.variant}
			deliveryRule={options.deliveryRule}
		>
			<Composer picked={options.picked} />
		</AgentChatInput.Root>,
	);
	await waitFor(() =>
		expect(screen.getByTestId("connection").textContent).toBe(options.connection),
	);
	fireEvent.click(screen.getByRole("button", {name: "compose"}));
	fireEvent.click(screen.getByRole("button", {name: "send"}));
	await act(async () => undefined);
	return sent;
}

const deliveries: readonly PiDeliveryMode[] = ["prompt", "steer", "follow_up"];

/**
 * What each variant delivered before the rule was its own prop, at every connection state crossed
 * with every picker value. `undefined` is a send the composer refuses. Written out rather than
 * derived, so the table is a check on the rule and not a second copy of it.
 */
const legacy: Record<
	"focused" | "harness",
	Record<ConnectionState, Record<PiDeliveryMode, SentPrompt | undefined>>
> = {
	focused: {
		loading: {
			prompt: {type: "prompt", message: "Ship it."},
			steer: {type: "prompt", message: "Ship it."},
			follow_up: {type: "prompt", message: "Ship it."},
		},
		ready: {
			prompt: {type: "prompt", message: "Ship it."},
			steer: {type: "prompt", message: "Ship it."},
			follow_up: {type: "prompt", message: "Ship it."},
		},
		working: {
			prompt: {type: "follow_up", message: "Ship it."},
			steer: {type: "steer", message: "Ship it."},
			follow_up: {type: "follow_up", message: "Ship it."},
		},
		unavailable: {prompt: undefined, steer: undefined, follow_up: undefined},
	},
	harness: {
		loading: {
			prompt: {type: "prompt", message: "Ship it."},
			steer: {type: "steer", message: "Ship it."},
			follow_up: {type: "follow_up", message: "Ship it."},
		},
		ready: {
			prompt: {type: "prompt", message: "Ship it."},
			steer: {type: "steer", message: "Ship it."},
			follow_up: {type: "follow_up", message: "Ship it."},
		},
		working: {
			prompt: {type: "prompt", message: "Ship it.", streamingBehavior: "steer"},
			steer: {type: "steer", message: "Ship it."},
			follow_up: {type: "follow_up", message: "Ship it."},
		},
		unavailable: {prompt: undefined, steer: undefined, follow_up: undefined},
	},
};

describe("AgentChatInput.Root", () => {
	it("names itself when a part is rendered outside a Root", () => {
		// React re-throws through its own logging, which is noise rather than a second failure.
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(() => render(<Part />)).toThrow(
			"AgentChatInput parts must be rendered inside <AgentChatInput.Root>.",
		);
		logged.mockRestore();
	});

	// Every part reads Root, so every part is unusable outside one — the primitive `Control` is the
	// exception on purpose: it takes no state and is a button a host can place anywhere.
	it.each([
		["Surface", () => <AgentChatInput.Surface>body</AgentChatInput.Surface>],
		["Field", () => <AgentChatInput.Field />],
		["Toolbar", () => <AgentChatInput.Toolbar />],
		["Settings", () => <AgentChatInput.Settings />],
		["Hint", () => <AgentChatInput.Hint />],
	])("refuses %s outside a Root", (_name, Rendered) => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(() => render(<Rendered />)).toThrow(
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

describe("the send-delivery rule", () => {
	describe.each([
		"focused",
		"harness",
	] as const)("with deliveryRule unset on variant=%s", (variant) => {
		describe.each([
			"loading",
			"ready",
			"working",
			"unavailable",
		] as const)("while %s", (connection) => {
			it.each(deliveries)("delivers a picked %s as it did before the prop", async (picked) => {
				const sent = await send({connection, picked, variant});
				const expected = legacy[variant][connection][picked];
				expect(sent).toEqual(expected ? [expected] : []);
			});
		});
	});

	it("takes an explicit as-picked over the focused variant's default", async () => {
		const sent = await send({
			connection: "working",
			picked: "prompt",
			variant: "focused",
			deliveryRule: "as-picked",
		});
		expect(sent).toEqual([{type: "prompt", message: "Ship it.", streamingBehavior: "steer"}]);
	});

	it("takes an explicit queue-while-working over the harness variant's default", async () => {
		const sent = await send({
			connection: "working",
			picked: "prompt",
			variant: "harness",
			deliveryRule: "queue-while-working",
		});
		expect(sent).toEqual([{type: "follow_up", message: "Ship it."}]);
	});

	it("leaves an idle send a fresh prompt under queue-while-working", async () => {
		const sent = await send({
			connection: "ready",
			picked: "follow_up",
			variant: "harness",
			deliveryRule: "queue-while-working",
		});
		expect(sent).toEqual([{type: "prompt", message: "Ship it."}]);
	});
});
