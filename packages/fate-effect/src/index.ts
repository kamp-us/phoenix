/**
 * `@kampus/fate-effect` — phoenix's Effect-native fate integration (ADR 0043).
 *
 * Exports stay flat: every supporting type a consumer's exported value can surface must be
 * nameable through this barrel. The `Fate` namespace is the authoring surface layered over
 * the same flat members.
 */
import {toCodegenServer} from "./Codegen.ts";
import {compile, toFetchHandler} from "./Executor.ts";

export type {
	FateCodegenAPI,
	FateCodegenListApi,
	FateCodegenMutationApi,
	FateCodegenQueryApi,
	FateCodegenServer,
} from "./Codegen.ts";
export type {CompiledFateSources} from "./Compiled.ts";
export {CurrentUser, type CurrentUserInfo, Unauthorized} from "./CurrentUser.ts";
export {
	type AssertFieldMapResolved,
	type DataViewFieldsKey,
	type DataViewOf,
	type Entity,
	FateDataView,
	type FateDataViewClass,
	type FieldMapRecoveryFailed,
	type FieldMapResolved,
	type FieldsConfigOf,
	type KernelDataView,
	type ListFieldOf,
	type WorkerEntity,
} from "./DataView.ts";
export type {
	CompiledFateServer,
	ExecutorRequestContext,
	FateExecutorRuntime,
	FateFetchHandler,
} from "./Executor.ts";
export * as Fate from "./Fate.ts";
export {FateInterpreter} from "./Interpreter.ts";
export {
	type LiveEdgeOptions,
	type LiveEventOptions,
	LivePublisher,
	type LiveTopicPublisher,
	type LiveUpdateOptions,
} from "./LivePublisher.ts";
export {
	type DefinitionArgs,
	type DefinitionDecodeError,
	type DefinitionDecodingServices,
	type DefinitionErrors,
	type DefinitionInput,
	type DefinitionTypeName,
	type DefinitionWireArgs,
	type DefinitionWireInput,
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
	type DecodedProtocolOperation,
	decodeProtocolRequest,
	encodeProtocolResponse,
	PROTOCOL_OPERATION_KINDS,
	type ProtocolByIdOperation,
	ProtocolError,
	ProtocolFailureResult,
	type ProtocolNamedOperation,
	ProtocolOperation,
	ProtocolOperationResult,
	ProtocolRequest,
	ProtocolResponse,
	ProtocolSuccessResult,
} from "./Protocol.ts";
export type {FateRequestContext} from "./RequestContext.ts";
export {
	type AnyFateList,
	type AnyFateMutation,
	type AnyFateQuery,
	type AnyFateServerConfig,
	type AnyFateSourceEntry,
	type AnyFateSourceHandlers,
	type DataViewLike,
	declaredWireCodes,
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
	type RegisteredRequestServices,
	type RequestServiceId,
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
	syntheticSource,
} from "./Source.ts";
export {
	encodeWireError,
	FateWireCode,
	failureOf,
	INTERNAL_WIRE_CODE,
	wireCodeOf,
	wireCodeOfClass,
} from "./WireError.ts";

/**
 * Assembled HERE so the frozen oracle-baseline module (`Executor.ts`, test-harness-only since
 * ADR 0043) and the production codegen module (`Codegen.ts`) never import each other — they
 * share internals through `Compiled.ts` only — while `FateExecutor.toCodegenServer` keeps the
 * spelling it had before the split.
 */
export const FateExecutor = {
	compile,
	toFetchHandler,
	toCodegenServer,
};
