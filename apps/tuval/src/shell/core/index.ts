/** The shell's core machine: workspaces, focus, per-window view state and the prefix. */

export {
	applyMsg,
	cellsFor,
	initialState,
	type ShellCells,
	type ShellCmd,
	type ShellCoreOptions,
	type ShellMsg,
	type Step,
	shellCore,
} from "./machine.ts";
export {
	activeWorkspace,
	disarmed,
	hasWindow,
	isPrefixSnapshot,
	isShellState,
	isWorkspace,
	type MintedIds,
	mint,
	type PrefixSnapshot,
	processOf,
	type ShellState,
	type Workspace,
	type WorkspaceId,
	windowIds,
	withActive,
	withoutViews,
} from "./state.ts";
