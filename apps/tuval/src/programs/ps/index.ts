/** The `ps` program: the registry row, its window renderer, and the pure order behind the table. */

export {
	ATTACH_SPELL_PATH,
	type AttachArgs,
	attachArgs,
	callAttach,
	type SpellCaller,
} from "./attach.ts";
export {
	NO_PARENT,
	type PsColumn,
	type PsColumnId,
	portSummary,
	psColumn,
	psColumnOrder,
	psColumns,
	type SortKey,
} from "./columns.ts";
export {
	defaultOrder,
	orderedRows,
	resolveSelection,
	type SortDirection,
	sortRows,
} from "./order.ts";
export {PsTable, type PsTableProps} from "./PsTable.tsx";
export {PS_RENDERER_REF, psId, psProgram, psRendererRef} from "./program.ts";
export {psReactRenderer, psWindowRenderer} from "./renderer.tsx";
export {
	type PsSource,
	PsSourceProvider,
	type PsSourceProviderProps,
	usePsSource,
} from "./source.tsx";
export {
	applyPsMsg,
	isPsState,
	type PsMsg,
	type PsState,
	psCore,
	psInitialState,
	psSelect,
	psSortBy,
	psStateFrom,
} from "./state.ts";
