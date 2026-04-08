#!/usr/bin/env node
import fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h") || args.length === 0) {
		printUsage();
		return;
	}

	const dryRun = args.includes("--dry-run");
	const rawName = args.find((arg) => !arg.startsWith("-"));
	if (!rawName) throw new Error("Missing extension name");

	const slug = toSlug(rawName);
	if (!slug) throw new Error("Extension name must contain letters or numbers");

	const extensionDir = resolve(ROOT, "extensions", slug);
	const shimDir = resolve(ROOT, ".pi", "extensions", slug);
	const packageName = `@pi-extension/extension-${slug}`;

	const files = [
		{
			path: resolve(extensionDir, "package.json"),
			content: JSON.stringify({
				name: packageName,
				private: true,
				version: "0.1.0",
				type: "module",
			}, null, 2) + "\n",
		},
		{
			path: resolve(extensionDir, "README.md"),
			content: `# ${slug}\n\nPi extension package for ${slug}.\n\n## Development\n\nCanonical source lives here:\n\n- \`extensions/${slug}\`\n\nOptional local Pi auto-discovery shim (ignored by git):\n\n- \`.pi/extensions/${slug}\`\n`,
		},
		{
			path: resolve(extensionDir, "src", "index.ts"),
			content: `import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";\n\nexport default function (pi: ExtensionAPI) {\n\tpi.registerCommand("${slug}-hello", {\n\t\tdescription: "Example command for ${slug}",\n\t\thandler: async (_args, ctx) => {\n\t\t\tctx.ui.notify("${slug} extension is loaded", "info");\n\t\t},\n\t});\n}\n`,
		},
		{
			path: resolve(shimDir, "package.json"),
			content: JSON.stringify({
				name: slug,
				private: true,
				version: "0.1.0",
				type: "module",
				pi: { extensions: ["./index.ts"] },
			}, null, 2) + "\n",
		},
		{
			path: resolve(shimDir, "index.ts"),
			content: `export { default } from "../../../extensions/${slug}/src/index.ts";\n`,
		},
		{
			path: resolve(shimDir, "README.md"),
			content: `# local Pi shim\n\nThis folder exists only so Pi can auto-discover the extension during local development.\n\nIt is local-only and should stay gitignored.\n\nCanonical source:\n- \`extensions/${slug}\`\n`,
		},
	];

	for (const file of files) {
		if (existsSync(file.path)) {
			throw new Error(`Refusing to overwrite existing file: ${file.path}`);
		}
	}

	if (dryRun) {
		console.log(JSON.stringify({ ok: true, dryRun: true, slug, files: files.map((file) => file.path.replace(`${ROOT}/`, "")) }, null, 2));
		return;
	}

	for (const file of files) {
		await fsp.mkdir(dirname(file.path), { recursive: true });
		await fsp.writeFile(file.path, file.content);
	}

	console.log(JSON.stringify({ ok: true, slug, extensionDir: relative(extensionDir), shimDir: relative(shimDir) }, null, 2));
}

function toSlug(value) {
	return String(value)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function relative(path) {
	return path.replace(`${ROOT}/`, "");
}

function printUsage() {
	console.log(`Usage:\n  npm run extension:new -- <name> [--dry-run]\n\nExamples:\n  npm run extension:new -- jira-helper\n  npm run extension:new -- design-review --dry-run`);
}

main().catch((error) => {
	console.error(`new-extension error: ${error.message}`);
	process.exit(1);
});
