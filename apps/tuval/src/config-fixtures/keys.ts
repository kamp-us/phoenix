/** A config layer that binds two keys: one bare command string, one with the repeat flag. */
export default {
	version: 1,
	programs: [],
	keys: {"ctrl-h": "help", "ctrl-x": {command: "spell list", repeat: true}},
};
