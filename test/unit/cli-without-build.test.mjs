import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// A package installed from git has src/ and node_modules/ but no dist/: dist is
// not committed and the install has no TypeScript to build it with.
function packageWithoutBuild() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "piwf-cli-no-build-")));
	const pkg = join(root, "pkg");
	mkdirSync(pkg);
	cpSync(join(repo, "src"), join(pkg, "src"), { recursive: true });
	cpSync(join(repo, "package.json"), join(pkg, "package.json"));
	symlinkSync(join(repo, "node_modules"), join(pkg, "node_modules"), "junction");
	const project = join(root, "project");
	mkdirSync(project);
	return { root, pkg, project };
}

function runCli(pkg, project, ...args) {
	return spawnSync(process.execPath, [join(pkg, "src", "cli.mjs"), ...args], {
		cwd: project,
		encoding: "utf8",
		timeout: 120_000,
		windowsHide: true,
	});
}

test("the CLI runs from source when there is no dist build", () => {
	const { root, pkg, project } = packageWithoutBuild();
	try {
		assert.equal(existsSync(join(pkg, "dist")), false);

		const notices = runCli(pkg, project, "notices", "list", "--json");
		assert.equal(notices.status, 0, notices.stderr);
		assert.ok(Array.isArray(JSON.parse(notices.stdout).notices));

		const pruned = runCli(pkg, project, "prune", "--keep", "100", "--json");
		assert.equal(pruned.status, 0, pruned.stderr);
		assert.equal(JSON.parse(pruned.stdout).dryRun, true);

		const noArgs = runCli(pkg, project, "supervise", "--all", "--max-runtime-ms", "1000", "--poll-ms", "250");
		assert.equal(noArgs.status, 0, noArgs.stderr);
		assert.match(noArgs.stdout, /done: no running runs remain/u);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test("the CLI still reports a missing engine when neither build nor source exists", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "piwf-cli-no-engine-")));
	try {
		const pkg = join(root, "pkg");
		mkdirSync(join(pkg, "src"), { recursive: true });
		cpSync(join(repo, "src", "cli.mjs"), join(pkg, "src", "cli.mjs"));
		cpSync(join(repo, "src", "schedule-error-detail.mjs"), join(pkg, "src", "schedule-error-detail.mjs"));
		writeFileSync(join(pkg, "package.json"), '{"type":"module"}\n');
		const result = runCli(pkg, root, "notices", "list");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /engine build is missing/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
