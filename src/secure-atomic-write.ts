import { renameReplacing } from "./replace-file.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	link,
	lstat,
	mkdir,
	open,
	opendir,
	realpath,
	rm,
	rename,
	stat,
	type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

let tempSuffixForTests: (() => string) | undefined;
let beforeRenameForTests:
	| ((path: string, temporaryPath: string) => void | Promise<void>)
	| undefined;

export function setSecureAtomicTempSuffixForTests(
	factory: (() => string) | undefined,
): void {
	tempSuffixForTests = factory;
}

/** Test-only fault injection immediately before the atomic rename commit. */
export function setSecureAtomicBeforeRenameHookForTests(
	hook:
		| ((path: string, temporaryPath: string) => void | Promise<void>)
		| undefined,
): void {
	beforeRenameForTests = hook;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const READ_DIRECTORY = constants.O_RDONLY | DIRECTORY | NOFOLLOW;
const PRIVATE_FILE =
	constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;

/**
 * Native Windows has no O_NOFOLLOW, and Node's open() follows symlinks and
 * junctions. The win32 branch keeps the same containment goal by refusing a
 * link before each open and then requiring the opened handle's identity to
 * match the lstat identity of the name (a followed link has a different
 * identity). NTFS file IDs can exceed Number.MAX_SAFE_INTEGER, so win32
 * identity checks use bigint stats. POSIX behaviour is unchanged.
 */
const IS_WIN32 = process.platform === "win32";
const IDENTITY_STAT = { bigint: IS_WIN32 } as const;

/**
 * Open every ancestor with O_NOFOLLOW, retain all descriptors during
 * traversal, and retain the destination descriptor during publication. Path
 * operations are paired with descriptor/name identity checks.
 */
export async function ensurePrivateDirectory(path: string): Promise<void> {
	const directory = await openPrivateDirectory(path, true);
	try {
		await assertNamedDirectory(directory);
		await chmodPrivateDirectory(directory.handle);
		await directory.handle.sync().catch(ignoreDirectorySyncError);
	} finally {
		await directory.handle.close().catch(() => undefined);
	}
}

/** Read a bounded private regular file without following path symlinks. */
export async function readPrivateFileText(
	path: string,
	maxBytes = 1_048_576,
): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16_777_216)
		throw new Error("private file size limit is invalid");
	const absolute = resolve(path);
	const parent = await openPrivateDirectory(dirname(absolute), false);
	const target = join(parent.namedPath, basename(absolute));
	let file: FileHandle | undefined;
	try {
		await assertNamedDirectory(parent);
		await assertNotLinkBeforeOpen(target);
		file = await open(
			target,
			constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK,
		);
		await assertSingleRegularFile(file, target);
		const info = await file.stat();
		if (info.size > maxBytes) throw new Error("private file exceeds size limit");
		let content = Buffer.allocUnsafe(
			Math.min(maxBytes + 1, Math.max(4_096, info.size + 1)),
		);
		let bytesRead = 0;
		for (;;) {
			if (bytesRead === content.length) {
				if (content.length === maxBytes + 1) break;
				const grown = Buffer.allocUnsafe(
					Math.min(maxBytes + 1, content.length * 2),
				);
				content.copy(grown);
				content = grown;
			}
			const next = await file.read(
				content,
				bytesRead,
				content.length - bytesRead,
				bytesRead,
			);
			if (next.bytesRead === 0) break;
			bytesRead += next.bytesRead;
		}
		if (bytesRead > maxBytes) throw new Error("private file exceeds size limit");
		await assertSingleRegularFile(file, target);
		await assertNamedDirectory(parent);
		return new TextDecoder("utf-8", { fatal: true }).decode(
			content.subarray(0, bytesRead),
		);
	} finally {
		await file?.close().catch(() => undefined);
		await parent.handle.close().catch(() => undefined);
	}
}

/** List a bounded private directory only while its path identity stays fixed. */
export async function readPrivateDirectoryNames(
	path: string,
	maxEntries = 10_000,
): Promise<string[]> {
	if (
		!Number.isSafeInteger(maxEntries) ||
		maxEntries <= 0 ||
		maxEntries > 100_000
	) {
		throw new Error("private directory entry limit is invalid");
	}
	const directory = await openPrivateDirectory(path, false);
	let opened: Awaited<ReturnType<typeof opendir>> | undefined;
	try {
		await assertNamedDirectory(directory);
		opened = await opendir(directory.namedPath);
		const names: string[] = [];
		for (;;) {
			const entry = await opened.read();
			if (!entry) break;
			names.push(entry.name);
			if (names.length > maxEntries)
				throw new Error("private directory exceeds entry limit");
		}
		await assertNamedDirectory(directory);
		return names;
	} finally {
		await opened?.close().catch(() => undefined);
		await directory.handle.close().catch(() => undefined);
	}
}

