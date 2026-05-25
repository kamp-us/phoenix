import {Context} from "effect";
import type {WorkerEnv} from "../shared/worker-env.ts";

/**
 * The worker's assembled env, provided per-request to fate/admin layers. Holds
 * the typed {@link WorkerEnv} (`shared/worker-env.ts`) — the alchemy runtime env
 * record with `PHOENIX_DB` + `ENVIRONMENT` typed — rather than the generated
 * `Env`, whose `ENVIRONMENT: "development"` literal can't model a real deploy.
 */
export class CloudflareEnv extends Context.Service<CloudflareEnv, WorkerEnv>()(
	"@phoenix/worker/CloudflareEnv",
) {}
