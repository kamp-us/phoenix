import {Schema} from "effect";
import type {PermissionDecision, PermissionRequest} from "../ai-agent/ports/index.ts";
import {Approval} from "./protocol.ts";
import type {RequestId} from "./transport.ts";

export interface PendingApproval {
	readonly id: RequestId;
	readonly method: string;
	readonly detail: PermissionRequest;
	decision: PermissionDecision | null;
}

export const permissionCard = (method: string, params: unknown): PermissionRequest => {
	const detail = Schema.decodeUnknownSync(Approval)(params);
	return {
		title: "Codex needs permission",
		displayName:
			method === "item/commandExecution/requestApproval"
				? "Run command"
				: method === "item/fileChange/requestApproval"
					? "Change files"
					: "Grant permissions",
		description:
			detail.reason ?? detail.command ?? "Review the requested access before allowing it.",
		input: Schema.decodeUnknownSync(Schema.Json)(params),
		offersAlways: false,
	};
};

export const permissionReply = (
	pending: PendingApproval,
	decision: PermissionDecision,
): unknown => {
	if (pending.method === "item/permissions/requestApproval") {
		const input = Schema.decodeUnknownSync(Schema.Struct({permissions: Schema.Json}))(
			pending.detail.input,
		);
		return {permissions: decision === "allow-once" ? input.permissions : {}, scope: "turn"};
	}
	return {decision: decision === "allow-once" ? "accept" : "decline"};
};

// Item IDs survive resume; RPC IDs do not. Multiple approvals for one item get separate cards in order.
export class PendingApprovals {
	readonly queues = new Map<string, Array<PendingApproval>>();

	add(itemId: string, pending: PendingApproval): boolean {
		const queue = this.queues.get(itemId) ?? [];
		queue.push(pending);
		this.queues.set(itemId, queue);
		return queue.length === 1;
	}

	get(itemId: string): PendingApproval | undefined {
		return this.queues.get(itemId)?.[0];
	}

	resolve(
		id: RequestId,
	): {request: string; decision: PermissionDecision; next?: PendingApproval} | null {
		for (const [request, queue] of this.queues) {
			const index = queue.findIndex((pending) => pending.id === id);
			if (index < 0) continue;
			const removed = queue.splice(index, 1)[0];
			if (queue.length === 0) this.queues.delete(request);
			if (index !== 0 || removed === undefined) return null;
			const next = queue[0];
			return {request, decision: removed.decision ?? "deny", ...(next === undefined ? {} : {next})};
		}
		return null;
	}

	clear(): ReadonlyArray<{request: string; decision: PermissionDecision}> {
		const resolved = [...this.queues].map(([request, queue]) => ({
			request,
			decision: queue[0]?.decision ?? ("deny" as const),
		}));
		this.queues.clear();
		return resolved;
	}
}
