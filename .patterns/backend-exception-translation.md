# Translating a backend's exceptions at the adapter

How a Tuval backend adapter turns an arbitrary thrown value from its SDK into one of the generic
`TuvalAiAgent` errors — and where the thrown value itself goes.

The shape lives in [`apps/tuval/src/claude/agent/refusals.ts`](../apps/tuval/src/claude/agent/refusals.ts)
and [`apps/tuval/src/claude/agent/diagnosis.ts`](../apps/tuval/src/claude/agent/diagnosis.ts), and is
judged by [`refusals.unit.test.ts`](../apps/tuval/src/claude/agent/refusals.unit.test.ts) beside them.
It applies to any adapter under `apps/tuval/src/<backend>/` that catches a dependency's exception;
it does not govern the error classes themselves ([`ai-agent/service/errors.ts`](../apps/tuval/src/ai-agent/service/errors.ts))
or how the core folds them.

## The exception's text is not the error's `detail`

`handlers/failures.ts` folds a service error to `{tag, reason, detail: error.message}`, and that
triple is checkpointed process state the window renders. So an SDK exception's message placed in
`detail` becomes operator-facing copy nobody wrote, kept in state nobody meant to keep — the defect
[#8010](https://github.com/kamp-us/phoenix/issues/8010) removes.

Each refusal helper writes its own `detail` naming **the operation that failed**, and hands the
thrown value to a `retaining` helper that parks it on the JS `Error.cause` slot:

```ts
export const storeUnreadable = (cause: unknown): PageError =>
	retaining(
		cause,
		new PageError({
			reason: "store-unreadable",
			detail: translated("the Claude Code session store did not answer", cause),
		}),
	);
```

`cause` is a JS slot, not a schema field, so it is inspectable in this process and in a log line
while `failureOf` cannot carry it onto the core's plain data. That is the whole split: deliberate
message out, thrown value retained.

## Guidance only where a stable discriminant says so

A translated message may add guidance, and only from a **machine-readable discriminant** — an error
class, a stamped property, a code. Never from the exception's message text, which for a control
failure is a string the CLI wrote and for a result failure is text the model wrote.

`diagnose` answers a sentence or `null`, and `null` means the operation's own name is the whole
message. **An unrecognised cause gets no diagnosis rather than a guessed one**; the retained cause is
where a reader goes next.

Ground the discriminants in the dependency's source at the pin. For
`@anthropic-ai/claude-agent-sdk@0.3.259` the ground is `sdk.mjs`: it exports exactly one error class
(`AbortError`, which does not set `name`, so only `instanceof` works), and every process and control
failure is a plain `Error` with own props stamped on it — `errorClass` from a fixed vocabulary, plus
`code` and `exitCode`. None of those stamps is declared in `sdk.d.ts`, so the adapter declares its
own narrowing over `unknown`.

The one sanctioned message-text read is a literal the dependency authors with no caller data in it
and no stamp beside it — for that pin, the `Native CLI binary for …` setup throw. Match a prefix,
cite the file, and keep the list to failures an operator can act on.

## A swallowed refusal still logs its cause

Where the adapter catches a refusal and carries on (a catalog it could not read, a mode switch the
CLI declined), the log line takes the deliberate message **and the retained cause** —
`logRefused(what, refusal)`, which passes `refusal.cause` as a second argument to
`Effect.logWarning`. Reading `refusal.detail` alone would drop the diagnosis the translation just
moved off it.

## Pi keeps diagnostics on the local side of protocol 8

Pi uses the same split in [`pi/diagnostics.ts`](../apps/tuval/src/pi/diagnostics.ts):
`retaining` assigns the original thrown value to the JavaScript `Error.cause` slot, outside the
schema fields. The client and session host translate exceptions into deliberate operation text;
[`pi/ai-agent/refusals.ts`](../apps/tuval/src/pi/ai-agent/refusals.ts) translates their typed
refusals again at the generic agent boundary. `failureOf` projects only tag, reason and message
into checkpoint data. Listing has its own boundary: `session-list.ts` projects the typed error's
message into `unreadable`, not its cause.

At the `@earendil-works/pi-client@0.85.1` pin, `dist/errors.js` exports `ServerError` with a `code`,
`DisconnectedError` and `ClientDisposedError`. The client adapter tests these actual classes;
`session_locked` and `not_found` are the owned dispatch's stable codes. They preserve locked,
missing-session and disconnected guidance. Unknown codes and arbitrary exception text earn only
the operation sentence, never inferred authentication or billing advice.

Protocol 8's opaque service payload does not make local exceptions wire data. The owned
[`dispatch.ts`](../apps/tuval/src/pi/server/dispatch.ts) logs refused create, resume and session
calls with their retained error, then answers only an owned code and deliberate sentence. The
session host's working directory and original exception never become the response message.
Framing errors follow the same split: the local classifier retains the pinned
`@earendil-works/pi-protocol@0.85.1` `dist/framing.js` literal `Frame length … exceeds configured
limit of …` to preserve the oversized-frame close code. The close reason is fixed text; the
original decoder error stays in the local log. This internal framing classification adds no
user-facing diagnosis from exception text.

`StoreRead.failures` and `StoreDirs.failures` carry optional local causes. Their sole production
consumer is `PiAiAgent.ts`: successful reads return only sessions, partial failures log locally,
and total failures retain the diagnostic array as `ListError.cause` or `TranscriptError.cause`.
No caller serializes the whole store result or its diagnostic array. The generic list schema,
checkpoint projection and dispatch codec regressions pin these distinct boundaries; neither a
schema field nor a protocol payload may acquire `cause` to transport those diagnostics.
