import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { prepareSubagentTaskLaunch } from "../../.tmp/unit/subagent-backend.js";

const NATIVE_TOOLS = [
	"codemode",
	"tool_search",
	"mcp__*",
	"list_mcp_resources",
	"list_mcp_resource_templates",
	"read_mcp_resource",
];

function project() {
	const cwd = mkdtempSync(join(tmpdir(), "native-host-web-source-"));
	mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "agents", "web-reader.md"),
		"---\nname: web-reader\ndescription: web reader\ntools: [read, workflow_web_search, workflow_web_fetch_source, workflow_web_source_read]\nreadOnly: true\n---\nUse sources.\n",
	);
	return cwd;
}

function spec() {
	return {
		schemaVersion: 1,
		name: "native-web",
		defaults: {
			agent: "web-reader",
			readOnly: true,
			tools: ["read", "workflow_web_search", "workflow_web_fetch_source", "workflow_web_source_read"],
		},
		artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Research with web sources." }] },
	};
}

// Pi 1.1 native hosts expand every model task with codemode/tool_search/MCP,
// recorded as classification-only toolProviders. A stage that also uses the
// normalized web-source tools must still prepare: those native tools are
// served by Pi itself and are not passthroughs of a provider extension.
test("web-source stages prepare under a native host without treating native tools as provider passthroughs", async () => {
	const cwd = project();
	try {
		const nativeHost = { version: 1, cwd, agentDir: join(cwd, ".pi"), projectTrusted: true };
		const compiled = await compileWorkflow(spec(), { cwd, task: "check", nativeHost });
		const task = compiled.tasks[0];
		assert.equal(task.runtime.nativeToolsEnabled, true);
		for (const tool of NATIVE_TOOLS) {
			assert.ok(task.runtime.tools.includes(tool), `expected native tool ${tool}`);
			assert.equal(task.runtime.toolProviders[tool]?.extensions, undefined);
		}

		const prepared = await prepareSubagentTaskLaunch(
			cwd,
			{ runId: "native-web", nativeHost },
			{ taskId: "task", files: { result: ".tmp/result.json" } },
			task,
		);
		const wrapper = prepared.generatedExtensions.find((entry) => entry.kind === "web-source");
		assert.ok(wrapper, "web-source wrapper must be generated");
		const passthrough = /"passthroughProviderTools": (\[[^\]]*\])/u.exec(wrapper.expectedBytes);
		assert.ok(passthrough, "wrapper must declare passthroughProviderTools");
		assert.deepEqual(JSON.parse(passthrough[1]), []);
		for (const tool of NATIVE_TOOLS)
			assert.equal(wrapper.expectedBytes.includes(`"${tool}": [`), false, `${tool} must not get a provider owner`);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