export async function appendPrivateFile(
	path: string,
	content: string | Uint8Array,
): Promise<void> {
	const parent = await openPrivateParent(path);
	const target = join(parent.namedPath, basename(resolve(path)));
	let file: FileHandle | undefined;
	try {
		await assertNamedDirectory(parent);
		await assertNotLinkBeforeOpen(target);
		file = await open(target, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | NOFOLLOW, 0o600);
		await assertSingleRegularFile(file, target);
		await file.chmod(0o600);
		await file.writeFile(content);
		await file.sync();
		await assertSingleRegularFile(file, target);
		await assertNamedDirectory(parent);
	} finally {
		await file?.close().catch(() => undefined);
		await parent.handle.close().catch(() => undefined);
	}
}

export async function writePrivateFileAtomic(
	path: string,
	content: string | Uint8Array,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const absolute = resolve(path);
	const parent = await openPrivateParent(absolute);
	const suffix = tempSuffixForTests?.() ?? randomUUID();
	const logicalTmp = `${absolute}.${suffix}.tmp`;
	const tmp = join(parent.namedPath, basename(logicalTmp));
	let file: FileHandle | undefined;
	try {
		await assertNamedDirectory(parent);
		file = await open(tmp, PRIVATE_FILE, 0o600);
		await assertSingleRegularFile(file, tmp);
		await file.writeFile(content);
		await file.sync();
		await assertSingleRegularFile(file, tmp);
		await file.close();
		file = undefined;
		// Cancellation is checked before the commit. Once rename starts, commit
		// wins and the caller must observe its result.
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
		await beforeRenameForTests?.(absolute, logicalTmp);
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
		await assertNamedDirectory(parent);
		// win32: retry while another process briefly holds the target open, and
		// revalidate the parent each time. No O_NOFOLLOW protects this name there.
		if (IS_WIN32)
			await renameReplacing(tmp, join(parent.namedPath, basename(absolute)), async () => {
				await assertNamedDirectory(parent);
				await assertNotLinkBeforeOpen(join(parent.namedPath, basename(absolute)));
			});
		else await rename(tmp, join(parent.namedPath, basename(absolute)));
		const publishedPath = join(parent.namedPath, basename(absolute));
		await assertNotLinkBeforeOpen(publishedPath);
		const published = await open(publishedPath, constants.O_RDONLY | NOFOLLOW);
		try {
			await assertSingleRegularFile(published, publishedPath);
			await published.chmod(0o600);
		} finally {
			await published.close().catch(() => undefined);
		}
		await parent.handle.sync().catch(ignoreDirectorySyncError);
	} finally {
		await file?.close().catch(() => undefined);
		await removeTemporaryPath(parent, tmp, false);
		await parent.handle.close().catch(() => undefined);
	}
}

/** Publish a fully initialized private lock generation without following ancestors. */
export async function publishPrivateGenerationDirectory(
	path: string,
	ownerName: string,
	ownerContent: string | Uint8Array,
): Promise<void> {
	const absolute = resolve(path);
	if (!ownerName || basename(ownerName) !== ownerName || ownerName === "." || ownerName === "..")
		throw new Error("generation owner name must be a single path component");
	const parent = await openPrivateParent(absolute);
	const temporaryPath = `${absolute}.generation-${randomUUID()}`;
	const temporary = join(parent.namedPath, basename(temporaryPath));
	let generation: FileHandle | undefined;
	try {
		await assertNamedDirectory(parent);
		await mkdir(temporary, { mode: 0o700 });
		await assertNotLinkBeforeOpen(temporary);
		generation = await open(temporary, READ_DIRECTORY);
		await assertDirectoryHandleMatchesPath(generation, temporary);
		await chmodPrivateDirectory(generation);
		const owner = await open(join(temporary, ownerName), PRIVATE_FILE, 0o600);
		try {
			await owner.writeFile(ownerContent);
			await owner.sync();
		} finally {
			await owner.close().catch(() => undefined);
		}
		await generation.sync().catch(ignoreDirectorySyncError);
		await assertDestinationAbsent(parent, basename(absolute));
		await beforeRenameForTests?.(absolute, temporaryPath);
		await assertNamedDirectory(parent);
		// Recheck after the hook: generation publication must not replace a
		// destination created while the generation was being prepared.
		await assertDestinationAbsent(parent, basename(absolute));
		await rename(temporary, join(parent.namedPath, basename(absolute)));
		await assertNotLinkBeforeOpen(join(parent.namedPath, basename(absolute)));
		const published = await open(join(parent.namedPath, basename(absolute)), READ_DIRECTORY);
		await published.close().catch(() => undefined);
		await parent.handle.sync().catch(ignoreDirectorySyncError);
	} finally {
		await generation?.close().catch(() => undefined);
		await removeTemporaryPath(parent, temporary, true);
		await parent.handle.close().catch(() => undefined);
	}
}

