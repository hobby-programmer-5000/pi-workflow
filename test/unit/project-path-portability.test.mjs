import assert from "node:assert/strict";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { fromProjectPath, toProjectPath } from "../../.tmp/unit/store.js";

const cwd = resolve("project-root");

test("project paths persist with forward slashes and keep POSIX output unchanged", () => {
	const file = join(cwd, ".pi", "workflows", "run_1", "dynamic", "events.jsonl");
	const stored = toProjectPath(cwd, file);
	assert.equal(stored, ".pi/workflows/run_1/dynamic/events.jsonl");
	if (process.platform !== "win32") assert.equal(stored, relative(cwd, file));
	assert.equal(toProjectPath(cwd, cwd), ".");
	assert.equal(toProjectPath(cwd, "already/relative.json"), "already/relative.json");
	assert.equal(fromProjectPath(cwd, stored), file);
});

test("win32 still resolves project paths that older records stored with backslashes", {
	skip: process.platform !== "win32" && "backslash is a file-name character on POSIX",
}, () => {
	const file = join(cwd, ".pi", "workflows", "run_1", "result.json");
	assert.equal(fromProjectPath(cwd, ".pi\\workflows\\run_1\\result.json"), file);
});
