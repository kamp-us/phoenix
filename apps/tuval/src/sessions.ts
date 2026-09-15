/**
 * The shipped AI-agent session rows, as a config outside this repo imports them —
 * `@kampus/tuval/sessions` (#8943).
 *
 * This is the door a *config* needs, not the door a program needs. A program declares the shape it
 * wants (`Program.shape` over `../ai-agent/ports/index.ts`'s payloads) and names no session; which
 * row fills that arg is `.tuval/tuval.config.ts`'s call, and these two factories are the rows it
 * has to choose from. `apps/tuval/.tuval/tuval.config.ts` is the worked instance of exactly that —
 * it builds a row here and hands it to `cron`'s `job` arg.
 *
 * **The scope trio is re-exported because a row cannot be built without one.** `claudeSession` and
 * `codexSession` each take a `scope` whose two fields are branded (`../commands/spell.ts`), so a
 * consumer with no `WorkspaceId`/`ClientId` constructor has a factory it cannot call. Exporting the
 * functions alone would be a decorative door.
 *
 * The other shipped rows — Pi, agy, the session list, the demo pair — are not here. Nothing has
 * asked to fill a shaped arg with one yet, and a name on this file is a name this package then
 * owes; adding one when a consumer needs it is a line, guessing at five today is a surface.
 */

export {type ClaudeSessionProgram, claudeSession} from "./claude/program.ts";
export {type CodexSessionProgram, codexSession} from "./codex/program.ts";
export {ClientId, type Scope, WorkspaceId} from "./commands/spell.ts";