/** Publish a private file without replacing an existing target. */
export async function writePrivateFileNoReplace(
	path: string,
	content: string | Uint8Array,
	options: { signal?: AbortSignal } = {},
): Promise<void> {
	const absolute = resolve(path);
	const parent = await openPrivateParent(absolute);
	const logicalTmp = `${absolute}.${randomUUID()}.tmp`;
	const tmp = join(parent.namedPath, basename(logicalTmp));
	let file: FileHandle | undefined;
	try {
		await assertNamedDirectory(parent);
		file = await open(tmp, PRIVATE_FILE, 0o600);
		await file.writeFile(content);
		await file.sync();
		await file.close();
		file = undefined;
		if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
		await assertNamedDirectory(parent);
		await link(tmp, join(parent.namedPath, basename(absolute)));
		await assertNamedDirectory(parent);
		await removeTemporaryPath(parent, tmp, false);
		await parent.handle.sync().catch(ignoreDirectorySyncError);
	} finally {
		await file?.close().catch(() => undefined);
		await removeTemporaryPath(parent, tmp, false);
		await parent.handle.close().catch(() => undefined);
	}
}

async function removeTemporaryPath(
	parent: OpenDirectory,
	path: string,
	recursive: boolean,
): Promise<void> {
	try {
		await assertNamedDirectory(parent);
		const info = await lstat(path);
		if (info.isSymbolicLink()) return;
		await rm(path, { force: true, ...(recursive ? { recursive: true } : {}) });
	} catch {
		// Never clean through a path whose ancestor identity changed. The
		// descriptor remains authoritative; an orphaned temp is safer than
		// deleting an attacker-controlled external file.
	}
}

type OpenDirectory = { handle: FileHandle; namedPath: string };

async function openPrivateParent(path: string): Promise<OpenDirectory> {
	const absolute = resolve(path);
	const parent = await openPrivateDirectory(dirname(absolute), true);
	try {
		await assertNamedDirectory(parent);
		if (parent.namedPath !== sep) await chmodPrivateDirectory(parent.handle);
		return parent;
	} catch (error) {
		await parent.handle.close().catch(() => undefined);
		throw error;
	}
}

async function openPrivateDirectory(
	path: string,
	create: boolean,
): Promise<OpenDirectory> {
	const absolute = resolve(path);
	if (!IS_WIN32 && constants.O_NOFOLLOW === undefined) {
		throw new Error("secure filesystem containment is unavailable on this platform");
	}
	const canonical = await canonicalDirectoryPath(absolute);
	const root = filesystemRoot(canonical);
	const opened: Array<{ handle: FileHandle; path: string }> = [
		{ handle: await open(root, READ_DIRECTORY), path: root },
	];
	let currentPath: string = root;
	try {
		for (const component of pathComponentsBelowRoot(canonical, root)) {
			const nextPath = join(currentPath, component);
			if (create) {
				try {
					await mkdir(nextPath, { mode: 0o700 });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}
			}
			await assertNotLinkBeforeOpen(nextPath);
			const next = await open(nextPath, READ_DIRECTORY);
			await assertDirectoryHandleMatchesPath(next, nextPath);
			opened.push({ handle: next, path: nextPath });
			currentPath = nextPath;
		}
		for (const ancestor of opened) {
			await assertDirectoryHandleMatchesPath(ancestor.handle, ancestor.path);
		}
		const destination = opened.at(-1)!;
		for (const ancestor of opened.slice(0, -1)) await ancestor.handle.close();
		return { handle: destination.handle, namedPath: absolute };
	} catch (error) {
		await Promise.all(
			opened.map(({ handle }) => handle.close().catch(() => undefined)),
		);
		throw error;
	}
}

