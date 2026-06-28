// Per-test DOM teardown for the `client` vitest tier (#1419). Testing Library's
// auto-cleanup only fires when Vitest globals are on; this project keeps explicit
// imports, so unmount-after-each is wired here instead, keeping each `*.test.tsx`
// isolated.
import {cleanup} from "@testing-library/react";
import {afterEach} from "vitest";

afterEach(cleanup);
