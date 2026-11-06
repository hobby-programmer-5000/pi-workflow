import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { describeScheduleError } from "../../src/schedule-error-detail.mjs";

test("a plain scheduling error is logged by its message", () => {
	assert.equal(describeScheduleError(new Error("boom")), "boom");
	assert.equal(describeScheduleError("text failure"), "text failure");
});

test("an AggregateError logs its causes, including nested ones", () => {
	const inner = new AggregateError([new Error("EPERM: rename run.json")], "launch failed");
	const outer = new AggregateError(
		[inner, new Error("interrupt unsupported")],
		"durable launch barrier failed and provisional worker interruption was not acknowledged",
	);
	assert.equal(
		describeScheduleError(outer),
		"durable launch barrier failed and provisional worker interruption was not acknowledged (caused by: launch failed (caused by: EPERM: rename run.json); interrupt unsupported)",
	);
});

test("the supervisor uses the description for schedule errors", () => {
	const cli = readFileSync(new URL("../../src/cli.mjs", import.meta.url), "utf8");
	assert.match(cli, /schedule error \$\{run\.runId\}: \$\{describeScheduleError\(error\)\}/u);
});
