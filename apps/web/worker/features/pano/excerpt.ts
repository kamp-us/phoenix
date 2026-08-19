/** Post and comment `bodyExcerpt` share one length, so it lives here rather than in both. */
import {excerpt as excerptText} from "../text/index.ts";

const POST_EXCERPT_LEN = 280; // tweet-sized

export const excerpt = (body: string): string => excerptText(body, POST_EXCERPT_LEN);
