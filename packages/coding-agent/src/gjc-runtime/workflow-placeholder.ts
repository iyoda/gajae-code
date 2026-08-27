/** Shared placeholder semantics for model-authored workflow content. */

const WORKFLOW_PLACEHOLDER_TOKENS = new Set([
	"empty",
	"n/a",
	"n-a",
	"na",
	"none",
	"placeholder",
	"stub",
	"tbd",
	"todo",
	"unused",
]);

export const WORKFLOW_PLACEHOLDER_CORRECTION =
	"provide a specific, non-placeholder question or objective instead of empty, whitespace, unused, TODO, TBD, N/A, none, placeholder, or stub";

/** Exact, case-insensitive placeholder detection; meaningful sentences remain valid. */
export function isWorkflowPlaceholderText(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const normalized = value.trim().toLowerCase();
	return normalized.length === 0 || WORKFLOW_PLACEHOLDER_TOKENS.has(normalized);
}
