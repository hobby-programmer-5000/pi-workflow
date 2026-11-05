import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const PI_PACKAGE_ROOT_ENV = "PI_SUBAGENT_PI_PACKAGE_ROOT";
const PI_SEGMENTS = PI_PACKAGE.split("/");

function readManifest(path) {
	try {
		return JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
}

function isPiPackageRoot(path) {
	return readManifest(path)?.name === PI_PACKAGE;
}

function piRootAbove(path) {
	let current = path;
	while (current !== dirname(current)) {
		if (isPiPackageRoot(current)) return current;
		current = dirname(current);
	}
	return undefined;
}

/**
 * Find the Pi installation for a process that runs outside Pi. The parent Pi
 * passes its own root when it spawns a supervisor. Otherwise look for the `pi`
 * launcher on PATH: an npm global install on Windows keeps node_modules beside
 * `pi.cmd`, and elsewhere `pi` is a symlink into the package.
 */
export function findHostPiPackageRoot(env = process.env) {
	const inherited = env[PI_PACKAGE_ROOT_ENV];
	if (inherited && isPiPackageRoot(inherited)) return realpathSync(inherited);
	for (const entry of (env.PATH ?? env.Path ?? "").split(delimiter)) {
		if (!entry) continue;
		const beside = join(entry, "node_modules", ...PI_SEGMENTS);
		if ((existsSync(join(entry, "pi.cmd")) || existsSync(join(entry, "pi"))) && isPiPackageRoot(beside))
			return realpathSync(beside);
		try {
			const found = piRootAbove(dirname(realpathSync(join(entry, "pi"))));
			if (found) return found;
		} catch {
			// No `pi` in this directory.
		}
	}
	return undefined;
}

/** The file an `exports` entry selects for ESM consumers, if any. */
function exportTarget(entry) {
	if (typeof entry === "string") return entry;
	if (entry === null || typeof entry !== "object") return undefined;
	for (const condition of ["import", "node", "default"]) {
		const target = exportTarget(entry[condition]);
		if (target !== undefined) return target;
	}
	return undefined;
}

function addPackageAliases(aliases, name, directory) {
	const manifest = readManifest(directory);
	if (manifest === undefined) return;
	const exportsField = manifest.exports;
	const entries =
		typeof exportsField === "object" && exportsField !== null && Object.keys(exportsField).some((key) => key.startsWith("."))
			? Object.entries(exportsField)
			: [[".", exportsField ?? manifest.module ?? manifest.main ?? "index.js"]];
	for (const [subpath, entry] of entries) {
		if (subpath.includes("*")) continue;
		const target = exportTarget(entry);
		if (target === undefined || target.includes("*")) continue;
		const file = join(directory, target);
		if (existsSync(file)) aliases[subpath === "." ? name : `${name}/${subpath.slice(2)}`] = file;
	}
}

/**
 * Pi does not install the packages it provides (pi-ai, pi-tui, typebox, ...)
 * next to a Pi package, and maps them only for code it loads itself. They are
 * ESM-only, so CommonJS search paths cannot reach them either. Build the same
 * mapping for the source loader: every export of the Pi installation's
 * `@earendil-works/*` packages and typebox, resolved to its file.
 */
export function hostPiPackageAliases(piRoot) {
	const aliases = {};
	addPackageAliases(aliases, PI_PACKAGE, piRoot);
	let current = piRoot;
	while (current !== dirname(current)) {
		const modules = join(current, "node_modules");
		const scope = join(modules, "@earendil-works");
		const names = existsSync(scope) ? readdirSync(scope).map((name) => `@earendil-works/${name}`) : [];
		for (const name of [...names, "typebox"]) {
			const directory = join(modules, ...name.split("/"));
			if (name === PI_PACKAGE || !existsSync(directory)) continue;
			// The copy nearest to Pi wins, as it would for Pi itself.
			if (!Object.hasOwn(aliases, name)) addPackageAliases(aliases, name, directory);
		}
		current = dirname(current);
	}
	return aliases;
}
