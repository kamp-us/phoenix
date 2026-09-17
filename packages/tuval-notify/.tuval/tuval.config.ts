/**
 * The consumer path, as a file rather than as a claim: what a Tuval user writes in
 * `~/.tuval/tuval.config.ts` to get a morning brief *and* a way to send it off the desk. It is a
 * fixture here — `notify.unit.test.ts` imports it and reads the rows back — so the usage in the
 * README is checked by the test suite instead of being prose that drifts.
 *
 * Nothing in it boots a desk, spends a token or calls a webhook: `cron({…})`, `notify({…})` and
 * `claudeSession({…})` each build a *row*, and a row is a record. The `fetch` this file's notifier
 * would use is never called, because nothing here ever puts a message on its port.
 *
 * **The graph is deliberately unwired, and one thing is left in the way.** The composition this
 * package exists for is `cron.brief → notify.message`, and both ends of it are now in place: cron
 * declares a `brief` out-port over `TurnResultSchema` (#416), and this package's `message` in-port
 * is declared over that same shipped schema, so the two ends agree on the payload exactly rather
 * than approximately.
 *
 * What is left is the route. An authored port's `kind` is `<program-id>/<port-name>` and
 * `resolveRoute` requires the two ends' kinds to be **identical**, so `morning-brief/brief` cannot
 * reach `notify/message` whatever the payloads say — kamp-us/phoenix **#8923**, answered by PR
 * **#9292**, in review. That PR's fit rule is exact schema equality, which is the reason `message`
 * is `TurnResultSchema` itself and not a struct a turn merely satisfies.
 *
 * So the working path today is still the spell: `:notify send "…"`. See the README.
 */

import { cron } from "@kampus/tuval-cron";
import { notify } from "@kampus/tuval-notify";
import {
  ClientId,
  claudeSession,
  type TuvalConfigInput,
  WorkspaceId,
} from "@kampus/tuval/sessions";

/** One workspace, one client — the two branded ids `claudeSession` will not build a row without. */
const scope = {
  workspace: WorkspaceId.make("default"),
  client: ClientId.make("tuval-desk"),
};

/** The brief itself: a Claude session, asked the same question every morning. */
export const morningBrief = cron({
  id: "morning-brief",
  schedule: "0 7 * * *",
  prompt:
    "Using the gh CLI, summarize what changed on this repo in the last 24 hours. Five lines max.",
  job: claudeSession({ cwd: "/tmp/tuval-notify-fixture", scope }),
});

/**
 * The way off the desk. `ntfy` because it is the shortest path to a phone there is — no account, no
 * key, no SDK — and the topic is the whole of the secret, which is why it lives in this call and
 * never on the program's state.
 */
export const phone = notify({
  target: { kind: "ntfy", topic: "can-tuval", title: "Morning brief" },
});

/**
 * A second notifier, and the only reason it is here: a config with two of them is where `id` earns
 * its place. Named, so it is its own program, its own graph node and its own `:desk send "…"` —
 * where an unnamed second row would collide with `phone` on all three.
 */
export const desk = notify({ id: "desk", target: { kind: "stdout" } });

/**
 * The route this package was written for, written out — and kept **off** the default export,
 * because a config carrying it does not boot. `IncompatibleRoute` is raised at `compile`, before a
 * single program starts, so shipping it in the fixture would mean shipping a config that refuses.
 *
 * It leaves from `brief`, which is a real out-port now, and lands on a `message` declared over the
 * very schema `brief` announces — so the payload half of the fit is already satisfied. The kind
 * half is not, and that is the whole of what is left: the day #9292 lands, the change is moving
 * this constant into `graph.nodes` and deleting this paragraph.
 */
export const BLOCKED_ROUTE = {
  id: "morning-brief",
  program: morningBrief.id,
  on: [{ port: "brief", to: { node: "notify", port: "message" } }],
} as const;

export default {
  version: 1,
  programs: [morningBrief, phone, desk],
  graph: {
    nodes: [
      { id: "morning-brief", program: morningBrief.id, on: [] },
      { id: "notify", program: phone.id, on: [] },
      { id: "desk", program: desk.id, on: [] },
    ],
  },
} satisfies TuvalConfigInput;
