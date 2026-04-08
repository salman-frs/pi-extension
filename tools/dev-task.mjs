#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TASK_DIR = resolve(ROOT, ".local/dev-tasks");

async function main() {
	await fsp.mkdir(TASK_DIR, { recursive: true });
	const [command, ...rest] = process.argv.slice(2);
	switch (command) {
		case "start":
			return startTask(rest);
		case "stop":
			return stopTask(rest[0]);
		case "status":
		case "list":
			return printStatus(rest[0]);
		case "logs":
			return printLogs(rest);
		default:
			printUsage();
			process.exit(command ? 1 : 0);
	}
}

function printUsage() {
	console.log(`Usage:
  node tools/dev-task.mjs start <name> [--cwd <path>] -- <command>
  node tools/dev-task.mjs stop <name>
  node tools/dev-task.mjs status [name]
  node tools/dev-task.mjs logs <name> [--lines <n>]`);
}

function taskFile(name) {
	return join(TASK_DIR, `${name}.json`);
}

function taskLog(name) {
	return join(TASK_DIR, `${name}.log`);
}

function validateName(name) {
	if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
		throw new Error("Task name must match [a-zA-Z0-9._-]+");
	}
}

async function readTask(name) {
	try {
		return JSON.parse(await fsp.readFile(taskFile(name), "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function startTask(args) {
	const name = args[0];
	validateName(name);
	const marker = args.indexOf("--");
	if (marker === -1 || marker === args.length - 1) {
		throw new Error("Missing command after --");
	}
	let cwd = ROOT;
	for (let i = 1; i < marker; i++) {
		if (args[i] === "--cwd") {
			cwd = resolve(ROOT, args[i + 1]);
			i += 1;
		}
	}
	const command = args.slice(marker + 1).join(" ");
	const existing = await readTask(name);
	if (existing?.pid && isAlive(existing.pid)) {
		throw new Error(`Task ${name} is already running with pid ${existing.pid}`);
	}
	const logPath = taskLog(name);
	const out = fs.openSync(logPath, "a");
	const child = spawn(command, {
		cwd,
		env: process.env,
		shell: true,
		detached: true,
		stdio: ["ignore", out, out],
	});
	child.unref();
	fs.closeSync(out);
	const task = {
		name,
		pid: child.pid,
		cwd,
		command,
		logPath,
		startedAt: new Date().toISOString(),
	};
	await fsp.writeFile(taskFile(name), JSON.stringify(task, null, 2));
	console.log(JSON.stringify({ ok: true, task }, null, 2));
}

async function stopTask(name) {
	validateName(name);
	const task = await readTask(name);
	if (!task) throw new Error(`Task ${name} not found`);
	if (!isAlive(task.pid)) {
		await fsp.unlink(taskFile(name)).catch(() => {});
		console.log(JSON.stringify({ ok: true, stopped: false, reason: "already-exited", task }, null, 2));
		return;
	}
	try {
		process.kill(-task.pid, "SIGTERM");
	} catch {
		process.kill(task.pid, "SIGTERM");
	}
	await new Promise((resolve) => setTimeout(resolve, 500));
	if (isAlive(task.pid)) {
		try {
			process.kill(-task.pid, "SIGKILL");
		} catch {
			process.kill(task.pid, "SIGKILL");
		}
	}
	await fsp.unlink(taskFile(name)).catch(() => {});
	console.log(JSON.stringify({ ok: true, stopped: true, task }, null, 2));
}

async function printStatus(name) {
	if (name) {
		validateName(name);
		const task = await readTask(name);
		if (!task) throw new Error(`Task ${name} not found`);
		console.log(JSON.stringify({ ...task, running: isAlive(task.pid) }, null, 2));
		return;
	}
	const files = (await fsp.readdir(TASK_DIR)).filter((entry) => entry.endsWith(".json"));
	const rows = [];
	for (const file of files) {
		const task = JSON.parse(await fsp.readFile(join(TASK_DIR, file), "utf8"));
		rows.push({ name: task.name, pid: task.pid, running: isAlive(task.pid), startedAt: task.startedAt, cwd: task.cwd });
	}
	console.log(JSON.stringify(rows, null, 2));
}

async function printLogs(args) {
	const name = args[0];
	validateName(name);
	let lines = 80;
	for (let i = 1; i < args.length; i++) {
		if (args[i] === "--lines") {
			lines = Math.max(1, Number(args[i + 1] || 80));
			i += 1;
		}
	}
	const content = await fsp.readFile(taskLog(name), "utf8").catch(() => "");
	const tail = content.split(/\r?\n/).slice(-lines).join("\n");
	console.log(tail);
}

main().catch((error) => {
	console.error(`dev-task error: ${error.message}`);
	process.exit(1);
});
