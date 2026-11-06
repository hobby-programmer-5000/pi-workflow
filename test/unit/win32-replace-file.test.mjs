import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { renameReplacing } from "../../.tmp/unit/replace-file.js";
import { writePrivateFileAtomic } from "../../.tmp/unit/secure-atomic-write.js";

const skip = process.platform !== "win32";

// Open the target with FileShare.Read only (no Delete) for holdMs, as antivirus,
// indexers and PowerShell readers do; a plain rename over it then fails.
function holdOpen(target, holdMs) {
	const script = `$f = [System.IO.File]::Open('${target.replaceAll("'", "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); Start-Sleep -Milliseconds ${holdMs}; $f.Close()`;
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		stdio: ["ignore", "pipe", "inherit"],
		windowsHide: true,
	});
	const held = new Promise((resolveHeld, rejectHeld) => {
		child.stdout.on("data", (chunk) => {
			if (String(chunk).includes("held")) resolveHeld();
		});
		child.once("exit", (code) => rejectHeld(new Error(`holder exited early (${code})`)));
	});
	const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
	return { held, exited };
}

async function tempRoot() {
	return await realpath(await mkdtemp(join(tmpdir(), "piwf-replace-file-")));
}

test("renameReplacing waits for a reader and checks again before every retry", { skip }, async () => {
	const root = await tempRoot();
	try {
		const target = join(root, "target.json");
		await writeFile(target, "old\n");
		await writeFile(join(root, "plain.tmp"), "plain\n");
		await writeFile(join(root, "new.tmp"), "new\n");

		const holder = holdOpen(target, 700);
		await holder.held;
		await assert.rejects(rename(join(root, "plain.tmp"), target), (error) =>
			["EPERM", "EACCES", "EBUSY"].includes(error.code),
		);
		let checks = 0;
		await renameReplacing(join(root, "new.tmp"), target, () => {
			checks += 1;
		});
		assert.equal(await readFile(target, "utf8"), "new\n");
		assert.ok(checks > 0, "beforeRetry must run before a retry");
		await holder.exited;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("renameReplacing stops when a repeated check fails and leaves the target alone", { skip }, async () => {
	const root = await tempRoot();
	try {
		const target = join(root, "target.json");
		await writeFile(target, "old\n");
		await writeFile(join(root, "new.tmp"), "new\n");
		const holder = holdOpen(target, 700);
		await holder.held;
		await assert.rejects(
			renameReplacing(join(root, "new.tmp"), target, () => {
				throw new Error("safety check failed");
			}),
			/safety check failed/u,
		);
		await holder.exited;
		assert.equal(await readFile(target, "utf8"), "old\n");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("renameReplacing does not retry errors that are not sharing violations", { skip }, async () => {
	const root = await tempRoot();
	try {
		let checks = 0;
		await assert.rejects(
			renameReplacing(join(root, "missing.tmp"), join(root, "target.json"), () => {
				checks += 1;
			}),
			(error) => error.code === "ENOENT",
		);
		assert.equal(checks, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("writePrivateFileAtomic replaces a file that a reader briefly holds open", { skip }, async () => {
	const root = await tempRoot();
	try {
		const target = join(root, "settings.json");
		await writePrivateFileAtomic(target, "old\n");
		const holder = holdOpen(target, 700);
		await holder.held;
		await writePrivateFileAtomic(target, "new\n");
		assert.equal(await readFile(target, "utf8"), "new\n");
		await holder.exited;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
