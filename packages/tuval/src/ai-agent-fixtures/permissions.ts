/**
 * Permission-card builders, for every tier that puts one in a session state.
 *
 * It lives beside the transcript builders rather than under `src/ai-agent/` for their reason: the
 * modules under test are the ones that own these shapes, and a fixture they imported would be a
 * second source for the type they declare.
 */

import type {
	PendingPermission,
	PermissionProgress,
	PermissionRequest,
} from "../ai-agent/ports/index.ts";

export const permissionCard = (overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
	title: "Run a command",
	displayName: "bash",
	description: "The agent wants to run a shell command in the project.",
	input: {command: "rm -rf build"},
	offersAlways: true,
	...overrides,
});

/** One entry of `state.permissions`. `seq` defaults to the first raising of a fresh session. */
export const pendingPermission = (
	overrides: {
		readonly request?: PermissionRequest;
		readonly seq?: number;
		readonly progress?: PermissionProgress;
	} = {},
): PendingPermission => ({
	request: overrides.request ?? permissionCard(),
	seq: overrides.seq ?? 1,
	progress: overrides.progress ?? {status: "open"},
});
