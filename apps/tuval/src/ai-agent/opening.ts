/**
 * `SessionOpening` — the session a spawn is for, when the spawn is for one.
 *
 * A fresh agent process opens its own new session (`./core/machine.ts`'s `init`). Picking a row out
 * of the session list and sending the first message is the other case: that spawn is for a session
 * that already exists, and the process has to come up resuming it rather than booting a second one
 * beside it (epic #8070, ruling 2).
 *
 * It carries exactly `{cwd, resume}` and it never grows a third field. The epic's rabbit-holes rule
 * out turning `Processes.spawn` into a program-arguments system, so this is not one: it is a service
 * a spawner may add to the context it hands a child, read once by the `aiAgent.boot` handler and by
 * nothing else. A spawner with no session to name simply omits it, which is why the read is
 * `Effect.serviceOption` — absence is the ordinary case and not a missing dependency.
 */

import {Context} from "effect";

export class SessionOpening extends Context.Service<
	SessionOpening,
	{
		readonly cwd: string;
		/** The backend session id this process comes up on, never one it should mint. */
		readonly resume: string;
	}
>()("tuval/ai-agent/SessionOpening") {}
