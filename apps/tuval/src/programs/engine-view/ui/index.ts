/** The engine view's browser half. Importing this pulls React and `@xyflow/react`; `../index.ts` does not. */

export {type DeskAccess, DeskAccessProvider, type SpellCaller, useDeskAccess} from "./desk.tsx";
export {
	ATTACH_SPELL_PATH,
	EngineViewCanvas,
	type EngineViewCanvasProps,
} from "./EngineViewCanvas.tsx";
export {
	PROCESS_NODE_TYPE,
	type ProcessFlowNode,
	ProcessNode,
	type ProcessNodeData,
	type ProcessPortLine,
} from "./ProcessNode.tsx";
export {useProcessState} from "./process-state.ts";
export {
	type EngineViewHost,
	engineViewReactRenderer,
	engineViewRenderer,
} from "./renderer.tsx";
