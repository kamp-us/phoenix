# @kampus/tuval-sdk

The Tuval SDK. Write a Tuval program against it and test that program without the desk. It holds
the program authoring API, the window renderer contract, the AI-agent port vocabulary and runtime,
and the kernel the desk runs programs on.

It carries no React, no design system and no agent vendor SDK. Its runtime dependencies are
`effect` and `@demlik/tea`, pinned to the versions it was built against.

## Install

```sh
npm install @kampus/tuval-sdk
npm install effect@"$(npm view @kampus/tuval-sdk dependencies.effect)"
```

The package ships ES modules with type declarations. The second line installs `effect` at the exact
version the SDK pins, so your port schemas and the SDK's share one copy of it.

## Write a program

A program is plain data: its ports, its initial state, and one `update` cell per arriving event.
Each cell answers the next state and the effects to run.

```ts
// counter.ts
import {defineProgram, emit, port, program} from "@kampus/tuval-sdk/authoring";
import {Schema} from "effect";

export const counter = program({
	id: "counter",
	ports: {add: port.in(Schema.Number), total: port.out(Schema.Number)},
	init: () => ({total: 0}),
	update: {
		add: (state, event) => {
			const total = state.total + event.payload;
			return [{total}, [emit("total", total)]];
		},
	},
	title: (state) => `total ${state.total}`,
});

// The compiled row a desk config lists.
export const counterRow = defineProgram(counter);
```

## Test it

`testProgram` drives a program with no kernel and no desk. Each step decodes the payload through the
port's own schema, runs the cell, and answers the new state and the effects the program asked for.

```ts
// counter.test.ts
import {emit, testProgram} from "@kampus/tuval-sdk/authoring";
import {expect, test} from "vitest";
import {counter} from "./counter.js";

test("adds what arrives on the add port", () => {
	const run = testProgram(counter).send("add", 2).send("add", 3);
	expect(run.state).toEqual({total: 5});
	expect(run.effects).toContainEqual(emit("total", 5));
});

test("refuses a payload the port's schema rejects", () => {
	expect(() => testProgram(counter).send("add", "two")).toThrow();
});
```

A run also takes `.event(…)` for a program's own events and answers, `.key(…)` for a forwarded
keystroke, and `.call(…)` for a declared command.

## Exports

| Subpath | What it carries | Stability |
|---|---|---|
| `@kampus/tuval-sdk/authoring` | `program`, `defineProgram`, `port`, `programArgs`, `Program`, the effect constructors, `testProgram`, and the types an authored program annotates itself with | the authoring API |
| `@kampus/tuval-sdk/window` | `windowRenderer`, `WindowHost` and `ProgramEvent` for a module window; browser-safe | the authoring API |
| `@kampus/tuval-sdk/ai-agent/ports` | the AI-agent port vocabulary: `PromptPayloadSchema`, `TurnResultSchema` and the rest | the authoring API |
| `@kampus/tuval-sdk/kernel/*` | any kernel module by its path, without the extension, e.g. `@kampus/tuval-sdk/kernel/process/Processes` | **unstable** |

**`./kernel/*` is unstable.** It is public so the desk app,
[`@kampus-apps/tuval`](https://github.com/kamp-us/phoenix/tree/main/apps/tuval), uses the SDK only
through published exports, the way an outside project would. It is not an API: a kernel module can
move, change or disappear in any release, with no major version bump. A program should need nothing
from it.

## Development

The package lives in the [phoenix](https://github.com/kamp-us/phoenix) monorepo at `packages/tuval`.

```sh
pnpm --filter @kampus/tuval-sdk typecheck
pnpm --filter @kampus/tuval-sdk test
pnpm --filter @kampus/tuval-sdk build
```

Inside the workspace the `exports` map points at `src/*.ts`, because the desk runs this source under
Node's native type-stripping with no build step. That is why relative imports carry an explicit
`.ts` extension. `pnpm pack` builds `dist` and swaps in `publishConfig.exports`, which points at
`dist` only. `src/public-surface.pack.test.ts` packs the package and pins that published map.
