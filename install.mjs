#!/usr/bin/env node

/**
 * PI Team Room installer helper.
 *
 * `setup` is an explicit, local-only install flow for GitHub/source checkouts.
 * It copies the public package files into PI's extension directory and keeps
 * PI's native package install path compatible when npm publication is enabled.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
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
const command = args.find((arg) => !arg.startsWith("-")) ?? "";
const flags = new Set(args.filter((arg) => arg.startsWith("-")));
const isHelp = command === "help" || flags.has("--help") || flags.has("-h");
const isSetup = command === "setup" || command === "install" || flags.has("--legacy-copy");
const isDoctor = command === "doctor";
const isRemove = command === "uninstall" || command === "remove" || flags.has("--remove") || flags.has("-r");
const isLegacyCopy = flags.has("--legacy-copy");
const isCrewInstall = flags.has("--crew-install");
const isCrewUninstall = flags.has("--crew-uninstall");
const isForce = flags.has("--force");

const CONNECTORS = [
	{ id: "pi", label: "PI host", command: "pi" },
	{ id: "codex-cli", label: "Codex CLI", command: process.env.PI_TEAM_CODEX_COMMAND || "codex" },
	{ id: "grok-build", label: "Grok Build CLI", command: process.env.PI_TEAM_GROK_COMMAND || "grok" },
	{ id: "kimi-code", label: "Kimi Code CLI", command: process.env.PI_TEAM_KIMI_COMMAND || "kimi" },
	{ id: "claude-code", label: "Claude Code CLI", command: process.env.PI_TEAM_CLAUDE_COMMAND || "claude" },
];

function printHelp() {
	console.log(`${PACKAGE_NAME} v${VERSION} - Persistent PI Team Room

Usage:
  npx ${PACKAGE_NAME} setup            Install/update this extension for local PI
  npx ${PACKAGE_NAME} doctor           Check PI and optional connector commands
  npx ${PACKAGE_NAME} uninstall        Remove the local extension copy
  npx ${PACKAGE_NAME}                  Print quick start guidance
  npx ${PACKAGE_NAME} --legacy-copy    Compatibility alias for setup
  npx ${PACKAGE_NAME} --remove         Compatibility alias for uninstall
  npx ${PACKAGE_NAME} --crew-install   Show packaged Crew agent info
  npx ${PACKAGE_NAME} --crew-uninstall Remove legacy Crew agent copies
  npx ${PACKAGE_NAME} --help           Show this help

After setup:
  pi
  /team doctor
  /team web`);
}

function compareVersions(actual, required) {
	const a = String(actual).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	const b = String(required).replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const left = a[index] ?? 0;
		const right = b[index] ?? 0;
		if (left > right) return 1;
		if (left < right) return -1;
	}
	return 0;
}

function commandExists(commandPath) {
	if (!commandPath) return false;
	if (commandPath.includes(path.sep)) {
		try {
			fs.accessSync(commandPath, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}
	const pathEnv = process.env.PATH || "";
	const extensions = process.platform === "win32"
		? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
		: [""];
	return pathEnv.split(path.delimiter).some((dir) => {
		if (!dir) return false;
		return extensions.some((ext) => {
			try {
				fs.accessSync(path.join(dir, `${commandPath}${ext}`), fs.constants.X_OK);
				return true;
			} catch {
				return false;
			}
		});
	});
}

function hasNativePackageInstall() {
	if (fs.existsSync(NATIVE_PACKAGE_DIR)) return true;
	try {
		const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
		const packages = Array.isArray(settings.packages) ? settings.packages : [];
		return packages.some((item) => item === `npm:${PACKAGE_NAME}` || item === `github:CHANTILLY2023/${PACKAGE_NAME}`);
	} catch {
		return false;
	}
}

function printGuidance() {
	console.log(`${PACKAGE_NAME} v${VERSION}

Quick start:

  npx ${PACKAGE_NAME} setup
  pi
  /team doctor
  /team web

Check your machine without installing:

  npx ${PACKAGE_NAME} doctor

PI's native package flow can be used instead when supported:

  pi install npm:${PACKAGE_NAME}

This helper never scans or prints account secrets. It only copies this package
when you explicitly run \`setup\` or \`--legacy-copy\`.`);
}

function printDoctor() {
	const minNode = String(pkg.engines?.node ?? ">=22.19.0").replace(/^[^\d]*/, "") || "22.19.0";
	const nodeOk = compareVersions(process.version, minNode) >= 0;
	const extensionInstalled = fs.existsSync(EXTENSION_DIR);
	const nativeInstalled = hasNativePackageInstall();

	console.log(`${PACKAGE_NAME} doctor

Package: ${PACKAGE_NAME} v${VERSION}
Node:    ${process.version} ${nodeOk ? "ok" : `needs >=${minNode}`}
Source:  ${PACKAGE_DIR}
PI dir:  ${AGENT_DIR}

Install:
  local extension copy: ${extensionInstalled ? "installed" : "not installed"} (${EXTENSION_DIR})
  native PI package:    ${nativeInstalled ? "configured" : "not configured"}

Commands:`);

	for (const connector of CONNECTORS) {
		const exists = commandExists(connector.command);
		console.log(`  ${exists ? "✓" : "✗"} ${connector.id.padEnd(12)} ${connector.label} (${connector.command})`);
	}

	console.log(`
No model requests were sent. Connector authentication and remote model access
are verified later by /team doctor probe commands inside PI.

Next:
  ${extensionInstalled || nativeInstalled ? "pi" : `npx ${PACKAGE_NAME} setup`}
  /team doctor
  /team web`);
}

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

