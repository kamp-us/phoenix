/**
 * A project module that registers nothing. Its being there is the point: a project with a config
 * module boots no built-in shell, so a boot over it runs exactly what the global layer plans.
 */
export default {version: 1, programs: []};
