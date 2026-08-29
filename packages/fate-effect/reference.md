# @kampus/fate-effect reference

Lookup tables for the package's public authoring, serving, and code-generation surface.

## Public surface groups

| Surface | Public exports |
| --- | --- |
| Errors | `FateWireCode`, `encodeWireError`, `wireCodeOf`, `wireCodeOfClass`, `failureOf`, `INTERNAL_WIRE_CODE`, `Unauthorized` |
| Views and entities | `FateDataView`, `Entity<>`, `WorkerEntity<>`, `AssertFieldMapResolved<>`, `FieldMapResolved<>`, `FieldMapRecoveryFailed<>`, `DataViewOf<>`, `FateDataViewClass`, `KernelDataView`, `ListFieldOf<>` |
| Sources | `Fate.source`, `source`, `syntheticSource`, `FateSource`, `SourceLoaderContract`, source handler and service helper types |
| Operations | `Fate.query`, `Fate.list`, `Fate.mutation`, flat `query`, `list`, `mutation`, `InputValidationError`, definition and handler helper types |
| Composition | `FateServer.config`, `FateServer.layer`, `FateServerConfig`, `FateServerRequirements`, `RegisteredRequestServices<>`, `RequestServiceId<>` |
| Serving | `FateInterpreter`, `FateRequestContext`, `CurrentUser`, `LivePublisher` |
| Code generation | `FateExecutor.toCodegenServer`, `FateCodegenServer` and API helper types |
| Protocol | schemas and encoded/decoded operation and result types from `Protocol.ts` |

`WorkerEntity<View, DateKeys, Override>` applies worker-side date and relation corrections to an
`Entity`. `RegisteredRequestServices<Keys>` extracts the service identifiers registered with
`FateServer.layer`; `RequestServiceId<Key>` extracts one identifier. These three are type-only
exports.

The barrel at [`src/index.ts`](./src/index.ts) is the exhaustive export list.

## Live publish surface

| Call | Subscriber result |
| --- | --- |
| `live.update(type, id, {changed, data})` | Apply the supplied field values. |
| `live.delete(type, id)` | Remove the row. |
| `live.invalidate(type, id)` | Re-read the row without applying shared data. |
| `live.topic(procedure, args).appendNode(…)` | Append a connection node. |
| `live.topic(procedure, args).prependNode(…)` | Prepend a connection node. |
| `live.topic(procedure, args).deleteEdge(…)` | Remove a connection edge. |
| `live.topic(procedure, args).invalidate()` | Re-read the connection. |

## Invariants

| Invariant | Enforced by |
| --- | --- |
| A source has a loader | `SourceLoaderContract` |
| Source infrastructure failures do not enter the typed error channel | `E = never` on handler slots |
| Wire errors are declared | `E extends DefinitionErrors<D>` |
| Inputs are decoded before handlers run | the operation's `resolve` path |
| Domain requirements remain in the layer input | `FateServer.layer`'s `R` channel |
| Wire codes remain enumerated | per-feature enumeration tests |
| Live publication cannot fail a mutation | `LivePublisher` methods return `Effect<void>` |
| The production serving path does not convert Effect to Promise | the source enumeration test |
| The native interpreter matches fate | the byte-equal differential oracle |

## Module map

| Module | Contents |
| --- | --- |
| `WireError.ts` | wire annotation, encoder, and error lookup helpers |
| `DataView.ts` | view factory; entity, `WorkerEntity`, list-field, and field-map guard types |
| `Source.ts` | source constructors and loader contracts; `syntheticSource` |
| `Operation.ts` | query, list, and mutation definitions and handlers |
| `Fate.ts` | authoring namespace over the flat exports |
| `Server.ts` | configuration, layer construction, request-service types including `RegisteredRequestServices` and `RequestServiceId` |
| `CurrentUser.ts`, `LivePublisher.ts` | request-scoped services |
| `RequestContext.ts` | request value contract |
| `Provision.ts` | request-value provision pipeline |
| `Protocol.ts` | wire schemas and protocol types |
| `Interpreter.ts`, `Walk.ts`, `Connection.ts` | native request dispatch, selection, batching, and pagination |
| `Executor.ts` | frozen v1 oracle baseline |
| `Codegen.ts` | inert build-time server |
| `Compiled.ts` | compiled internals shared by executor and codegen |
