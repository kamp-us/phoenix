# Assembling `AgentChatInput` from its compound parts

`packages/design/src/AgentChatInput.tsx` exports the composer twice over: as the whole component,
and as compound members a host assembles itself. The whole export is now literally that assembly,
so the two can't drift.

## The anatomy, in the order the export renders it

```tsx
<AgentChatInput.Root {...props}>
  <AgentChatInput.Frame>                 {/* the labelled section */}
    <AgentChatInput.Surface>             {/* the card */}
      <AgentChatInput.Form>              {/* the form; it wires submit off the Root */}
        <AgentChatInput.Field />         {/* attachments, textarea, completion listbox */}
        <AgentChatInput.Toolbar />       {/* Attach + Settings + Overflow, then PrimaryActions */}
      </AgentChatInput.Form>
      <AgentChatInput.Error />
    </AgentChatInput.Surface>
    <AgentChatInput.Inspector />
    <AgentChatInput.ExtensionDialog />
  </AgentChatInput.Frame>
</AgentChatInput.Root>
```

## The rules a host has to know

- **The composer has one chrome.** There is no `variant` prop and no second shape to pick between:
  every host gets the same card, the same toolbar and the same pickers (ADR
  [0369](../.decisions/0369-agent-composer-has-one-chrome.md)). What a host still names is
  `deliveryRule` — how a send goes out, `queue-while-working` unless it says otherwise.
- **Every part except `.Control` reads the Root context, and throws outside one**
  (`packages/design/src/agent-chat/Root.test.tsx`). `.Frame` and `.Surface` paint no state of their
  own and read it only to hold that guard. That is also why the host itself cannot reach
  the state: a host renders `Root`, so it is the parent of the provider, not a child of it. Anything
  needing `submit`, `addImage` or the draft is a part — `.Form` and `.Attach` exist for exactly that
  reason.
- **`.Settings` and `.Toolbar` children *replace*, they do not append.** `.Settings` children stand
  in for both the composer's own rows and the `settings` slot; `.Toolbar` children stand in for the
  left group only, because a host that dropped the send group would have a composer nothing leaves.
- **A host that wants the composer's rows *and* one of its own puts `.Pickers` in `.Settings`'s
  children beside it** — that is the whole reason `.Pickers` is a part. Tuval's chat window does
  this with its mode picker (`apps/tuval/src/shell/chat/ChatWindow.tsx`), which is what replaced its
  use of the `settings` slot.
- **Class names belong to the parts, not to call sites.** Assembling by hand means placing parts,
  never re-typing `kp-agent-chat__*` markup; a host that reaches for a wrapper the parts do not
  offer is asking for a new part.

Both shapes are on the atölye — `agent-chat-input` takes the component whole,
`agent-chat-input-parts` assembles it
(`apps/web/src/lab/atolye/exhibits/AgentChatInput.exhibit.tsx`).

The parity check lives in `packages/design/src/AgentChatInput.test.tsx`: the hand-assembled tree
must render the markup the plain export renders. What it compares is the whole `Frame` subtree
*including the section's own attributes* — the `kp-agent-chat` class and the `aria-label` — plus
what `ExtensionDialog` paints, which Manti portals to `document.body` and so lands beside the render
container rather than inside it. Before #8711 the comparison read the
`[data-testid="agent-chat-input"]` Card's `innerHTML`, which left `Frame`, `Inspector` and
`ExtensionDialog` outside it entirely.

Two of those three render nothing at rest, so the test drives them: it pushes a
`tool_execution_start` event for `Inspector` to list, opens its disclosure, and raises an
`extension_ui_request` for `ExtensionDialog`, then asserts each part's markup is in the compared
string. Adding a part that renders only in some state means driving that state here too —
a part that is `null` on both sides compares equal and is not covered.
