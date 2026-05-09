import {Context} from "effect";

export class CloudflareEnv extends Context.Service<CloudflareEnv, Env>()(
	"@phoenix/worker/CloudflareEnv",
) {}
