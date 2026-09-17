/**
 * The authoring API's front door — what `@kampus/tuval/authoring` resolves to (#8943).
 *
 * **What is public here is exactly what a program file needs and nothing else.** The set was read
 * off the one program in this repo written the way a third party writes one — the worked example
 * (`./example/pr-review.ts`) — plus `testProgram`, which is how an
 * author tests a program outside this repo. Every name below appears in one of those files' import
 * lists or is the declared type of something that does. Nothing else is here on the theory that
 * someone might want it: a name added to this file is a name this package then owes.
 *
 * **The compilers are not public.** `compilePorts`, `compileCommands`, `compileResume`,
 * `compileWindow`, `FIELD_COMPILERS`, `fillArgs`, `argContext`, `resolveSpawnTarget`,
 * `resolveOwnProcess` and the rest of the kernel-facing half of these modules stay reachable only
 * by relative path from inside `src/`. They are how a row is built, not how one is written, and
 * `defineProgram` is the whole of the seam between the two.
 *
 * **`program({...})` is public because the record an author keeps has to be typed somewhere.** It
 * compiles nothing — it answers its argument — and it is here because an author holds the authored
 * record in a `const` (the config compiles it, a test drives it), and a `const` contextually types
 * nothing, so without this call the whole of R12.1's inference was lost at that binding (#8825).
 * It is not `Program` (`./shape.ts`), which is how a program is *named by its ports* for an arg.
 *
 * **A few names come from outside `authoring/`, and each is here because a consumer cannot write
 * a typed program without it.** `AnyProgram` is what `defineProgram` returns; `PortSchema` (with
 * `InPort`/`OutPort` under it) is how a row's ports read back; `ProcessId` is what `stop` takes and
 * what `Spawned`/`Stopped` carry, and it is exported as a *value* because `ProcessId.make` is the
 * only way to name one; `TITLE_PORT` / `STATUS_PORT` are the two generic self-report ports a
 * program emits its derived lines on, which is a string an author would otherwise have to guess.
 * The first outside consumer (`@kampus/tuval-cron`, which lives in this repo at
 * `packages/tuval-cron` and reaches this package only through its published doors) found each of
 * these by failing to compile without it.
 *
 * **The whole `ArgRefs` chain is public for the same reason, and it is not optional.** The type
 * `programArgs(…)` infers is `ArgRefs<Id, D>`, which reaches `ArgRef`, `ProgramArgRef`,
 * `ValueArgRef`, `ArgIdentity` and `Spawnable`. A consumer that exports any program declaring
 * `args` fails declaration emit with TS2742 — "cannot be named without a reference to
 * `src/authoring/args`" — unless every one of those is reachable through this door.
 * `../test-consumer/` is a fixture that emits exactly such a declaration, and
 * `public-surface.unit.test.ts` runs `tsc --declaration` over it.
 *
 * **`HostHandlers` is here because R12.1's other half needs a name.** A program that answers an
 * effect of its own — `defineProgram`'s `X` — supplies the handler for it by spreading the compiled
 * row, and `HostHandlers<Msg, MyEffect, Failure, Services>` is the type that handler record is
 * written against (#9294). Nothing else of the kernel's row types is on this door.
 *
 * **The window half is its own door, `@kampus/tuval/window` (`./window.ts`).** Not because
 * `./view.ts` is unsafe — its value-import closure reaches no `node:` builtin, and
 * `window-closure.unit.test.ts` pins that — but because *this* barrel is not: it reaches
 * `../process/Processes.ts` and `../commands/core/process.ts`, both `node:crypto` importers, so a
 * flat barrel carrying both halves would drag the kernel chain into every page-side import. Two
 * doors is what keeps the browser-side one clean, and the same test walks both to say so.
 *
 * The payload vocabulary a shaped arg is declared over is not here either: it is its own module
 * with its own boundary test (`../ai-agent/ports/index.ts`, `@kampus/tuval/ai-agent/ports`), held
 * closed over `effect` and the kernel's program row so that importing it drags in no agent. Folding
 * it in here would put the AI-agent interface behind the authoring door and make one surface owe
 * two stabilities.
 */

export {ProcessId} from "../process/process.ts";
export {STATUS_PORT, TITLE_PORT} from "../process/self-report.ts";
export type {AnyProgram, HostHandlers, InPort, OutPort, PortSchema} from "../registry/program.ts";
export {
	type AnyArgRef,
	type AnyArgRefs,
	type ArgDecl,
	type ArgDecls,
	type ArgIdentity,
	type ArgRef,
	type ArgRefs,
	type ArgServices,
	type ArgValue,
	type ArgValues,
	type ProgramArgRef,
	programArgs,
	type ValueArgRef,
} from "./args.ts";
export type {CommandAnswer, CommandDecl, CommandDecls, CommandEffect} from "./commands.ts";
export {
	type Answer,
	type ArrivalEvent,
	type AuthoredEvent,
	type AuthoredProgram,
	defineProgram,
	type EventHandler,
	program,
	type RequestArrivalEvent,
} from "./define-program.ts";
export {
	type AskEffect,
	ask,
	type EmitEffect,
	emit,
	type PortAddress,
	type ProgramEffect,
	type Reply,
	type ReplyTo,
	reply,
	type SendEffect,
	type Spawnable,
	type SpawnEffect,
	type Spawned,
	type StopEffect,
	type Stopped,
	send,
	spawn,
	stop,
} from "./effect.ts";
export {KEY_EVENT, type KeyEvent} from "./keys.ts";
export {
	type AnyPortDecl,
	type InPortDecl,
	type OutPortDecl,
	type PortCodec,
	type PortDecls,
	type PortPayload,
	port,
	type RequestPortDecl,
} from "./port.ts";
export type {AuthoredResume, ResumeEvent} from "./resume.ts";
export {
	type AnyProgramShape,
	Program,
	type ProgramShape,
	type ShapeOutNames,
	type ShapeSource,
} from "./shape.ts";
export {type ProgramRun, testProgram} from "./test-program.ts";
