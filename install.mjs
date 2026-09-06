#!/usr/bin/env node

/**
 * PI Team Room installer helper.
 *
 * PI's native package flow is the supported install path. The legacy copy mode
 * is kept only for isolated compatibility tests and must be requested explicitly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_DIR = path.dirname(__filename);
const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, "package.json"), "utf-8"));
const PACKAGE_NAME = typeof pkg.name === "string" && pkg.name ? pkg.name : "pi-team-room";
const VERSION = typeof pkg.version === "string" ? pkg.version : "0.0.0";

const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const EXTENSION_DIR = path.join(AGENT_DIR, "extensions", PACKAGE_NAME);
const NATIVE_PACKAGE_DIR = path.join(AGENT_DIR, "npm", "node_modules", PACKAGE_NAME);
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");
const AGENTS_DIR = path.join(AGENT_DIR, "agents");

const CREW_AGENTS = [
	"crew-planner.md",
	"crew-interview-generator.md",
	"crew-plan-sync.md",
	"crew-worker.md",
	"crew-reviewer.md",
];

const DEPRECATED_AGENTS = [
	"crew-repo-scout.md",
	"crew-practice-scout.md",
	"crew-docs-scout.md",
	"crew-web-scout.md",
	"crew-github-scout.md",
	"crew-gap-analyst.md",
];

const args = process.argv.slice(2);
const isRemove = args.includes("--remove") || args.includes("-r");
const isLegacyCopy = args.includes("--legacy-copy");
const isCrewInstall = args.includes("--crew-install");
const isCrewUninstall = args.includes("--crew-uninstall");
const isHelp = args.includes("--help") || args.includes("-h");

function printHelp() {
	console.log(`${PACKAGE_NAME} v${VERSION} - Persistent PI Team Room

Usage:
  npx ${PACKAGE_NAME}                  Print PI native install guidance
  npx ${PACKAGE_NAME} --legacy-copy    Copy this package to ${EXTENSION_DIR}
  npx ${PACKAGE_NAME} --remove         Remove the legacy copy for this package
  npx ${PACKAGE_NAME} --crew-install   Show packaged Crew agent info
  npx ${PACKAGE_NAME} --crew-uninstall Remove legacy Crew agent copies
  npx ${PACKAGE_NAME} --help           Show this help

Team Runtime first run inside PI:
  /team doctor
  /team web`);
}

if (isHelp) {
	printHelp();
	process.exit(0);
}

if (isCrewInstall) {
	const agentsDir = path.join(EXTENSION_DIR, "crew", "agents");
	if (!fs.existsSync(agentsDir)) {
		console.log(`Extension not installed as a legacy copy. After publication use: pi install npm:${PACKAGE_NAME}`);
		process.exit(1);
	}

	const agents = fs.readdirSync(agentsDir).filter((file) => file.endsWith(".md"));
	console.log(`Crew agents (${agents.length}) ship with the extension:`);
	console.log(`  ${agentsDir}`);
	for (const agent of agents) console.log(`  - ${agent}`);
	console.log("\nTo customize, copy an agent to .pi/messenger/crew/agents/ and edit it.");
	process.exit(0);
}

if (isCrewUninstall) {
	let removed = 0;
	for (const agent of [...CREW_AGENTS, ...DEPRECATED_AGENTS]) {
		const target = path.join(AGENTS_DIR, agent);
		if (fs.existsSync(target)) {
			fs.unlinkSync(target);
			removed++;
		}
	}
	console.log(removed > 0
		? `Removed ${removed} crew agent(s) from ${AGENTS_DIR}`
		: "Nothing to remove");
	process.exit(0);
}

if (isRemove) {
	if (fs.existsSync(EXTENSION_DIR)) {
		fs.rmSync(EXTENSION_DIR, { recursive: true });
		console.log(`Removed ${PACKAGE_NAME} legacy copy from ${EXTENSION_DIR}`);
	} else {
		console.log(`${PACKAGE_NAME} legacy copy is not installed`);
	}
	process.exit(0);
}

if (!isLegacyCopy) {
	console.log(`${PACKAGE_NAME} v${VERSION}

Recommended install after the package name and repository are confirmed:

  pi install npm:${PACKAGE_NAME}

For local development in this checkout:

  pi --no-extensions --extension ./team-runtime/standalone-extension.ts

This helper does not write to ~/.pi by default. The legacy copy installer is
available only with --legacy-copy, preferably in an isolated HOME during tests.`);
	process.exit(0);
}

if (path.resolve(PACKAGE_DIR) === path.resolve(EXTENSION_DIR)) {
	console.log(`Already installed at ${EXTENSION_DIR} (v${VERSION})`);
	process.exit(0);
}

const isUpdate = fs.existsSync(EXTENSION_DIR);

function hasNativePackageInstall() {
	if (fs.existsSync(NATIVE_PACKAGE_DIR)) return true;
	try {
		const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
		const packages = Array.isArray(settings.packages) ? settings.packages : [];
		return packages.some((item) => item === `npm:${PACKAGE_NAME}`);
	} catch {
		return false;
	}
}

if (hasNativePackageInstall()) {
	console.log(`${PACKAGE_NAME} is already installed via PI's native package flow.

Keep the native install and remove any legacy copy instead:

  npx ${PACKAGE_NAME} --remove

Do not run --legacy-copy alongside \`pi install npm:${PACKAGE_NAME}\`; loading
both copies may register duplicate Team commands.`);
	process.exit(1);
}

if (isUpdate && fs.existsSync(path.join(EXTENSION_DIR, ".git"))) {
	console.log("Existing install is a git clone. Remove it first:\n");
	console.log(`  npx ${PACKAGE_NAME} --remove && npx ${PACKAGE_NAME} --legacy-copy`);
	process.exit(1);
}

if (isUpdate) fs.rmSync(EXTENSION_DIR, { recursive: true });

const SKIP = new Set([
	".git",
	"node_modules",
	".DS_Store",
	".pi",
	".pi-subagents",
	"work",
	"progress.md",
	"package-lock.json",
	"npm-shrinkwrap.json",
]);

function copyDir(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) copyDir(srcPath, destPath);
		else fs.copyFileSync(srcPath, destPath);
	}
}

copyDir(PACKAGE_DIR, EXTENSION_DIR);

const action = isUpdate ? "Updated" : "Installed";
console.log(`${action} ${PACKAGE_NAME} v${VERSION} -> ${EXTENSION_DIR}

Tool:       pi_team
Team:       /team doctor, /team web
Docs:       ${EXTENSION_DIR}/README.md
Connectors: ${EXTENSION_DIR}/docs/runtime-connectors.md`);
