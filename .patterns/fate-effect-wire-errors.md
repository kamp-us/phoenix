# fate-effect wire errors — the `FateWireCode` annotation

> Derived from the in-repo source (`packages/fate-effect`, `apps/web`) + `@nkzw/fate@1.3.1` where the lib is implicated — re-verify on pin bump.

How `@kampus/fate-effect` (the workspace package at `packages/fate-effect`) maps Effect failures onto fate's wire error shape. The short answer: **the wire code is a schema annotation on the error class** — one edit per domain error, no registry. This replaced the bridge's `WIRE_CODE_BY_TAG` registry (deleted in the v1 cutover, ADR 0042). Two guards hold the contract: each feature's `errors.unit.test.ts` enumeration pin, and `worker/features/fate/wireCodes.unit.test.ts` — which derives the server-emittable code set via the package's `declaredWireCodes(config)` (the canonical walker: every declared error union's annotations plus the `INTERNAL_SERVER_ERROR`/`VALIDATION_ERROR` fallbacks; its AST-drift canary lives package-side in `Server.unit.test.ts`) and asserts the SPA's `FATE_WIRE_CODES` covers it.

**One name for the concept: `FateWireCode`.** The error `code` string that crosses the worker↔SPA boundary is named *once* across the seam (#1032): `FateWireCode` (the annotation key, package side — `import {FateWireCode} from "@kampus/fate-effect"`), and `FateWireCode` / `FATE_WIRE_CODES` (the SPA literal union + `decodeFateWireCode` in `src/lib/fateWireCodes.ts`). The boundary in `src/fate/Screen.tsx` reads the same `FateWireCode` vocabulary un-narrowed, as `FateWireCode | (string & {})` (no separate alias) — open on purpose, because a fate-internal throw bypasses the codec and carries fate's own `INTERNAL_ERROR`, a code `FATE_WIRE_CODES` omits. The SPA literal is the authored source — a runtime `Set<string>` (what `declaredWireCodes` yields) can't give an exhaustive-`switch`-able union — and `wireCodes.unit.test.ts` is what binds it to the server: it covers the value set AND pins the canonical export *name* `FateWireCode`, so neither the codes nor the noun can drift.

## Declaring an error

Attach the wire code where the error is defined, via the `FateWireCode` annotation key (`Schema.TaggedErrorClass`'s third parameter):

```ts
import {FateWireCode} from "@kampus/fate-effect";
import * as Schema from "effect/Schema";

export class BodyRequired extends Schema.TaggedErrorClass<BodyRequired>()(
	"sozluk/BodyRequired",
	{message: Schema.String},
	{[FateWireCode]: "BODY_REQUIRED"},
) {}
```

That is the whole contract — the class declaration carries its own wire mapping. Custom annotation keys are effect's documented schema extension point (effect-smol `Schema.ts` › `Annotations` namespace, "Defining your own annotations"); the package augments `Schema.Annotations.Annotations` so the key's value is typed `string | undefined` at every definition site.

**One class, one code.** The annotation is class-level — `wireCodeOf` reads it off `instance.constructor` — so a bridge-era class whose wire code depended on an instance field (the registry's `upcased` arms: `PostValidation`'s `code: "title_required"` upcased to `TITLE_REQUIRED`) cannot port as a single class. Split it into one class per sub-code, with a union alias + a members tuple so service signatures and mutation `error:` unions stay one name (`apps/web/worker/features/pano/errors.ts`: `TitleRequired`/`TitleTooLong`/… , `type PostValidation = …` union, `PostValidationErrors` tuple spread into `Schema.Union([...])`; same shape for pasaport's `UsernameInvalid` → `UsernameInvalidFormat`/`UsernameTooShort`/`UsernameTooLong`). The split also retires the stringly `code` field — each sub-code is its own type.

## The codec

`encodeWireError(unknown): FateRequestError` is total — it never throws, whatever the failed/thrown value:

| input | wire result |
|---|---|
| error whose class carries `FateWireCode` | the annotated code + the instance's own `message` |
| un-annotated error, defect, any other value | `INTERNAL_WIRE_CODE` (`INTERNAL_SERVER_ERROR`) + a fixed message — **defect details never reach the wire** |
| `FateRequestError` | passed through verbatim (the escape hatch for code already speaking the wire shape) |

At runtime the codec reads the annotation off `instance.constructor` — a `Schema.TaggedErrorClass`'s annotations land on the class's static `ast.annotations` — through structural guards (`Predicate.hasProperty`), so arbitrary defect values are safe inputs and no type assertion is needed. `wireCodeOf` (instance) and `wireCodeOfClass` (class) expose the same read for tests and tooling.

`INTERNAL_WIRE_CODE` is `INTERNAL_SERVER_ERROR` — phoenix's historical wire code and a member of the SPA's `FATE_WIRE_CODES` vocabulary — not fate's protocol `INTERNAL_ERROR`, preserved verbatim through the migration.

## The module is the package's whole error taxonomy

Two more pieces live in `WireError.ts` beside the codec — anything that spells wire-error bytes or extracts the value the codec encodes belongs here, not in the plane that happens to use it:

- **`internalArm()`** — fate's *own* internal arm (`toProtocolError`'s fallback): `FateRequestError("INTERNAL_ERROR", "Internal server error.")`. Distinct from `INTERNAL_WIRE_CODE`: that is the annotation codec's arm for per-operation failures; this is what fate spells for walk-internal throws (view callbacks, pagination rejections, capability-less sources) and the interpreter's request-level defect fallback. It is the **one construction site** for those bytes — `Walk.ts`, `Connection.ts`, and `Interpreter.ts` all derive from it, so the oracle-pinned bytes cannot drift between arms.
- **`failureOf(cause)`** — the failed/thrown value behind a `Cause`: the typed failure if one exists, otherwise the squashed defect. Shared by the interpreter's dispatch loop and the oracle baseline's `runResolve`, both of which feed the result straight into `encodeWireError`.

## Keeping the codec honest

Two test layers (both `unit`, [effect-testing.md](./effect-testing.md)):

- **In the package** (`packages/fate-effect/src/WireError.unit.test.ts`): the round-trip ("annotation alone is sufficient"), the defect/no-leak fallbacks, and an enumeration pin — discovery scans the package barrel for annotated error classes and compares against a literal table, so the package shipping (or re-coding) an error class without updating the pin is a test failure.
- **In the app** (arrives with the feature migrations): the same enumeration shape over phoenix's feature errors — every error-class ↔ wire-code pair the worker can emit, pinned in one place.

## What not to do

- Don't add a registry entry anywhere — the annotation **is** the registry.
- Don't put infra details in a domain error's `message`: annotated messages go to the client verbatim. Infra failures belong in the defect channel, where the codec replaces them with the fixed internal message.
- Don't construct `FateRequestError` ad-hoc in feature code; fail with an annotated domain error and let the codec encode it at the boundary.
