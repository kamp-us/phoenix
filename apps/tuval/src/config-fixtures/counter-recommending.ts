/** `counter-into-global-log`, recommending two packages to whoever opens it (#9695). */
import counter from "./counter-into-global-log.ts";

export default {...counter, recommends: ["@kampus/tuval-worktree", "tuval-cron"]};
