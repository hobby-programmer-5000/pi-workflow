/**
 * One-line description of a scheduling error for the supervisor log. An
 * AggregateError's own message only says that something failed; the causes
 * are in `.errors`, so include them or the real failure never reaches the log.
 */
export function describeScheduleError(error) {
	const message = error?.message ?? String(error);
	if (!Array.isArray(error?.errors) || error.errors.length === 0) return message;
	const causes = error.errors.map((cause) => describeScheduleError(cause));
	return `${message} (caused by: ${causes.join("; ")})`;
}
