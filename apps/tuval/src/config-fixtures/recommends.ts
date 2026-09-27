/** A layer recommending two packages, one of them listed twice (#9695). */
export default {
	version: 1,
	programs: [{id: "a"}],
	recommends: ["@kampus/tuval-worktree", "tuval-cron", "@kampus/tuval-worktree"],
};
