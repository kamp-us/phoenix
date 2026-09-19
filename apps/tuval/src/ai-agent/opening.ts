/**
 * `SessionOpening` — the session a spawn is for, when the spawn is for one.
 *
 * A fresh agent process normally opens in its row's configured directory. An authored spawn may
 * choose another one, while a session-list spawn names both the stored session and its directory.
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
		/** The stored session to resume, or `null` when the supplied directory is for a fresh one. */
		readonly resume: string | null;
	}
>()("tuval/ai-agent/SessionOpening") {}
