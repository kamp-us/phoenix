import type {PiDeliveryMode} from "../agent-chat-bridge";
import type {ConnectionState} from "./types";

/**
 * How a send is delivered, independent of how the composer looks.
 *
 * - `as-picked` — send exactly what the delivery picker holds, whatever the harness is doing.
 * - `queue-while-working` — the picker only applies while the harness is working, and a `prompt`
 *   picked there queues as a `follow_up` instead of interrupting the run. A send at any other
 *   connection state is always a fresh `prompt`.
 */
export type AgentChatDeliveryRule = "as-picked" | "queue-while-working";

export function requestedDelivery(
	rule: AgentChatDeliveryRule,
	connection: ConnectionState,
	picked: PiDeliveryMode,
): PiDeliveryMode {
	if (rule === "as-picked") return picked;
	if (connection !== "working") return "prompt";
	return picked === "prompt" ? "follow_up" : picked;
}
