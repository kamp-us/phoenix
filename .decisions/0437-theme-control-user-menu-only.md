---
id: 0437
title: The theme control rides the user menu when signed in, and a signed-out visitor gets none
status: accepted
date: 2026-09-30
tags: [design, frontend, navigation, information-architecture, manifest, theme]
---

# 0437 — The theme control rides the user menu when signed in, and a signed-out visitor gets none

**What this decides:** a signed-in user has exactly one theme picker, in the user menu. A
signed-out visitor has no theme picker anywhere and the page follows the OS theme.

## Context

[ADR 0176](0176-nav-ia-discipline.md) verdict 2 (#2588) killed the topbar theme toggle and made
the profile page's light/dark/auto picker the single theme control, with "no user-menu item". It
also flipped `DEFAULT_CHOICE` to `auto` so signed-out visitors follow the OS.

The shipped code drifted from that verdict. #2612 put a picker in the topbar utility zone for
signed-out visitors and a second one in the user menu for signed-in users, and #6660 pinned the
topbar picker's presence in the boot/session-divergence state as a tested invariant. The profile
page kept its own picker too, so a signed-in user saw two. The design manifest still said "profile
page only", so the law `review-ui` judges against disagreed with the code
([#6791](https://github.com/kamp-us/phoenix/issues/6791)).

The founder ruled the placement on 2026-09-02:
https://github.com/kamp-us/phoenix/issues/6791#issuecomment-5519864859. Asked whether to ratify
what shipped, he said yes with one change: "no theme picker for logged out, maybe use system theme
dunno". This record transcribes that ruling. It amends ADR 0176 in part: verdict 2's placement
clauses change, and its `DEFAULT_CHOICE = auto` clause and the rest of 0176 still hold.

## Decision

**A signed-in user gets exactly one theme control, in the user menu; a signed-out visitor gets no
theme control and follows the OS theme.**

1. **Signed in:** the theme picker renders once, as a row in the user menu. The user menu zone
   already admits account-scoped utilities under ADR 0176's zone grammar, so the grammar does not
   change.
2. **Signed out:** no theme picker renders anywhere on the page. The visitor's theme is the OS
   preference, through the `auto` default ADR 0176 verdict 2 set.
3. **Any state with no user menu** gets no theme control. That includes the boot/session-divergence
   state #6660 worried about, where a `user` is present but the account side is gated shut.

**Banned.**

- A theme picker in the topbar, in any state.
- A second theme picker for a signed-in user, on the profile page or anywhere else.
- A theme picker for a signed-out visitor.

## Consequences

- The design manifest's class table and element-taxonomy row name the user menu as the theme
  control's zone, and `review-ui` can use that row as a blocking law row again.
- The topbar loses its theme props and the profile page loses its theme row. Tests pin the absence
  of any theme control when signed out and in the divergence state, where #6660's tests pinned
  presence.
- A signed-out visitor who wants a different theme than the OS has to sign in or change the OS
  setting. The founder accepted that trade.
