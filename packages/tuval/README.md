# @kampus/tuval

The Tuval SDK. It holds what a Tuval program is written against and what the desk runs it on: the
program authoring API, the window renderer contract, the AI-agent port vocabulary and runtime, and
the kernel (registry, processes, ports, checkpoints, the actor host, spells and the wire protocol).

It exists so that code outside the desk app can depend on Tuval without depending on an app. The
desk itself is [`@kampus-apps/tuval`](../../apps/tuval), which builds its shell, its windows and its
agent harnesses on this package and reaches it only through the exports below.

It carries no React, no design system and no agent vendor SDK. Its runtime dependencies are
`effect` and `@demlik/tea`.

## Exports

| Subpath | What it carries | Stability |
|---|---|---|
| `@kampus/tuval/authoring` | `defineProgram`, `port`, `programArgs`, `Program`, the effect constructors, `testProgram`, and the types an authored program annotates itself with | the authoring API |
| `@kampus/tuval/window` | `windowRenderer`, `WindowHost` and `ProgramEvent` for a module window; browser-safe | the authoring API |
| `@kampus/tuval/ai-agent/ports` | the AI-agent port vocabulary: `PromptPayloadSchema`, `TurnResultSchema` and the rest | the authoring API |
| `@kampus/tuval/kernel/*` | any kernel module by its path under `src/`, without the extension, e.g. `@kampus/tuval/kernel/process/Processes` | **unstable** |

`./kernel/*` is what the desk app uses for everything beyond the three authoring doors. It is public
so the desk can use the SDK the way an outside project would, but it is not an API: a kernel module
can move, change or disappear in any release. A program should need nothing from it.

## Development

```sh
pnpm --filter @kampus/tuval typecheck
pnpm --filter @kampus/tuval test
```

Relative imports carry an explicit `.ts` extension, because the desk runs this source under Node's
native type-stripping with no build step.
