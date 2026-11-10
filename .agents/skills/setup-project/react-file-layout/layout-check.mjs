// Stop hook: flags files that break the layout rules in docs/agents/file-layout.md.
// File rules compare the working tree with the branch base so committed and
// uncommitted changes are both seen; import and barrel rules read the whole
// tree. Prints a block decision when there are findings. A long file that grew
// only gets a warning shown to the user, because length alone is no reason to split.
// Paths come from layout-check.config.json beside this file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const configPath = fileURLToPath(new URL("./layout-check.config.json", import.meta.url));
let config;
try {
	config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
	process.stderr.write(`layout-check: cannot read ${configPath}: ${error.message}\n`);
	process.exit(1);
}

const asFolder = (path) => (path.endsWith("/") ? path : `${path}/`);
const SOURCE = asFolder(config.sourceRoot ?? "src");
const FEATURES = asFolder(config.features ?? `${SOURCE}features`);
const CHROME = asFolder(config.sharedChrome ?? `${SOURCE}components`);
// An entry ending in "/" is a folder; any other entry is one module, named without its extension.
const APP = config.app ?? [`${SOURCE}main`, `${SOURCE}App`];
const EXEMPT = (config.exempt ?? []).map(asFolder);
const GENERATED = (config.generated ?? []).map(asFolder);
// Longest prefix first, so "@/components/" wins over "@/" when both are set.
const ALIASES = Object.entries(config.aliases ?? { "@/": SOURCE }).sort(
	([a], [b]) => b.length - a.length,
);
const BASE_BRANCH = config.baseBranch ?? "main";
const LONG_FILE = config.longFile ?? 400;

// Shared code is sorted by concept, so these names say nothing there.
const KIND_FOLDERS = new Set(["components", "hooks", "utils", "helpers", "types"]);
// Inside a feature the first folder says what kind of code a file holds.
const FEATURE_KINDS = {
	components: { test: (name) => name.endsWith(".tsx"), shape: "<name>.tsx" },
	hooks: { test: (name) => name.startsWith("use-"), shape: "use-<name>" },
	stores: { test: (name) => /-store\.tsx?$/.test(name), shape: "<name>-store" },
	actions: { test: () => true },
	api: { test: (name) => /-api\.tsx?$/.test(name), shape: "<name>-api" },
	lib: { test: () => true },
	types: { test: () => true },
};
const LAYERS = ["shared code", "a feature", "the app"];

const IMPORT_FROM =
	/^[ \t]*(?:import|export)\s+(type\s+)?((?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)|[\w$]+)\s+from\s+["']([^"']+)["']/gm;
const IMPORT_BARE = /^[ \t]*import\s+["']([^"']+)["']/gm;
// `typeof import("…")` names a type and loads nothing.
const IMPORT_CALL = /(?<!typeof\s+)\bimport\(\s*["']([^"']+)["']\s*\)/g;

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

function gitOrNull(...args) {
	try {
		return git(...args).trim();
	} catch {
		return null;
	}
}

function readStdinJson() {
	if (process.stdin.isTTY) return {};
	try {
		const raw = readFileSync(0, "utf8").trim();
		return raw ? JSON.parse(raw) : {};
	} catch {
		return {};
	}
}

