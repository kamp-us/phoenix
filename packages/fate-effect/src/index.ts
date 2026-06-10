/**
 * `@phoenix/fate-effect` — phoenix's Effect-native fate integration.
 *
 * fate's structure with Effect's semantics: feature code keeps fate's record
 * shapes; each entry pairs a pure-data definition with an `Effect.fn` handler.
 * This barrel grows task by task; today it ships the error half of the
 * contract — the `fateWireCode` annotation key and the wire-error codec —
 * the views half (the `FateDataView` class factory + `Entity` helper), the
 * record-value constructors (`Fate.source` for per-entity loaders,
 * `Fate.query` / `Fate.list` / `Fate.mutation` for operation resolvers), and
 * the composite: the `FateServer` tag + `config` + `layer`, with the
 * per-request pair (`CurrentUser`, `LivePublisher`) it provides to handlers.
 *
 * Exports stay flat (every supporting type a consumer's exported value can
 * surface must be nameable through this barrel); the `Fate` namespace is the
 * PRD's authoring surface layered over the same flat members.
 */
export {CurrentUser, type CurrentUserInfo, Unauthorized} from "./CurrentUser.ts";
export {
	type DataViewFieldsKey,
	type DataViewOf,
	type Entity,
	FateDataView,
	type FateDataViewClass,
	type FieldsConfigOf,
	type KernelDataView,
	type ListFieldOf,
} from "./DataView.ts";
export * as Fate from "./Fate.ts";
export {
	type LiveConnectionPublisher,
	type LiveEdgeOptions,
	type LiveEventOptions,
	LivePublisher,
	type LiveUpdateOptions,
} from "./LivePublisher.ts";
export {
	type DefinitionArgs,
	type DefinitionDecodeError,
	type DefinitionDecodingServices,
	type DefinitionErrors,
	type DefinitionInput,
	type DefinitionTypeName,
	type FateList,
	type FateMutation,
	type FateOperationServices,
	type FateQuery,
	InputValidationError,
	type ListDefinition,
	list,
	type MutationDefinition,
	type MutationHandlerInput,
	mutation,
	type OperationSelect,
	type QueryDefinition,
	type QueryHandlerInput,
	query,
	type RawArgsInput,
	type RawMutationInput,
	type TypeNameOf,
	type TypeRef,
} from "./Operation.ts";
export {
	type AnyFateList,
	type AnyFateMutation,
	type AnyFateQuery,
	type AnyFateServerConfig,
	type AnyFateSourceEntry,
	type AnyFateSourceHandlers,
	type DataViewLike,
	type FateConfigServices,
	type FateListsRecord,
	type FateLiveOption,
	type FateMutationsRecord,
	type FateQueriesRecord,
	type FateRecordServices,
	FateServer,
	type FateServerConfig,
	FateServerConfigError,
	type FateServerRequirements,
	type FateServerService,
	type FateSourcesList,
	type RawFateOperation,
	type RawFateSourceEntry,
	type SourceDefinitionLike,
} from "./Server.ts";
export {
	type FateSource,
	type FateSourceHandlers,
	type FateSourceServices,
	type SourceConnectionInput,
	type SourceHandlerBody,
	type SourceHandlerServices,
	type SourceHandlersInput,
	type SourceHandlersServices,
	type SourceLoaderContract,
	type SourceOptions,
	source,
} from "./Source.ts";
export {
	encodeWireError,
	fateWireCode,
	INTERNAL_WIRE_CODE,
	wireCodeOf,
	wireCodeOfClass,
} from "./WireError.ts";
