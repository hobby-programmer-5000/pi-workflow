/**
 * Text of workflow files that people author (specs, control schemas, agent
 * markdown) may start with a UTF-8 byte order mark: Windows PowerShell 5.1
 * `Set-Content -Encoding utf8`/`Out-File` and some editors write one.
 * JSON.parse rejects it and a frontmatter check no longer sees `---` first,
 * so drop a single leading BOM before interpreting the text. The bytes on
 * disk, and any digest taken of them, are unchanged.
 */
export function stripUtf8Bom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** JSON.parse for authored workflow files, tolerating a leading UTF-8 BOM. */
export function parseAuthoredJson(text: string): any {
	return JSON.parse(stripUtf8Bom(text));
}
