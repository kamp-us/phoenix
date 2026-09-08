/**
 * The shared chat window as a program's renderer table imports it. Importing this pulls React,
 * `@kampus/design` and the virtualizer — and nothing from `../../ai-agent/` at runtime, because
 * every agent type this window reads is imported as a type. `boundary.unit.test.ts` holds that.
 */

export {
	type ChatWindowHost,
	type ChatWindowOptions,
	type ChatWindowRenderer,
	chatWindow,
	type ThinChatWindowOptions,
} from "./ChatWindow.tsx";
export {type ComposerBridge, type ComposerHandlers, composerBridge} from "./composer-bridge.ts";
export {tuvalDesignMessages, tuvalDesignTranslate} from "./copy.ts";
export {ModeSwitch} from "./ModeSwitch.tsx";
export {type PermissionAnswer, PermissionCards} from "./PermissionCards.tsx";
export {isWorking, phaseLine, phaseLines, statusLine} from "./phase.ts";
export {type QueuedMessage, QueuedMessages} from "./QueuedMessages.tsx";
export {
	type ChatRow,
	type ChatRowsInput,
	chatRows,
	mergeOlder,
	oldestLoadedId,
	type RowItem,
	rowIndexOfItem,
	rowKey,
	type SessionRun,
	type ToolRun,
} from "./rows.ts";
export {SessionRow} from "./SessionRow.tsx";
export {ToolRow} from "./ToolRow.tsx";
export {ToolRunRow} from "./ToolRunRow.tsx";
export {
	type DiffLine,
	diffLines,
	omissionLine,
	type ToolAction,
	type ToolDetail,
	type ToolShape,
	toolDetail,
	toolShape,
} from "./tool-detail.ts";
export {runSentence, runStatus, runStatusWord} from "./tool-run.ts";
export {asChatView, type ChatView, initialChatView} from "./view.ts";
