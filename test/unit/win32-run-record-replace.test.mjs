import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeJsonAtomic } from "../../.tmp/unit/store.js";

// Open the target with FileShare.Read only (no Delete) for holdMs, as
// antivirus, indexers and PowerShell readers do; a plain rename over it
// then fails with EPERM on Windows.
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

test("writeJsonAtomic replaces a run record that a reader briefly holds open", { skip: process.platform !== "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "piwf-run-record-replace-"));
	try {
		const file = join(root, "run.json");
		await writeFile(file, `${JSON.stringify({ generation: 1 })}\n`);
		const holder = holdOpen(file, 700);
		await holder.held;
		await writeJsonAtomic(file, { generation: 2 });
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { generation: 2 });
		await holder.exited;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