function shouldSkipCopyEntry(name) {
	return SKIP.has(name) || name.startsWith(".env") || name.endsWith(".tgz");
}

function copyDir(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (shouldSkipCopyEntry(entry.name)) continue;
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) copyDir(srcPath, destPath);
		else fs.copyFileSync(srcPath, destPath);
	}
}

function installRuntimeDependencies() {
	const npmCommand = process.env.PI_TEAM_ROOM_NPM_COMMAND
		|| (process.platform === "win32" ? "npm.cmd" : "npm");
	const npmArgs = ["install", "--omit=dev", "--ignore-scripts"];
	console.log(`Installing runtime dependencies in ${EXTENSION_DIR}`);
	console.log(`  ${path.basename(npmCommand)} ${npmArgs.join(" ")}`);
	const result = spawnSync(npmCommand, npmArgs, {
		cwd: EXTENSION_DIR,
		env: process.env,
		stdio: "inherit",
		timeout: 120_000,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`Runtime dependency install failed with exit code ${result.status ?? "unknown"}`);
	}
}

function installLocalCopy() {
	if (path.resolve(PACKAGE_DIR) === path.resolve(EXTENSION_DIR)) {
		console.log(`Already installed at ${EXTENSION_DIR} (v${VERSION})`);
		return;
	}

	if (hasNativePackageInstall() && !isForce) {
		console.log(`${PACKAGE_NAME} is already configured through PI's native package flow.

Run PI directly:

  pi
  /team web

If you intentionally want to replace it with a local checkout copy, rerun with
--force. Loading both native and local copies may register duplicate commands.`);
		process.exit(1);
	}

	const isUpdate = fs.existsSync(EXTENSION_DIR);
	const backupDir = isUpdate
		? `${EXTENSION_DIR}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`
		: "";

	if (isUpdate && fs.existsSync(path.join(EXTENSION_DIR, ".git")) && !isForce) {
		console.log(`Existing install looks like a git checkout:

  ${EXTENSION_DIR}

Rerun with --force to move it aside and install this package copy.`);
		process.exit(1);
	}

	fs.mkdirSync(path.dirname(EXTENSION_DIR), { recursive: true });

	try {
		if (isUpdate) fs.renameSync(EXTENSION_DIR, backupDir);
		copyDir(PACKAGE_DIR, EXTENSION_DIR);
		installRuntimeDependencies();
	} catch (error) {
		fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
		if (isUpdate && fs.existsSync(backupDir)) fs.renameSync(backupDir, EXTENSION_DIR);
		throw error;
	}

	const action = isUpdate ? "Updated" : "Installed";
	console.log(`${action} ${PACKAGE_NAME} v${VERSION} -> ${EXTENSION_DIR}${backupDir ? `\nBackup:     ${backupDir}` : ""}

Start:
  pi
  /team doctor
  /team web

Data note: project Team history lives under each project's .pi/messenger/ and
is not removed by installing or uninstalling this extension.`);
}

if (isHelp) {
	printHelp();
	process.exit(0);
}

if (isDoctor) {
	printDoctor();
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
		console.log(`Removed ${PACKAGE_NAME} local extension copy from ${EXTENSION_DIR}`);
	} else {
		console.log(`${PACKAGE_NAME} local extension copy is not installed`);
	}
	console.log("Project Team history under .pi/messenger/ was not touched.");
	process.exit(0);
}

if (!isSetup) {
	printGuidance();
	process.exit(0);
}

if (isLegacyCopy) {
	console.log("--legacy-copy is kept as a compatibility alias. Prefer: npx pi-team-room setup\n");
}

installLocalCopy();
