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
} from "./ChatWindow.tsx";
export {type ComposerBridge, type ComposerHandlers, composerBridge} from "./composer-bridge.ts";
export {tuvalDesignMessages, tuvalDesignTranslate} from "./copy.ts";
export {isWorking, phaseLine, phaseLines} from "./phase.ts";
export {
	type ChatRow,
	type ChatRowsInput,
	chatRows,
	mergeOlder,
	oldestLoadedId,
	rowIndexOfItem,
	rowKey,
} from "./rows.ts";
export {asChatView, type ChatView, initialChatView} from "./view.ts";
