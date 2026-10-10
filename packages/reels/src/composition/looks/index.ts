import type {LookName} from "../../reel.ts";
import {cutaway} from "./cutaway.tsx";
import type {Look} from "./look.ts";
import {paper} from "./paper.tsx";
import {poster} from "./poster.tsx";

export const LOOKS: Readonly<Record<LookName, Look>> = {cutaway, paper, poster};
