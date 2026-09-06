/**
 * The page's entry. Everything it mounts is `./boot.tsx`'s and the socket it runs on is
 * `./connection.ts`'s; the stylesheet order is `./styles.ts`'s, shared with the browser proof's
 * negative arm so the two entries cannot drift apart on the one thing an entry owns.
 */

import {bootPage} from "./boot.tsx";
import "./styles.ts";

bootPage();
