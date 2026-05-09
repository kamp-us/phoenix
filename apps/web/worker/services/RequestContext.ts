import {Context} from "effect";

export class RequestContext extends Context.Service<
	RequestContext,
	{
		readonly headers: Headers;
		readonly url: string;
		readonly method: string;
	}
>()("@phoenix/worker/RequestContext") {}
