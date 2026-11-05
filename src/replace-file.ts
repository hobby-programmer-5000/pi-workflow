import { rename } from "node:fs/promises";

const WIN32_REPLACE_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const WIN32_REPLACE_RETRY_LIMIT = 40;

/**
 * Replace `to` with `from` by rename. Windows refuses to rename over a file
 * that another process has open without delete sharing (EPERM/EACCES/EBUSY),
 * and workflow state is read by the host, the supervisor and workers at the
 * same time, besides antivirus and indexers. Those readers hold the file only
 * briefly, so on win32 the replace is retried with a short backoff (about 8 s
 * in total, like graceful-fs); other errors are rethrown at once.
 *
 * `beforeRetry` runs before every retry so a caller can repeat its safety
 * checks or honour cancellation: the wait is long enough for conditions
 * checked before the first attempt to change. If it throws, the replace is
 * abandoned with that error. POSIX renames are a single plain rename.
 */
export async function renameReplacing(
	from: string,
	to: string,
	beforeRetry?: () => void | Promise<void>,
): Promise<void> {
	if (process.platform !== "win32") {
		await rename(from, to);
		return;
	}
	for (let attempt = 0; ; attempt += 1) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (!WIN32_REPLACE_RETRY_CODES.has(code ?? "") || attempt >= WIN32_REPLACE_RETRY_LIMIT)
				throw error;
		}
		await new Promise((resolveSleep) => setTimeout(resolveSleep, Math.min(25 * (attempt + 1), 250)));
		await beforeRetry?.();
	}
}