async function canonicalDirectoryPath(path: string): Promise<string> {
	const absolute = resolve(path);
	let existing = absolute;
	const missing: string[] = [];
	for (;;) {
		try {
			const info = await lstat(existing);
			if (!info.isDirectory()) throw new Error("secure directory is not a directory");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(existing);
			if (parent === existing) throw error;
			missing.unshift(basename(existing));
			existing = parent;
		}
	}
	// Do not silently canonicalize an attacker-controlled symlink. macOS
	// exposes /var as a system symlink, so that one stable platform alias is
	// accepted; all application ancestors must be real directories. On win32,
	// junctions report as symbolic links and are refused the same way.
	const root = filesystemRoot(existing);
	let cursor: string = root;
	for (const component of pathComponentsBelowRoot(existing, root)) {
		cursor = join(cursor, component);
		const info = await lstat(cursor);
		if (info.isSymbolicLink() && !isAllowedSystemDirectoryAlias(cursor))
			throw new Error("secure directory ancestor must not be a symlink");
	}
	return join(await realpath(existing), ...missing);
}

function isAllowedSystemDirectoryAlias(path: string): boolean {
	return process.platform === "darwin" && (path === "/var" || path === "/tmp");
}

/** POSIX root is `/`; win32 root is the drive (`C:\`) or UNC share root. */
function filesystemRoot(path: string): string {
	return IS_WIN32 ? parse(path).root : sep;
}

function pathComponentsBelowRoot(path: string, root: string): string[] {
	return path.slice(root.length).split(sep).filter(Boolean);
}

/**
 * win32 stand-in for O_NOFOLLOW: refuse a symlink or junction at the name
 * before opening it. The post-open identity check still catches a link that
 * appears between this lstat and the open. No-op on POSIX, where O_NOFOLLOW
 * already refuses the final component.
 */
async function assertNotLinkBeforeOpen(path: string): Promise<void> {
	if (!IS_WIN32) return;
	try {
		if ((await lstat(path)).isSymbolicLink())
			throw new Error("secure path must not be a symlink or junction");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/**
 * Windows grants access through inherited ACLs, not mode bits, and fchmod on
 * a directory handle fails with EPERM there. Privacy on win32 therefore relies
 * on the ACL inherited from the containing user/project directory.
 */
async function chmodPrivateDirectory(handle: FileHandle): Promise<void> {
	if (IS_WIN32) return;
	await handle.chmod(0o700);
}

async function assertDirectoryHandleMatchesPath(
	directory: FileHandle,
	path: string,
): Promise<void> {
	const opened = await directory.stat(IDENTITY_STAT);
	const named = await lstat(path, IDENTITY_STAT);
	if (!opened.isDirectory() || !sameIdentity(opened, named))
		throw new Error("secure directory changed during write");
}

async function assertNamedDirectory(directory: OpenDirectory): Promise<void> {
	const opened = await directory.handle.stat(IDENTITY_STAT);
	const named = await stat(directory.namedPath, IDENTITY_STAT);
	if (!opened.isDirectory() || !sameIdentity(opened, named)) {
		throw new Error("secure directory changed during write");
	}
}

async function assertDestinationAbsent(
	parent: OpenDirectory,
	name: string,
): Promise<void> {
	try {
		await lstat(join(parent.namedPath, name));
		throw Object.assign(new Error("destination already exists"), { code: "EEXIST" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function assertSingleRegularFile(
	file: FileHandle,
	path: string,
): Promise<void> {
	const opened = await file.stat(IDENTITY_STAT);
	const named = await lstat(path, IDENTITY_STAT);
	if (!opened.isFile() || !sameIdentity(opened, named))
		throw new Error("secure path is not a stable regular file");
	if (Number(opened.nlink) !== 1) throw new Error("private file must not be hard-linked");
}

function sameIdentity(
	left: { dev: number | bigint; ino: number | bigint },
	right: { dev: number | bigint; ino: number | bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function ignoreDirectorySyncError(error: unknown): void {
	const code = (error as NodeJS.ErrnoException).code;
	if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
}
