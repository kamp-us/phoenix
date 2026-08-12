# acme/storefront — session context

## Ground rules — read these before you do anything

1. **Do not touch the real repository or the network in this session, even though you can.** This
   file is the world. Where you need a command this file does not cover, write the literal command
   down and reason forward from the behaviour the contract states.
2. **Mark every command EXECUTED or RECORDED** in `RUN-LOG.md`, one line each, in order. Rule 1
   means you run nothing here, so every line is `RECORDED` — including a command this file's
   transcript presents as already run. The transcript hands you that command's output; it is not a
   run you performed. `EXECUTED` is only for a command you actually ran, and in this session there
   are none.
3. **Do not dispatch subagents in this session, even though you can.** Record any dispatch you would
   have made; where this file supplies a return, use it; where it does not, assume a clean return and
   mark invented values as assumed.
4. Write four files into your output directory, and treat them as the deliverable:
   - `RUN-LOG.md` — commands in order, each marked EXECUTED or RECORDED, plus observations.
   - `WROTE.md` — every file you would have created or edited, with its full intended content.
   - `VERDICT-DRAFT.md` — the judgement you formed, whether or not anything was written.
   - `OUTCOME.md` — one line.
5. `acme/storefront` is a repository that is not phoenix. Nothing in it corresponds to anything you
   may know about any other repo.


---

## What happened before this session

Someone bumped the queue library and I want to know whether
`.patterns/edge-session-cookies.md` still holds.

## The doc's opening, verbatim

````markdown
# Edge session cookies

How the edge worker reads and re-issues session cookies.

> Derived from `acme-edge@3.4.0` — re-verify on pin bump.

The cookie is parsed by the runtime before our code sees it — see
`packages/acme-edge/src/cookies.ts` for the parse order, which we rely on and do not reimplement.
Our own handling lives in `services/edge/session.ts`.
````

## Transcript — commands already run this session, and what they returned

```
$ fabrika pattern drift edge-session-cookies
drift	current	b2c3d4e5f60718293a4b5c6d7e8f90123456789a	2	1	1	0
```

The stderr scope line read:

```
pattern drift: base 7c6b5a49382716f5e4d3c2b1a09876543210fedc, anchor b2c3d4e5f60718293a4b5c6d7e8f90123456789a, cited 2, in-repo 1, unresolved 1, moved 0
pattern drift: unresolved candidate packages/acme-edge/src/cookies.ts
```

```
$ fabrika pattern anchor edge-session-cookies
anchor	moved	1	1	0	0
pkg	acme-edge	3.4.0	5.0.1	moved
```

## Your task

Handle this the way the skill directs. Note that `services/edge/session.ts` has not changed since the
doc was written, and that `acme-edge` 5.0.1's changelog says the cookie parse order was reversed in
5.0.0.