function lineCount(text) {
	if (text.length === 0) return 0;
	const lines = text.split("\n");
	return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

function headLineCount(base, path) {
	const text = gitOrNull("show", `${base}:${path}`);
	return text === null ? null : lineCount(text);
}

const under = (path, folders) => folders.some((folder) => path.startsWith(folder));

function isApp(path) {
	const bare = path.replace(/\.(ts|tsx)$/, "");
	return APP.some((entry) => (entry.endsWith("/") ? bare.startsWith(entry) : bare === entry));
}

function isChecked(path) {
	if (!path.startsWith(SOURCE)) return false;
	if (!/\.(ts|tsx)$/.test(path)) return false;
	if (/\.(test|gen)\./.test(path)) return false;
	return !under(path, EXEMPT) && !under(path, GENERATED) && !isApp(path);
}

function kindFolder(path) {
	// The shared chrome folder is named components on purpose.
	if (path.startsWith(CHROME) || path.startsWith(FEATURES)) return null;
	const folders = path.split("/").slice(0, -1);
	return folders.find((folder) => KIND_FOLDERS.has(folder)) ?? null;
}

function featureKindProblem(path) {
	if (!path.startsWith(FEATURES)) return null;
	const parts = path.slice(FEATURES.length).split("/");
	const feature = `${FEATURES}${parts[0]}`;
	const kinds = Object.keys(FEATURE_KINDS).join(", ");
	if (parts.length === 2) {
		return `${path} sits at the top of ${feature}. Put it in a kind folder: ${kinds}.`;
	}
	const kind = FEATURE_KINDS[parts[1]];
	if (kind === undefined) {
		return `${path} is under ${feature}/${parts[1]}, which is not a kind folder (${kinds}).`;
	}
	const name = parts.at(-1);
	if (!kind.test(name)) return `${path} is in ${parts[1]}/, where a file is named ${kind.shape}.`;
	return null;
}

// Before the first commit every file is new, so the base is the empty tree.
function branchBase() {
	const head = gitOrNull("rev-parse", "--verify", "--quiet", "HEAD");
	if (head === null) {
		return execFileSync("git", ["hash-object", "-t", "tree", "--stdin"], {
			encoding: "utf8",
			input: "",
		}).trim();
	}
	return gitOrNull("merge-base", "HEAD", BASE_BRANCH) ?? head;
}

// Returns { path, basePath } for every changed file; basePath is null for new files.
function changedFiles(base) {
	const changes = new Map();
	for (const line of git("diff", "--name-status", "-M", base).split("\n")) {
		if (!line) continue;
		const [status, a, b] = line.split("\t");
		if (status.startsWith("D")) continue;
		if (status.startsWith("R")) changes.set(b, a);
		else changes.set(a, status === "A" ? null : a);
	}
	for (const path of git("ls-files", "--others", "--exclude-standard").split("\n")) {
		if (path) changes.set(path, null);
	}
	return [...changes].map(([path, basePath]) => ({ path, basePath }));
}

// Returns { found, long }: layout findings, and the files over LONG_FILE that grew.
function findings(base) {
	const found = [];
	const long = [];
	for (const { path, basePath } of changedFiles(base)) {
		if (!isChecked(path) || !existsSync(path)) continue;
		const lines = lineCount(readFileSync(path, "utf8"));
		const before = basePath === null ? null : headLineCount(base, basePath);
		if (lines > LONG_FILE && (before === null || lines > before)) {
			long.push({ path, lines, before });
		}
		// Files that stay put keep their place until their feature moves.
		if (basePath === path) continue;
		const folder = kindFolder(path);
		if (folder !== null) {
			found.push(
				`${path} is a new file under a folder named "${folder}". Put it in the folder of the concept it serves.`,
			);
		}
		const problem = featureKindProblem(path);
		if (problem !== null) found.push(problem);
	}
	return { found, long };
}

// Every stop on a branch sees the same long files, so each one is reported
// only when it is longer than at the last stop.
function longFileWarnings(long) {
	const statePath = gitOrNull("rev-parse", "--git-path", "layout-check-long-files.json");
	if (statePath === null) return [];
	let lastSeen = {};
	try {
		lastSeen = JSON.parse(readFileSync(statePath, "utf8"));
	} catch {}
	try {
		writeFileSync(
			statePath,
			JSON.stringify(Object.fromEntries(long.map(({ path, lines }) => [path, lines]))),
		);
	} catch {}
	return long
		.filter(({ path, lines }) => lines > (lastSeen[path] ?? 0))
		.map(({ path, lines, before }) => {
			const change = before === null ? "new file" : `${before} at the branch base`;
			return `${path} grew to ${lines} lines (${change}). Split it if it holds a second concept.`;
		});
}

function sourceFiles() {
	return git("ls-files", "--cached", "--others", "--exclude-standard", "--", SOURCE)
		.split("\n")
		.filter(
			(path) =>
				/\.(ts|tsx)$/.test(path) &&
				!/\.(gen|d)\.ts$/.test(path) &&
				!under(path, GENERATED) &&
				existsSync(path),
		);
}

// An import whose names are all types is erased from the build, so it loads nothing.
function isTypeOnly(typeKeyword, clause) {
	if (typeKeyword) return true;
	const braces = clause.match(/^\{([^}]*)\}$/);
	if (braces === null) return false;
	const names = braces[1]
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	return names.length > 0 && names.every((name) => name.startsWith("type "));
}

function importsOf(text) {
	const found = [];
	for (const m of text.matchAll(IMPORT_FROM)) {
		found.push({ spec: m[3], runtime: !isTypeOnly(m[1], m[2]) });
	}
	for (const m of text.matchAll(IMPORT_BARE)) found.push({ spec: m[1], runtime: true });
	for (const m of text.matchAll(IMPORT_CALL)) found.push({ spec: m[1], runtime: true });
	return found;
}

