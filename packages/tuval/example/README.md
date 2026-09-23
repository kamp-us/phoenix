# Tuval SDK example program

A program written the way an outside author writes one: it imports only `@kampus/tuval-sdk/*` and
public npm packages, and it is not a workspace member. CI copies it out of the checkout, installs
the packed SDK into it with npm and runs its type-check and test there
(`pnpm --filter @kampus/tuval-sdk run proof:outside`, source in [`../proof/`](../proof/)).

`vitest` is pinned to 3.x because the SDK's `@demlik/tea` dependency declares an optional vitest
peer of `^2 || ^3`, and npm refuses a newer vitest beside it
([#9708](https://github.com/kamp-us/phoenix/issues/9708)).
