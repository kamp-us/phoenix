/**
 * `@phoenix/fate-effect` — phoenix's Effect-native fate integration.
 *
 * fate's structure with Effect's semantics: feature code keeps fate's record
 * shapes; each entry pairs a pure-data definition with an `Effect.fn` handler.
 * This barrel grows task by task; today it ships the error half of the
 * contract — the `fateWireCode` annotation key and the wire-error codec —
 * the views half (the `FateDataView` class factory + `Entity` helper), the
 * record-value constructors (`Fate.source` for per-entity loaders,
 * `Fate.query` / `Fate.list` / `Fate.mutation` for operation resolvers), the
 * composite — the `FateServer` tag + `config` + `layer`, with the
 * per-request pair (`CurrentUser`, `LivePublisher`) it provides to handlers —
 * and the v2 native plane THAT SERVES `/fate` (ADR 0043): the wire-protocol
 * Schema codecs (`Protocol.ts`, drift-pinned against fate's exported types)
 * and the `FateInterpreter` dispatch loop with the byId selection walk over
 * `RequestResolver`-batched sources (`Walk.ts`) and its connection plane
 * (`Connection.ts` — Schema-decoded pagination args, fate's only runtime
 * zod replaced) — oracle-verified byte-equal to fate across the full
 * operation surface. The v1 compile step (`FateExecutor`: config → pure
 * `createFateServer` over a ManagedRuntime) remains as the differential
 * oracle's baseline (`Executor.ts`) and, via `toCodegenServer`
 * (`Codegen.ts`), the build-time codegen surface — two modules sharing
 * `Compiled.ts`, stitched into the one `FateExecutor` namespace below.
 *
 * Exports stay flat (every supporting type a consumer's exported value can
 * surface must be nameable through this barrel); the `Fate` namespace is the
 * PRD's authoring surface layered over the same flat members.
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
	type DataViewFieldsKey,
	type DataViewOf,
	type Entity,
	FateDataView,
	type FateDataViewClass,
	type FieldsConfigOf,
	type KernelDataView,
	type ListFieldOf,
} from "./DataView.ts";
export {
	type CompiledFateServer,
	compileFateSources,
	type FateExecutorRuntime,
	type FateFetchHandler,
} from "./Executor.ts";
export * as Fate from "./Fate.ts";
export {FateInterpreter} from "./Interpreter.ts";
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

/**
 * The compile-step namespace: `compile`/`toFetchHandler` — the differential
 * oracle's baseline (`Executor.ts`, test-harness-only since ADR 0043) — and
 * `toCodegenServer` — the build-time codegen surface (`Codegen.ts`, what
 * `schema.ts` exports for Vite codegen). Assembled HERE so the frozen
 * oracle-baseline module and the production codegen module never import
 * each other (they share internals through `Compiled.ts` only), while the
 * public spelling (`FateExecutor.toCodegenServer` in `schema.ts`) stays
 * exactly what it was before the split (review fix, tasks.md task 20).
 */
export const FateExecutor = {
	compile,
	toFetchHandler,
	toCodegenServer,
};
