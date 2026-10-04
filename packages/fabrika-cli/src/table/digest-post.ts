/**
 * The one write the digest makes: a JSON POST to a chat webhook.
 *
 * **A failure never carries the URL.** The URL is the credential, and a thrown fetch error or an
 * echoed response body can hold it, so a failure names only the HTTP status, the short error token
 * the tool answered with, or the platform's own error code.
 *
 * Discord answers `204` before it has saved the message unless the request asks it to wait, and a
 * message it then fails to save returns no error. `wait=true` makes its answer mean the post landed.
 *
 * @ruling https://github.com/kamp-us/phoenix/issues/10357
 */

import {Effect} from "effect";
import * as Schema from "effect/Schema";
import type {ChatTool} from "../config/keys/digest.ts";
import {type Attempt, fail, ok} from "../io/git.ts";
import {payloadOf} from "./digest.ts";

const TIMEOUT_MS = 30_000;

/** A request that never completed, reduced to a code that cannot hold the URL. */
class PostFailed extends Schema.TaggedError<PostFailed>()("fabrika-cli/table/PostFailed", {
	code: Schema.String,
}) {}

/** A platform error code such as `ECONNREFUSED`, or the error's class name; never its message. */
const postFailed = (cause: unknown): PostFailed => {
	if (!(cause instanceof Error)) return new PostFailed({code: "unknown error"});
	const inner = cause.cause;
	const code =
		typeof inner === "object" && inner !== null ? (inner as {readonly code?: unknown}).code : null;
	return new PostFailed({
		code: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : cause.name,
	});
};

/** What the tool said about a refused post, when it is a fixed token or a numeric code, never free text. */
const detailOf = (body: string): string => {
	const text = body.trim();
	if (/^[a-z_]{1,60}$/.test(text)) return ` (${text})`;
	const code = /"code"\s*:\s*(\d+)/.exec(text)?.[1];
	return code === undefined ? "" : ` (code ${code})`;
};

export const postWebhook = (tool: ChatTool, url: URL, text: string): Effect.Effect<Attempt<null>> =>
	Effect.tryPromise({
		try: async (): Promise<Attempt<null>> => {
			const target = new URL(url);
			if (tool === "discord") target.searchParams.set("wait", "true");
			const response = await fetch(target, {
				method: "POST",
				headers: {"content-type": "application/json"},
				body: JSON.stringify(payloadOf(tool, text)),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			if (response.ok) return ok(null);
			return fail(`HTTP ${response.status}${detailOf(await response.text())}`);
		},
		catch: postFailed,
	}).pipe(
		Effect.catch((failed) => Effect.succeed(fail(`the request did not complete (${failed.code})`))),
	);
