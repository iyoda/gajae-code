/**
 * Official GC of already-quarantined empty `.gjc-delete-*` receipts.
 * Roots are operator operands — never hardcoded host paths.
 */

import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { exactUnlinkDirect, type NativeExactUnlinkResult } from "@gajae-code/natives";

export const EMPTY_DELETE_PREFIX = ".gjc-delete-";
const EMPTY_DELETE_RECEIPT_PATTERN =
	/^\.gjc-delete-session-state-lock-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;
const EMPTY_FILE_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface EmptyDeleteIdentity {
	dev: bigint;
	ino: bigint;
	nlink: bigint;
	size: bigint;
	mtimeNs: bigint;
	parentDev: bigint;
	parentIno: bigint;
	sha256: string;
}

export interface EmptyDeleteGcRecord {
	root: string;
	path: string;
	action: "would_remove" | "removed" | "kept" | "skipped";
	reason: string;
	identity?: EmptyDeleteIdentity;
	/** Retained-object paths a native direct unlink left behind; operator-recoverable only there. */
	retainedPaths?: { detached?: string; successor?: string; placeholder?: string; unknown?: string };
}

export interface EmptyDeleteGcReport {
	dry_run: boolean;
	roots: string[];
	records: EmptyDeleteGcRecord[];
	would_remove: number;
	removed: number;
	kept: number;
	skipped: number;
	errors: string[];
}

export interface EmptyDeleteGcOptions {
	roots: string[];
	prune: boolean;
}

function isUnsafeName(name: string): boolean {
	return name.includes("/") || name.includes("\0") || name === "." || name === "..";
}

function identityOf(stat: BigIntStats): Omit<EmptyDeleteIdentity, "parentDev" | "parentIno" | "sha256"> {
	return {
		dev: stat.dev,
		ino: stat.ino,
		nlink: stat.nlink,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
	};
}

/**
 * Extract the operator-recoverable retained paths a native direct unlink can leave behind.
 * Any of them means debris still exists outside the receipt namespace, so the caller
 * records them and fails the run instead of reporting a clean prune.
 */
function retainedPathsOf(
	result: NativeExactUnlinkResult,
): { detached?: string; successor?: string; placeholder?: string; unknown?: string } | undefined {
	if (
		result.detachedPath === undefined &&
		result.retainedSuccessorPath === undefined &&
		result.retainedPlaceholderPath === undefined &&
		result.retainedUnknownPath === undefined
	)
		return undefined;
	return {
		detached: result.detachedPath,
		successor: result.retainedSuccessorPath,
		placeholder: result.retainedPlaceholderPath,
		unknown: result.retainedUnknownPath,
	};
}

function isEmptyDeleteReceiptName(name: string): boolean {
	return EMPTY_DELETE_RECEIPT_PATTERN.test(name);
}

export async function collectEmptyDeleteReceipts(root: string): Promise<EmptyDeleteGcRecord[]> {
	const records: EmptyDeleteGcRecord[] = [];
	let rootStat: BigIntStats;
	try {
		rootStat = await fs.lstat(root, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [{ root, path: root, action: "skipped", reason: "missing_root" }];
		}
		throw error;
	}
	if (rootStat.isSymbolicLink()) {
		return [{ root, path: root, action: "skipped", reason: "symlink_root" }];
	}
	if (!rootStat.isDirectory()) {
		return [{ root, path: root, action: "skipped", reason: "not_directory" }];
	}
	let names: string[];
	try {
		names = await fs.readdir(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [{ root, path: root, action: "skipped", reason: "missing_root" }];
		}
		throw error;
	}
	for (const name of names) {
		if (isUnsafeName(name) || !isEmptyDeleteReceiptName(name)) continue;
		const file = path.join(root, name);
		let stat: BigIntStats;
		try {
			stat = await fs.lstat(file, { bigint: true });
		} catch (error) {
			// ENOENT is an ordinary race with concurrent cleanup; any other stat failure is
			// a hard discovery error that must surface instead of silently shrinking the report.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (stat.isSymbolicLink()) {
			records.push({ root, path: file, action: "kept", reason: "symlink" });
			continue;
		}
		if (!stat.isFile()) {
			records.push({ root, path: file, action: "kept", reason: "not_regular" });
			continue;
		}
		if (stat.size !== 0n) {
			records.push({ root, path: file, action: "kept", reason: "non_empty" });
			continue;
		}
		if (stat.nlink !== 1n) {
			records.push({ root, path: file, action: "kept", reason: "nlink" });
			continue;
		}
		records.push({
			root,
			path: file,
			action: "would_remove",
			reason: "empty_delete_receipt",
			identity: {
				...identityOf(stat),
				parentDev: rootStat.dev,
				parentIno: rootStat.ino,
				sha256: EMPTY_FILE_SHA256,
			},
		});
	}
	return records;
}

export async function runEmptyDeleteGc(options: EmptyDeleteGcOptions): Promise<EmptyDeleteGcReport> {
	const report: EmptyDeleteGcReport = {
		dry_run: !options.prune,
		roots: options.roots,
		records: [],
		would_remove: 0,
		removed: 0,
		kept: 0,
		skipped: 0,
		errors: [],
	};
	for (const root of options.roots) {
		let records: EmptyDeleteGcRecord[];
		try {
			records = await collectEmptyDeleteReceipts(root);
		} catch (error) {
			report.errors.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		for (const record of records) {
			if (record.action === "would_remove" && options.prune) {
				try {
					if (!record.identity) {
						record.action = "kept";
						record.reason = "identity_missing";
					} else {
						const result = exactUnlinkDirect(record.path, {
							...record.identity,
							quarantineName: `.gjc-delete-gc-${randomUUID()}.json`,
						});
						const retainedPaths = retainedPathsOf(result);
						if (result.ok) {
							record.action = "removed";
						} else if (result.code === "not_found") {
							record.action = "skipped";
							record.reason = "gone";
						} else if (result.code === "identity_mismatch") {
							record.action = "kept";
							record.reason = "identity_drift";
						} else {
							record.action = "kept";
							record.reason = `unlink_failed:${result.code ?? "unknown"}`;
							report.errors.push(`${record.path}: ${record.reason}`);
						}
						// Objects the native layer retained (post-detach failure or a successor at
						// the private quarantine name) are recoverable only at those paths; surface
						// them and fail the run instead of silently stranding debris.
						if (retainedPaths !== undefined) {
							record.retainedPaths = retainedPaths;
							record.reason = result.ok ? `retained:${result.code ?? "cleanup_pending"}` : record.reason;
							report.errors.push(
								`${record.path}: retained debris requires operator recovery: ${JSON.stringify(retainedPaths)}`,
							);
						}
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						record.action = "skipped";
						record.reason = "gone";
					} else {
						record.action = "kept";
						record.reason = `unlink_failed:${error instanceof Error ? error.message : String(error)}`;
						report.errors.push(`${record.path}: ${record.reason}`);
					}
				}
			}
			report.records.push(record);
			if (record.action === "would_remove") report.would_remove += 1;
			else if (record.action === "removed") report.removed += 1;
			else if (record.action === "skipped") report.skipped += 1;
			else report.kept += 1;
		}
	}
	return report;
}
