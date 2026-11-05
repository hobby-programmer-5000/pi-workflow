import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseAgentMarkdown } from "../../.tmp/unit/agents.js";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import { listWorkflows } from "../../.tmp/unit/workflow-specs.js";

// Windows PowerShell 5.1 `Set-Content -Encoding utf8` and some editors write
// a UTF-8 byte order mark. Authored specs, control schemas and agent files
// must still load, and the agent's frontmatter (tool ceiling) must not be lost.
const BOM = "﻿";

function bomProject() {
	const cwd = mkdtempSync(join(tmpdir(), "authored-file-bom-"));
	const bundle = join(cwd, ".pi", "workflows", "bom-flow");
	mkdirSync(join(bundle, "schemas"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "agents", "bom-reader.md"),
		`${BOM}---\nname: bom-reader\ndescription: reader saved with a BOM\ntools: [read, ls]\nreadOnly: true\n---\nRead only.\n`,
	);
	writeFileSync(
		join(bundle, "schemas", "main-control.schema.json"),
		`${BOM}${JSON.stringify({ type: "object", required: ["schema", "digest"], properties: { schema: { type: "string" }, digest: { type: "string" } } })}\n`,
	);
	writeFileSync(
		join(bundle, "spec.json"),
		`${BOM}${JSON.stringify({
			schemaVersion: 1,
			name: "bom-flow",
			defaults: { agent: "bom-reader", readOnly: true, tools: ["read", "ls"] },
			artifactGraph: {
				stages: [
					{
						id: "main",
						type: "single",
						prompt: "Summarize.",
						output: { controlSchema: "./schemas/main-control.schema.json" },
					},
				],
			},
		}, null, 2)}\n`,
	);
	return { cwd, specPath: join(bundle, "spec.json") };
}

test("a spec, control schema and agent saved with a UTF-8 BOM load and compile", async () => {
	const { cwd, specPath } = bomProject();
	try {
		const loaded = await loadWorkflowSpec(specPath, cwd);
		assert.equal(loaded.spec.name, "bom-flow");

		const listed = await listWorkflows(cwd);
		assert.ok(listed.some((entry) => entry.name === "bom-flow"), "BOM spec must be discoverable");

		const compiled = await compileWorkflow(loaded.spec, { cwd, task: "check", specPath });
		const task = compiled.tasks.find((candidate) => candidate.id === "main.main") ?? compiled.tasks[0];
		assert.deepEqual(task.runtime.tools, ["read", "ls"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent frontmatter behind a UTF-8 BOM keeps its tool ceiling", () => {
	const agent = parseAgentMarkdown(
		`${BOM}---\nname: bom-agent\ndescription: d\ntools: [read]\nreadOnly: true\n---\nBody.\n`,
		join(tmpdir(), "bom-agent.md"),
		"project",
	);
	assert.equal(agent.name, "bom-agent");
	assert.deepEqual(agent.tools, ["read"]);
	assert.equal(agent.readOnly, true);
	assert.equal(agent.body.trim(), "Body.");
});