// The source path an import points at, without extension; null for packages.
function resolveImport(file, spec) {
	let path = null;
	for (const [prefix, target] of ALIASES) {
		if (spec.startsWith(prefix)) {
			path = posix.normalize(asFolder(target) + spec.slice(prefix.length));
			break;
		}
	}
	if (path === null && spec.startsWith(".")) {
		path = posix.normalize(posix.join(posix.dirname(file), spec));
	}
	return path === null ? null : path.replace(/\.(ts|tsx|js|jsx)$/, "");
}

function featureOf(path) {
	if (!path.startsWith(FEATURES)) return null;
	return path.slice(FEATURES.length).split("/")[0] || null;
}

function layerOf(path) {
	if (isApp(path)) return 2;
	return path.startsWith(FEATURES) ? 1 : 0;
}

// Tarjan's strongly connected components; returns the groups of two or more.
function loops(edges) {
	let next = 0;
	const index = new Map();
	const low = new Map();
	const stack = [];
	const onStack = new Set();
	const groups = [];
	const visit = (node) => {
		index.set(node, next);
		low.set(node, next);
		next++;
		stack.push(node);
		onStack.add(node);
		for (const target of edges.get(node)?.keys() ?? []) {
			if (!index.has(target)) {
				visit(target);
				low.set(node, Math.min(low.get(node), low.get(target)));
			} else if (onStack.has(target)) {
				low.set(node, Math.min(low.get(node), index.get(target)));
			}
		}
		if (low.get(node) !== index.get(node)) return;
		const group = [];
		let member;
		do {
			member = stack.pop();
			onStack.delete(member);
			group.push(member);
		} while (member !== node);
		if (group.length > 1) groups.push(group.sort());
	};
	for (const node of edges.keys()) if (!index.has(node)) visit(node);
	return groups;
}

function treeFindings() {
	const found = [];
	// feature -> imported feature -> first file that imports it
	const edges = new Map();
	for (const file of sourceFiles()) {
		// File routers use index files as routes, so the app layer may keep them.
		if (/(^|\/)index\.tsx?$/.test(file) && !isApp(file)) {
			found.push(
				`${file} is a barrel. Import each name from the file that defines it, and delete the barrel.`,
			);
		}
		const own = featureOf(file);
		const isTest = /\.test\./.test(file);
		for (const { spec, runtime } of importsOf(readFileSync(file, "utf8"))) {
			const target = resolveImport(file, spec);
			if (target === null) continue;
			const feature = featureOf(target);
			if (feature !== null && feature === own && !spec.startsWith(".")) {
				found.push(
					`${file} imports its own feature through "${spec}". Import siblings by relative path.`,
				);
			}
			if (isTest || !runtime) continue;
			if (layerOf(target) > layerOf(file)) {
				found.push(
					`${file} is ${LAYERS[layerOf(file)]} and imports "${spec}", ${LAYERS[layerOf(target)]}. Imports flow from shared code to features to the app: move the shared part down, or pass it in from above.`,
				);
			}
			if (feature !== null && own !== null && feature !== own) {
				if (!edges.has(own)) edges.set(own, new Map());
				const targets = edges.get(own);
				if (!targets.has(feature)) targets.set(feature, file);
			}
		}
	}
	for (const group of loops(edges)) {
		const links = [];
		for (const from of group) {
			for (const [to, file] of edges.get(from) ?? []) {
				if (group.includes(to)) links.push(`${file} -> ${to}`);
			}
		}
		found.push(
			`The features ${group.join(", ")} import each other in a loop (${links.join("; ")}). Move the part they share into its own concept, or pass it in from the app.`,
		);
	}
	return found;
}

const input = readStdinJson();
if (input.stop_hook_active === true) process.exit(0);

const root = gitOrNull("rev-parse", "--show-toplevel");
if (root === null) process.exit(0);
process.chdir(root);

let found;
let warnings;
try {
	const base = branchBase();
	const changed = findings(base);
	found = [...changed.found, ...treeFindings()];
	warnings = longFileWarnings(changed.long);
} catch {
	process.exit(0);
}

const output = {};
if (found.length > 0) {
	output.decision = "block";
	output.reason = [
		"Layout check (docs/agents/file-layout.md):",
		...found.map((line) => `- ${line}`),
		"Fix these or explain them to the user before stopping.",
	].join("\n");
}
if (warnings.length > 0) {
	output.systemMessage = ["Long files:", ...warnings.map((line) => `- ${line}`)].join("\n");
}
if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
