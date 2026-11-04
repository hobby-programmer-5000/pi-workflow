import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { managedWorktreePath } from "../../.tmp/unit/store.js";
import { ensureManagedWorktree } from "../../.tmp/unit/worktree.js";

const git = (cwd, ...args) =>
	execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

async function makeRepo() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "piwf-worktree-relaunch-")));
	git(root, "init", "-q");
	await writeFile(join(root, "README.md"), "demo\n");
	git(root, "add", "README.md");
	git(root, "commit", "-qm", "init");
	return root;
}

function fixture(root) {
	const run = { runId: "workflow_mwtest01_a1b2c3" };
	const task = { taskId: "task-1", worktree: { enabled: false } };
	const compiledTask = { cwd: root, safety: { requiresWorktree: true } };
	return { run, task, compiledTask };
}

// Launch preparation copies task.cwd into the relaunched task, so an output
// retry or resume reaches ensureManagedWorktree with the worktree as its cwd.
test("relaunch from inside the managed worktree reuses it instead of deleting it", async () => {
	const root = await makeRepo();
	try {
		const { run, task, compiledTask } = fixture(root);
		const path = managedWorktreePath(root, run.runId, task.taskId);
		await ensureManagedWorktree(root, run, task, compiledTask);
		assert.equal(resolve(task.cwd), resolve(path));
		assert.equal(task.worktree.baseCwd, root);

		await ensureManagedWorktree(root, run, task, { ...compiledTask, cwd: task.cwd });
		assert.ok(existsSync(join(path, "README.md")), "worktree must survive the relaunch");
		assert.equal(resolve(task.cwd), resolve(path));
		assert.equal(task.worktree.baseCwd, root, "base checkout must stay the source repository");
		assert.equal(task.worktree.warning, "reusing existing managed worktree path");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("relaunch after the source checkout changed recreates the worktree from the source repository", async () => {
	const root = await makeRepo();
	try {
		const { run, task, compiledTask } = fixture(root);
		const path = managedWorktreePath(root, run.runId, task.taskId);
		await ensureManagedWorktree(root, run, task, compiledTask);
		await writeFile(join(root, "README.md"), "changed after first launch\n");

		await ensureManagedWorktree(root, run, task, { ...compiledTask, cwd: task.cwd });
		assert.ok(existsSync(path), "worktree must be recreated");
		assert.equal(resolve(task.cwd), resolve(path));
		assert.equal(task.worktree.baseCwd, root);
		assert.equal(task.worktree.snapshot.dirty, true);
		assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD").trim(), `pi-workflow/${run.runId}-${task.taskId}`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
