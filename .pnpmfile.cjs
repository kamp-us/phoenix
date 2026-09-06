// Re-adds the root's `fabrika` binstub edge at install time so it never appears in the root
// package.json on disk: turbo reads that file to build its graph, and a root->internal edge puts
// every file of that package in the global hash, so one fabrika-cli change misses the cache for
// all 24 packages (#8277).
"use strict";

const ROOT_PACKAGE_NAME = "phoenix";
const FABRIKA_CLI = "@kampus/fabrika-cli";

function readPackage(pkg) {
	if (pkg.name !== ROOT_PACKAGE_NAME) return pkg;
	pkg.devDependencies = {...pkg.devDependencies, [FABRIKA_CLI]: "workspace:*"};
	return pkg;
}

module.exports = {hooks: {readPackage}};
