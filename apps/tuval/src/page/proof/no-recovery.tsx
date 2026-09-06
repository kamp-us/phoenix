/**
 * The same page with its connection lifecycle turned off — the browser proof's negative control.
 *
 * It exists so the proof's fresh-output assertion is falsifiable: a journey that only ever runs the
 * recovering page cannot tell "recovery worked" from "the assertion would pass anyway". This entry
 * differs from `../main.tsx` in one value, `noRecovery`, and shares its boot and its stylesheet
 * order with it, so nothing else can account for the difference the proof measures.
 */

import {bootPage} from "../boot.tsx";
import {noRecovery} from "../connection.ts";
import "../styles.ts";

bootPage({recovery: noRecovery});
