# @kampus/tuval-notify

A notifier for [Tuval](https://github.com/kamp-us/phoenix/tree/main/apps/tuval): it takes a message
on a port and delivers it **off the desk** — to an incoming webhook, to your phone over
[ntfy](https://ntfy.sh), or to stdout — says on its board tile whether that landed, and keeps a
window with every message it sent and a box to send another. That is the whole of v1.

The desk is a program that runs on your laptop. A cron on it writes a morning brief at 07:00 and the
brief sits there until you look. This package is the part that makes the desk reach *you*.

## Usage

```ts
// ~/.tuval/tuval.config.ts
import {notify} from "@kampus/tuval-notify";
import type {TuvalConfigInput} from "@kampus/tuval/sessions";

export const phone = notify({target: {kind: "ntfy", topic: "can-tuval-9f3a"}});

export default {
  version: 1,
  programs: [phone],
  graph: {nodes: [{id: "notify", program: "notify", on: []}]},
} satisfies TuvalConfigInput;
```

Then, from the palette or the command line:

```
:notify send the desk is up
```

| Field | What it is |
|---|---|
| `id` | What this notifier is called: its program id, its graph node id, and its spell (`:phone send …`). Defaults to `"notify"` — name it when a config holds more than one. |
| `target` | Where the message goes. One of the three below. |
| `fetch` | Optional `fetch`, so a test asserts the request instead of making one. Defaults to `globalThis.fetch`. |
| `write` | Optional writer for a `stdout` target. Defaults to `console.log`. |
| `now` | Optional clock, so a test states the time instead of reading one. |

## The three targets

`target` is a **discriminated union**, not a bag of optional fields: `url` belongs to a webhook and
`topic` belongs to ntfy, and a record carrying both — or neither — is refused by the checker where
you wrote it, not by a desk at boot.

### `{kind: "ntfy", topic}` — the easiest path to your phone

```ts
notify({
  target: {
    kind: "ntfy",
    topic: "can-tuval-9f3a",     // subscribe to this topic in the ntfy app
    server: "https://ntfy.sh",   // optional; a self-hosted server is the same protocol
    title: "Morning brief",      // optional; shown in bold above the body
    priority: 4,                 // optional; ntfy's 1 (min) … 5 (max)
  },
});
```

A plain `POST` of the text itself to `<server>/<topic>` — no account, no key, no SDK. The title and
the priority ride as headers, because that is ntfy's protocol; the body is the message.

**The topic name is a credential.** Anyone who knows it can both read your notifications and send
you fake ones. Pick something unguessable — `can-tuval-9f3a`, not `can`.

### `{kind: "webhook", url}` — Slack, Discord, anything that takes JSON

```ts
// Discord: the default body is `{content: text}`, which is what a Discord webhook reads.
notify({target: {kind: "webhook", url: process.env.DISCORD_WEBHOOK!}});

// Slack: one line, because Slack reads `{text}` instead.
notify({
  target: {
    kind: "webhook",
    url: process.env.SLACK_WEBHOOK!,
    body: (text) => ({text}),
  },
});

// Anything else: your own body, your own headers, your own method.
notify({
  target: {
    kind: "webhook",
    url: "https://api.example.com/inbox",
    method: "PUT",                                  // defaults to POST
    headers: {Authorization: `Bearer ${process.env.TOKEN}`},
    body: (text) => ({event: "tuval.brief", text}),
  },
});
```

`body` is a callback and not an enum of vendors on purpose: a Teams card and a Mattermost payload
are the same one-line function, and a vendor list is a thing this package would have to keep
current for ever.

### `{kind: "stdout"}` — for a test, and for seeing what a config would have sent

```ts
notify({id: "desk", target: {kind: "stdout"}});
```

Reaches no network at all. With a target title, a message is written as `Morning brief: five lines`.

## What arrives, and what it announces

The `message` in-port takes an AI-agent **`TurnResult`** — `{text, items, ok}` — and it is declared
over `TurnResultSchema` out of `@kampus/tuval/ai-agent/ports`, the *same object* cron declares its
`brief` out-port over. Not a lookalike: a route fits only on exact schema equality, so that identity
is what lets `cron.brief → notify.message` ever be a line in a config (see below). A test asserts
the two ports publish the same schema, so the day either side invents its own, the suite says so.

A notification's title is the target's (`title: "Morning brief"` above) — a turn carries text,
transcript items and an `ok`, and no title. `:notify send …` wraps its text into
`{text, items: [], ok: true}`, so the manual path and a routed one are the same payload arriving in
the same cell.

The `delivered` out-port announces `{text, ok, status?, reason?, at}` — and the very same record is
what goes into the history, so the wire, the tile and the window can never disagree. `text` is the
message that went out, which is what makes the window a log worth opening rather than a column of
verdicts. There is no `title` on the record: a `TurnResult` is `{text, items, ok}` and carries none,
so a field for one would be a field on a wire schema that nothing can fill — a notification's title
is the *target's* (`title: "Morning brief"` above) and stays in the closure with the rest of it.
`status` is **absent** when the request never got an answer at all (DNS, a dropped socket); a 500 is
`{ok: false, status: 500}`, because a receiver's bad day is a fact about a delivery and not a reason
to take the desk down. `reason` is present only when there was no request — today that is the single
word `dropped: outbox full`, which is the next section.

The tile reads `notify · ntfy` over `idle`, `sending`, or `delivered 07:00 · ok` /
`delivered 07:00 · failed 500` / `delivered 07:00 · dropped: outbox full`. History is bounded at
**fifty** deliveries — enough scrollback for the window to read as a conversation, and still a
checkpoint measured in kilobytes.

`sending` is the line for a message that has been taken and not yet answered for, and **today you
will rarely catch it**: the actor awaits an effect handler inline, and the status emit a cell's
transition produces is published after the effects of that same transition — so the line moves
straight to `delivered …` when the request comes back. It is the truthful line about the state and
it is not yet a live "in flight" indicator. Whether a handler should be awaited inline is
kamp-us/phoenix [#9297](https://github.com/kamp-us/phoenix/issues/9297), which is not this package's
to answer; when it is answered, `sending` starts showing without a line of this program changing.

What this package *does* own is the ceiling on how long that can last: every request carries
`AbortSignal.timeout` — ten seconds by default, or the target's own `timeoutMs` — because `fetch`
has none of its own and a receiver that accepts the connection and then goes quiet would otherwise
hold the request, and the inbox behind it, for minutes. Giving up reads as `{ok: false}` with no
status, exactly like a socket that never connected.

## No secrets, anywhere

A webhook URL is not a coordinate — it is a credential. Anyone holding it can post as you, and the
same is true of an `Authorization` header and of an ntfy topic.

So **none of them is ever written down**. Tuval checkpoints a program's state to disk and hands it
to a window, so anything on that record is a thing written down and shown to whoever opens the desk.
The target lives in the closure `notify(...)` was called with; what state carries about it is the
word `webhook`, `ntfy` or `stdout` and not one character more. Nothing here logs a URL either,
including on the failure path: a `fetch` that throws carries the URL in its own message, so the
cause is swallowed and the answer is `ok: false` with no status. `notify.unit.test.ts` checks this
by stringifying the whole state *and* the whole effect list and grepping for the token.

## The morning brief leaving the desk — and the one blocker left

This package exists so that `@kampus/tuval-cron`'s 07:00 brief reaches a phone. **That wiring
cannot be written in a config today** — but only one thing stands in the way now, and it is
upstream, and it is pinned by a test in this package so that the day it is lifted, the suite says so.

**Cron has somewhere to leave from.** Its `brief` out-port carries the whole finished `TurnResult`,
declared over `TurnResultSchema` out of `@kampus/tuval/ai-agent/ports`. (Its `result` is still a
cell over the reply its spawned job sends back — an internal arrival, not a port — so the line a
graph node writes is `{port: "brief", to: …}`.)

**And the two ends agree on the payload exactly.** `message` is declared over that same shipped
`TurnResultSchema` — the identical object, not a struct a turn happens to satisfy. That matters
because the fit rule is **exact schema equality**, not structural compatibility: a
`Schema.Struct({text})` would decode a `TurnResult` happily and still be refused at compile, which
is the worst of both. So `message` takes a `TurnResult` and nothing else, and no adapter sits on
either side of the route.

**What is left is the kind.** An authored port's `kind` carries its own program's id, and a route
requires the two ends' kinds to be **identical** — `apps/tuval/src/authoring/port.ts`'s
`portKind = (program, name) => \`${program}/${name}\`` against `apps/tuval/src/ports/compile.ts`'s
`if (source.kind !== target.kind) …IncompatibleRoute`. So `morning-brief/brief` cannot reach
`notify/message` whatever the payloads say — this is kamp-us/phoenix
[#8923](https://github.com/kamp-us/phoenix/issues/8923), `p1`, answered by PR
[#9292](https://github.com/kamp-us/phoenix/pull/9292), **in review**. It is refused at `compile`,
before boot, so a config carrying the route does not start.

This is what it will look like the day #9292 lands — and it is the shape the fixture beside this
package already holds, as `BLOCKED_ROUTE`, out of the default export:

```ts
// NOT YET: `IncompatibleRoute` at compile, before boot — phoenix #8923 / PR #9292.
export default {
  version: 1,
  programs: [morningBrief, phone],
  graph: {
    nodes: [
      {id: "morning-brief", program: "morning-brief",
       on: [{port: "brief", to: {node: "notify", port: "message"}}]},
      {id: "notify", program: "notify", on: []},
    ],
  },
} satisfies TuvalConfigInput;
```

### What works today: the spell

```
:notify send 3 PRs merged on phoenix, 1 red on main
```

A `commands` entry ([ADR 0372](https://github.com/kamp-us/phoenix/blob/main/.decisions/0372-a-tuval-command-may-only-send.md)
as #8898 amended it) that does a bare `send("message", {text, items: [], ok: true})` into this
program's own live process — so the manual path and the routed one are the same payload in the same
cell, and the day the route compiles nothing about the program changes. Named notifiers get their own spell: `:phone send …`,
`:desk send …`. The text is a rest parameter, so it needs no quotes.

## How it delivers

**Subs observe; handlers perform** ([#8716](https://github.com/kamp-us/phoenix/issues/8716) R12.1).
Delivery is one unit of work a cell asked for, so it runs in an **effect handler**.

The six kernel effects an authored program gets for free — spawn, send, ask, stop, emit, reply — do
not include an HTTP request, so this program **names an effect of its own**
([#9295](https://github.com/kamp-us/phoenix/pull/9295)). `Deliver` is that effect, and it is two
halves: the type goes on `defineProgram`'s last type argument, and the handler goes onto the
compiled row by spread, under the effect's own `type` string — which is the key the actor dispatches
on.

```ts
const row = defineProgram<NotifyState, Ports, Update, Commands, unknown, Deliver>({…});
return {...row, handlers: {...row.handlers, deliver: deliverHandler(liveTransport(target, io), now)}};
```

The loop, then, is: a message arrives and goes into an **outbox on state**; whichever cell put that
message in the outbox's in-flight slot answers `deliver(...)` for it; the handler performs the
request and answers `delivered`; that cell drains the slot, and if the queue has a next message it
answers `deliver` for that one. One delivery at a time, in arrival order, and no queue of Promises
anywhere. A cell that moves no message into the slot — a second arrival that only joined the queue,
a refused one — asks for nothing at all, which is what an idle notifier costs.

The target is not on the effect. `Deliver` carries the message; the credential lives in the live
`Transport` layer the handler was built with, because an effect is dispatched, named in a
`HandlerFailed` and read by anything watching the loop, and a credential belongs in none of those.

That layer is the one seam a test moves, and it is a second argument to `notify` rather than a knob
inside the suite — so what a test runs is the binding on the row, the function a desk dispatches to:

```ts
const fake = fakeTransport({ok: false, status: 500});
const row = notify({target: {kind: "ntfy", topic: "t"}}, fake.layer);
await Effect.runPromise(row.handlers.deliver(deliver({key: "notify-1", text: "five lines"})));
fake.sent; // [{key: "notify-1", text: "five lines"}]
```

A config passes nothing and gets `liveTransport(target, io)`.

The queue is in the state because that is the only place a restart can see it — which makes delivery
**at-least-once**: a message that was in flight when the desk went down is still on the checkpoint,
and the `restored` cell answers `deliver` for it again. A duplicate notification is the right side to
fail on; a notifier that silently drops the one message it was given is worse than useless.

*This used to be a dep-keyed Sub keyed on the in-flight message's key.* It worked, and it was the
wrong shape: a Sub is long-lived work that watches something and pushes what it sees, and a webhook
POST watches nothing. Nothing about the outbox or its invariants moved; only the thing that performs
did.

### The outbox is bounded, and nothing is lost quietly

The outbox holds **sixteen** messages, the one in flight included. When a seventeenth arrives, the
notifier **refuses the arrival** — and says so:

```
{text: "one too many", ok: false, reason: "dropped: outbox full", at: 1789048812000}
```

That record goes to the head of the history *and* out on the `delivered` port, so a listener hears
the refusal exactly the way it hears a 500, and the tile reads
`delivered 07:00 · dropped: outbox full` once there is nothing left in flight. The one message this
notifier could not take is the loudest thing on the board, not the quietest.

The two other things it could have done are both worse. Dropping the **oldest** evicts a message it
already accepted — and the oldest is the one a request has already been sent for, so the eviction
drops the message a `Deliver` is in flight for and the answer to it is recorded against nothing at
all. Dropping the newest arrival *silently* loses the same message for a reader, with no record
anywhere. So: refuse, and write it down.

That the in-flight message is never what goes is **structural, not a rule anyone has to keep**. The
outbox is `{inflight: Outgoing | null, queue: Outgoing[]}` — the message being delivered is a field,
not the zeroth cell of an array — so there is no index by which an arrival could reach it. Only the
`delivered` cell, which holds an answer, ever moves `queue`'s head into `inflight`.

## The window

The tile holds two lines, and the second of them is a verdict — `delivered 07:00 · ok`. A verdict is
not what a person came to read. What went out *was* the morning brief; so a notifier also brings its
own window, and it is shaped like a chat, because that is what it is.

```
phone · ntfy
delivered 07:00 · ok

  the desk is up
  06:12  ok

  3 PRs merged on phoenix, 1 red on main …
  07:00  ok · 200

  deploy failed on staging
  07:04  failed · 500

[ a line to send………………………… ]  [ Send ]
same as :phone send <text>
```

**The log** is every message this notifier sent, newest at the bottom, nearest the composer. Each
row is the message's first line (with an ellipsis when there was more of it — the rest went to the
target, which is where it was going), the clock, and how it ended: `ok`, `ok · 200`, `failed · 500`,
`failed · no answer`, `failed · dropped: outbox full`. A failure is the one thing in the window with
a colour. A message that has left and not been answered for is drawn at the bottom of the same list
as `sending…`, with a count of anything queued behind it.

**Both paths land in that one log.** `:phone send …` and a routed brief are the same arrival in the
same cell, so there is no "manual" section and no "automatic" one — the history does not know which
it is looking at, and neither does the window.

**The composer** is a text box and a Send button, and Enter sends. Empty text does nothing — not a
refusal, not a record, nothing. `WindowHost` offers `dispatch` and no spell call, and `:<id> send
<text>` is itself a bare `send("message", asTurn(text))` — so the button dispatches the same arrival
into the same cell. The composer is the spell without the palette. A full outbox refuses what the
composer sends exactly as it refuses anything else, and the refusal shows up as a row in the log.

**No target, ever.** The heading is `phone · ntfy` and not one character more about where a message
went. The window is handed this program's state, and the state carries the word `ntfy` and no URL,
no header and no topic — which is the rule the "No secrets, anywhere" section above is about, seen
from the window's side. There is nothing here to leak.

**How the window gets to the browser.** The row carries
`renderer: {kind: "module", ref: "@kampus/tuval-notify/window"}` and the desk's page imports that
specifier itself at boot ([ADR 0359](https://github.com/kamp-us/phoenix/blob/main/.decisions/0359-tuval-window-renderer-is-a-module-specifier.md)).
The other route — an authored `window` field on `defineProgram` — does not work for a package: it
seats the renderer in a map inside the *kernel* process, which the browser tab cannot reach
(phoenix [#8811](https://github.com/kamp-us/phoenix/issues/8811), open).

**What that asks of your config, and it is not nothing.** The page resolves the specifier from the
config module that declared the row, not from the app (phoenix #8262). So `@kampus/tuval-notify`
has to resolve from beside your `tuval.config.ts` — `pnpm add` it in `~/.tuval/`, or link it there —
and this package has to have been **built**, because `./window` points at `dist/window.js`. A
specifier that resolves from neither there nor the page root **refuses the page at boot**, naming
the specifier and your config:

```
the page server did not start: renderer module "@kampus/tuval-notify/window" does not resolve
from ~/.tuval/tuval.config.ts, the config that declared it; is the package installed
beside that config?
```

The kernel is unaffected either way — the notifier still delivers and `:phone send …` still works —
but the desk has no page until it resolves.

**The browser half sees no kernel, and that is checked twice.** `src/window.tsx` may reach
`@kampus/tuval/window` (the browser-safe door), `effect`, `react` and this package's kernel-free
`src/state.ts`; it may not reach `src/notify.ts`, which imports `@kampus/tuval/authoring` and
through it `node:crypto`. `tsconfig.window.json` keeps that true at compile time by including
nothing but the window and its leaves, and `state.unit.test.ts` walks the imports from
`window.tsx` and names the whole reachable set — so a new edge across that line fails the suite by
addition rather than at boot in somebody's tab.

**One upgrade note, and it costs you rows.** The log reads the `text` off each delivery, and a
checkpoint written by a version before this one carries deliveries that have a verdict, a clock and
no message. Those records **are dropped on restore** — one `filter` in the `restored` cell, which is
the honest place for a migration.

It has to be there rather than tolerated in the window, because `admits` is all-or-nothing: three
text-less records at the head of a checkpoint would make the window refuse to draw the fifty good
ones behind them. Dropping on the way back in costs the unreadable rows and nothing else.

What that changes on the tile: **nothing counts deliveries there**, so no number is wrong
afterwards. The status line reads the *newest* record, though — so a desk whose newest deliveries
were all written before this version comes back reading `idle` rather than the verdict it showed
before the restart. That is the truthful line about a history this version cannot read.

## How it relates to Tuval

This is a Tuval **program**, built on `defineProgram` out of `@kampus/tuval/authoring`. Everything
around the program is the kernel's: the board tile is what the kernel renders from the `title` and
`status` lines this program publishes; checkpoint and restore are the kernel's, and this program's
only part in them is the `resume` that re-reads `id` and `kind` off your config; the
`:notify send` spell is a `commands` entry the kernel compiles and registers under the program id,
so it is addressable from the command line, a key binding, or an agent, with nothing hand-written on
the caller's side; and the window is the kernel's too — the row names a module specifier and the
desk's page imports it, so this package writes a React component and nothing about how it is mounted.

## Install, and the honest dependency

```bash
pnpm add @kampus/tuval-notify
```

**No runtime dependencies.** Everything is a peer: `@kampus/tuval`, `effect`, `@demlik/tea`.

`@kampus/tuval` is **private and not published to npm**. This package now lives in the same
workspace as Tuval does, so the dependency is a plain workspace one —
`"@kampus/tuval": "workspace:*"` — and pnpm resolves it to `apps/tuval` in this repo with no path
link and no second checkout anywhere. It becomes a real version range the day Tuval ships to a
registry; nothing in the source changes with it, because the source already imports only through
the published doors (#8943, #9250):

- `@kampus/tuval/authoring` — `defineProgram`, `port`, the effect constructors (`send`/`emit`),
  `testProgram`, `TITLE_PORT`/`STATUS_PORT`, and the types around them
- `@kampus/tuval/sessions` — `TuvalConfigInput`, which only a config needs
- `@kampus/tuval/ai-agent/ports` — `TurnResultSchema`, which `message` is declared over; `state.ts`
  names its encoded type **type-only**, so the built `state.js` a browser loads imports nothing of it
- `@kampus/tuval/window` — `windowRenderer` and `WindowHost`, the browser-safe half, whose own import
  closure reaches no `node:` builtin. `src/window.tsx` is the only file that touches it

Nothing reaches `@kampus/tuval/src/...`; the exports map would refuse it anyway.

## Settings this package borrows from Tuval

Two settings here are not this package's taste. They are restatements of `apps/tuval`'s, and they
exist because `@kampus/tuval` is consumed as **raw TypeScript source**: its `exports` map points at
`src/*.ts` and it ships no `.d.ts`. Both go away the day Tuval publishes built declarations.

**`tsconfig.json`: `lib: ["ES2023", "DOM", "DOM.Iterable"]` and `exactOptionalPropertyTypes: false`.**
Tuval's whole reachable source tree enters this program and is checked under *these* options —
`skipLibCheck` covers declaration files and does nothing for source. These lines are
`apps/tuval/tsconfig.json`'s, restated, and a consumer that picked its own would be told about
`findLast`, `Element` and the MCP SDK's optional props in code it does not own.

**`vitest.config.ts`: `resolve.dedupe: ["effect", "@demlik/tea"]`.** One workspace and one
`catalog:tuval` pin already give the suite a single `effect`, so this line is belt and braces here
rather than the load-bearing fix it was when Tuval was reached by path at an outside checkout — two
instances meant a `Schema` built by one was a stranger to a decoder from the other. It stays because
the day this package is consumed from npm beside an unhoisted Tuval, that failure comes back, and it
costs nothing now.

## Trust model — read this

Tuval runs local program code with **full trust and no sandbox, ever**. Installing this package is
exactly as consequential as installing a Neovim plugin: it runs with your user's authority. This one
holds a credential — the webhook URL or the ntfy topic you hand it — and **sends text off your
machine to a URL of your choosing**. What it sends is whatever reached its `message` port, so a
notifier wired to a cron whose job is an AI-agent session is a notifier publishing whatever that
session wrote. Read the target you configured and the prompt that feeds it as one thing, because
they are one thing.

## Testing

```bash
pnpm test
pnpm typecheck   # the kernel lens and the window's, both
pnpm build       # emits dist/, which is what `./window` points at
```

Eighty-seven cases over `testProgram`, the pure state→view functions, a stated clock and a `fetch`
that is a spy — no kernel, no desk, no network, no real webhook. `testProgram` does not perform effects,
so the suite closes the loop the way the actor does: it takes the `Deliver` a step answered, runs
this package's **own** `deliverHandler` over a `Transport` layer the case chose, and feeds the
events it resolves to back into the run. Most cases choose `fakeTransport()`; the one that asserts
the URL, the method, the headers and the body chooses `liveTransport(...)` over the spy `fetch`, and
the round-trip case reaches `row.handlers.deliver` through `notify(options, transport)` — so what
runs is the binding a desk dispatches to, not a lookalike. The timeout is exercised with a `fetch`
that only ever settles because the signal aborted. `notify.unit.test.ts`'s header says how.
