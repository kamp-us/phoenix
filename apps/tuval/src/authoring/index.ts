/**
 * The authoring API's front door — what `@kampus/tuval/authoring` resolves to (#8943).
 *
 * **What is public here is exactly what a program file needs and nothing else.** The set was read
 * off the two programs in this repo that are written the way a third party writes one — the worked
 * example (`./example/pr-review.ts`) and `../cron/cron.ts` — plus `testProgram`, which is how an
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
 * **Two names come from outside `authoring/`, and both are types.** `AnyProgram` is what
 * `defineProgram` returns, and `ProcessId` is what `stop` takes and what `Spawned`/`Stopped` carry
 * — a consumer that annotates either cannot do it without them, so refusing to re-export them
 * would ship a door you cannot write a typed program behind. Being type-only, they add no module
 * to the runtime graph this barrel pulls.
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

export type {ProcessId} from "../process/process.ts";
export type {AnyProgram} from "../registry/program.ts";
export {programArgs} from "./args.ts";
export type {CommandAnswer, CommandDecl, CommandDecls, CommandEffect} from "./commands.ts";
export {
	type Answer,
	type ArrivalEvent,
	type AuthoredEvent,
	type AuthoredProgram,
	defineProgram,
	type EventHandler,
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
	type ShapeSource,
} from "./shape.ts";
export {type ProgramRun, testProgram} from "./test-program.ts";
