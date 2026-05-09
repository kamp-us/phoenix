import m0000 from "./0000_kind_squadron_supreme.sql";
import journal from "./meta/_journal.json";

const migrations: {
	journal: typeof journal;
	migrations: Record<string, string>;
} = {
	journal,
	migrations: {
		m0000,
	},
};

export default migrations;
