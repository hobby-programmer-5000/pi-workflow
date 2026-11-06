import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const piRoot = join(repo, "node_modules", "@earendil-works", "pi-coding-agent");
const HOST_PROVIDED = new Set(["@earendil-works", "typebox"]);

// The layout of a package installed with `pi install git:...`: src/ and
// node_modules/ without dist/ (it is not committed and there is no TypeScript
// to build it with) and without the packages Pi provides to its extensions.
function gitInstallLayout() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "piwf-cli-no-build-")));
	const pkg = join(root, "pkg");
	mkdirSync(join(pkg, "node_modules"), { recursive: true });
	cpSync(join(repo, "src"), join(pkg, "src"), { recursive: true });
	cpSync(join(repo, "package.json"), join(pkg, "package.json"));
	for (const name of readdirSync(join(repo, "node_modules"))) {
		if (HOST_PROVIDED.has(name) || name.startsWith(".")) continue;
		symlinkSync(join(repo, "node_modules", name), join(pkg, "node_modules", name), "junction");
	}
	const project = join(root, "project");
	mkdirSync(project);
	return { root, pkg, project };
}

function runCli(pkg, project, env, ...args) {
	const clean = { ...process.env, PATH: "", Path: "", ...env };
	delete clean.PI_SUBAGENT_PI_PACKAGE_ROOT;
	delete clean.NODE_PATH;
	Object.assign(clean, env);
	return spawnSync(process.execPath, [join(pkg, "src", "cli.mjs"), ...args], {
		cwd: project,
		env: clean,
		encoding: "utf8",
		timeout: 180_000,
		windowsHide: true,
	});
}

function assertCommandsWork(pkg, project, env) {
	const notices = runCli(pkg, project, env, "notices", "list", "--json");
	assert.equal(notices.status, 0, notices.stderr);
	assert.ok(Array.isArray(JSON.parse(notices.stdout).notices));

	const pruned = runCli(pkg, project, env, "prune", "--keep", "100", "--json");
	assert.equal(pruned.status, 0, pruned.stderr);
	assert.equal(JSON.parse(pruned.stdout).dryRun, true);

	const supervised = runCli(pkg, project, env, "supervise", "--all", "--max-runtime-ms", "1000", "--poll-ms", "250");
	assert.equal(supervised.status, 0, supervised.stderr);
	assert.match(supervised.stdout, /done: no running runs remain/u);
}

test("without a build the CLI runs from source using the Pi that started it", () => {
	const { root, pkg, project } = gitInstallLayout();
	try {
		assert.equal(existsSync(join(pkg, "dist")), false);
		assert.equal(existsSync(join(pkg, "node_modules", "@earendil-works")), false);
		assertCommandsWork(pkg, project, { PI_SUBAGENT_PI_PACKAGE_ROOT: piRoot });
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test("without a build the CLI finds Pi through the launcher on PATH", () => {
	const { root, pkg, project } = gitInstallLayout();
	try {
		const bin = join(root, "bin");
		mkdirSync(join(bin, "node_modules", "@earendil-works"), { recursive: true });
		writeFileSync(join(bin, "pi.cmd"), "@echo off\r\n");
		writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
		symlinkSync(piRoot, join(bin, "node_modules", "@earendil-works", "pi-coding-agent"), "junction");
		assertCommandsWork(pkg, project, { PATH: bin, Path: bin });
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test(
	"without a build the CLI finds a project-installed Pi through node_modules/.bin on Windows",
	{ skip: process.platform !== "win32" && "npm .bin launchers are symlinks outside Windows" },
	() => {
		const { root, pkg, project } = gitInstallLayout();
		try {
			const modules = join(root, "pi-project", "node_modules");
			const bin = join(modules, ".bin");
			mkdirSync(bin, { recursive: true });
			mkdirSync(join(modules, "@earendil-works"), { recursive: true });
			writeFileSync(join(bin, "pi.cmd"), "@echo off\r\n");
			writeFileSync(join(bin, "pi"), "#!/bin/sh\n");
			symlinkSync(piRoot, join(modules, "@earendil-works", "pi-coding-agent"), "junction");
			assertCommandsWork(pkg, project, { PATH: bin, Path: bin });
		} finally {
			rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		}
	},
);

test("without a build or a Pi on PATH the CLI says what is missing", () => {
	const { root, pkg, project } = gitInstallLayout();
	try {
		const result = runCli(pkg, project, {}, "notices", "list");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /could not find the Pi installation/u);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});

test("the CLI still reports a missing engine when neither build nor source exists", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "piwf-cli-no-engine-")));
	try {
		const pkg = join(root, "pkg");
		mkdirSync(join(pkg, "src"), { recursive: true });
		for (const file of ["cli.mjs", "schedule-error-detail.mjs", "host-pi-packages.mjs"])
			cpSync(join(repo, "src", file), join(pkg, "src", file));
		writeFileSync(join(pkg, "package.json"), '{"type":"module"}\n');
		const result = runCli(pkg, root, {}, "notices", "list");
		assert.equal(result.status, 1);
		assert.match(result.stderr, /engine build is missing/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
