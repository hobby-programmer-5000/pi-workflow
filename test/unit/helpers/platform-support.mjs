// Test-harness helpers for platform differences. POSIX callers get exactly
// the behaviour the tests had before; native Windows gets an equivalent
// fixture or an explicit, stated skip.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const isWin32 = process.platform === "win32";

let symlinkProbe;
/**
 * Whether this process may create symlinks. Always true on POSIX; on Windows
 * it needs Developer Mode or the SeCreateSymbolicLink privilege.
 */
export function canCreateSymlinks() {
	if (!isWin32) return true;
	if (symlinkProbe !== undefined) return symlinkProbe;
	const dir = mkdtempSync(join(tmpdir(), "piwf-symlink-probe-"));
	try {
		writeFileSync(join(dir, "target"), "");
		symlinkSync(join(dir, "target"), join(dir, "alias"), "file");
		symlinkProbe = true;
	} catch {
		symlinkProbe = false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	return symlinkProbe;
}

export const SYMLINK_SKIP_REASON =
	"win32 cannot create symlinks without Developer Mode or SeCreateSymbolicLink";

/** `test()` option that skips a file-symlink test where symlinks are unavailable. */
export const needsSymlinks = () =>
	canCreateSymlinks() ? {} : { skip: SYMLINK_SKIP_REASON };

/**
 * A local file as an ESM specifier (`import()`, `--import`). Windows absolute
 * paths are not valid specifiers there, so use a file:// URL; POSIX keeps the
 * plain path the tests always passed.
 */
export const esmSpecifier = (path) =>
	isWin32 ? pathToFileURL(path).href : path;

let npmCli;
/**
 * `[command, args]` that runs npm. Windows installs npm as a .cmd shim, which
 * spawn/execFile cannot start without a shell (ENOENT), so run its JS entry
 * with the current Node there. POSIX keeps the plain `npm` command.
 */
export function npmInvocation(args) {
	if (!isWin32) return ["npm", args];
	return [process.execPath, [npmCliPath(), ...args]];
}

/** Windows: the npm-cli.js that the npm.cmd shim runs. */
export function npmCliPath() {
	npmCli ??= [
		process.env.npm_execpath,
		join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
	].find((candidate) => candidate && /npm-cli\.js$/u.test(candidate) && existsSync(candidate));
	if (npmCli === undefined) throw new Error("npm-cli.js not found next to node.exe");
	return npmCli;
}

/**
 * Windows 10+ ships bsdtar as System32\tar.exe. Git's GNU tar, often first on
 * PATH, reads `C:\...` archive paths as remote `host:path` specs. POSIX keeps
 * `tar` from PATH.
 */
export function tarCommand() {
	if (!isWin32) return "tar";
	const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
	return existsSync(systemTar) ? systemTar : "tar";
}

let gitBash;
/**
 * The bash to run POSIX shell snippets with. POSIX keeps `bash` from PATH.
 * On Windows, `bash` on PATH is often the WSL launcher (System32\bash.exe),
 * which runs in another OS; use Git for Windows' bash instead, found from
 * `git --exec-path`. Returns undefined when Git Bash is not installed.
 */
export function bashCommand() {
	if (!isWin32) return "bash";
	if (gitBash !== undefined) return gitBash || undefined;
	gitBash = "";
	try {
		const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
		// <git>/mingw64/libexec/git-core -> <git>/usr/bin/bash.exe. Not the
		// <git>/bin/bash.exe wrapper: it puts /mingw64/bin first on PATH, which
		// would shadow fake commands a test places on PATH.
		const candidate = join(execPath, "..", "..", "..", "usr", "bin", "bash.exe");
		if (existsSync(candidate)) gitBash = candidate;
	} catch {
		// No git on PATH.
	}
	return gitBash || undefined;
}

/**
 * PATH for bashCommand() with `dir` first. POSIX keeps `${dir}:${PATH}`. On
 * Windows the list uses `;` (Git Bash converts it at startup) and includes
 * Git's usr/bin so coreutils such as `cat` resolve.
 */
export function bashPath(dir, path = process.env.PATH) {
	if (!isWin32) return `${dir}:${path}`;
	return [dir, dirname(bashCommand() ?? dir), path].join(delimiter);
}

/** A path with `/` separators, for suffix checks; unchanged on POSIX. */
export const toPosixPath = (path) =>
	isWin32 ? String(path).replaceAll("\\", "/") : path;

/** `test()` option for tests that need a FIFO (mkfifo); Windows has none. */
export const needsFifo = () =>
	isWin32 ? { skip: "win32 has no FIFOs (mkfifo)" } : {};

/**
 * `test()` option for tests that rename a directory while a handle inside it
 * is open; Windows refuses that rename (EBUSY), so the race cannot be staged.
 */
export const needsOpenDirectoryRename = () =>
	isWin32
		? { skip: "win32 cannot rename a directory that has open handles (EBUSY)" }
		: {};

/**
 * Rename a fixture directory. Windows refuses the rename (EPERM/EBUSY) while
 * async work that just settled is still closing a handle inside it, so retry
 * there for up to ~2 s, like rmSync's maxRetries. POSIX renames exactly once.
 */
export async function renameDirectory(from, to) {
	for (let attempt = 0; ; attempt += 1) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			if (!isWin32 || attempt >= 20 || !["EPERM", "EBUSY"].includes(error?.code)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
}

/**
 * Link a directory. POSIX and privileged Windows get exactly the symlink the
 * test asked for; Windows without symlink rights gets a junction, which
 * Node's lstat also reports as a symbolic link (a reparse point), so
 * link-refusal checks keep their meaning.
 */
export function linkDirectory(target, path, type) {
	return canCreateSymlinks()
		? symlink(target, path, type)
		: symlink(target, path, "junction");
}

export function linkDirectorySync(target, path, type) {
	return canCreateSymlinks()
		? symlinkSync(target, path, type)
		: symlinkSync(target, path, "junction");
}
