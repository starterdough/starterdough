/**
 * Artifact naming. Every backup run produces a set of files sharing one UTC stamp
 * (`YYYYMMDDTHHMMSSZ`): the pg_dump custom-format archive, optionally the uploads tarball and
 * the manifest describing the set. Stamps sort lexically in time order, so "latest" is `max()`.
 */

export const ARTIFACT_PREFIX = 'starterdough_';

export type ArtifactKind = 'dump' | 'uploads' | 'manifest';

const SUFFIXES: Record<ArtifactKind, string> = {
	dump: '.dump',
	uploads: '.uploads.tar.gz',
	manifest: '.json',
};

const STAMP_PATTERN = /^\d{8}T\d{6}Z$/;
const NAME_PATTERN = /^starterdough_(\d{8}T\d{6}Z)(\.dump|\.uploads\.tar\.gz|\.json)$/;

export interface Manifest {
	stamp: string;
	createdAt: string;
	/** Database name that was dumped. */
	database: string;
	pgDumpVersion: string;
	uploadsIncluded: boolean;
	files: ManifestFile[];
	/** `TABLE DATA` entries `pg_restore --list` found in the dump. Absent in older manifests. */
	tableEntries?: number;
	/**
	 * Rows per `public` table at dump time, so a restore can be checked against what was captured
	 * rather than only against the table list. Absent when the count could not be taken in time and
	 * in older manifests. See {@link ROW_COUNT_TOLERANCE} for what a drill does with them.
	 */
	rowCounts?: Record<string, number>;
	/** Why the uploads archive is incomplete, when `tar` reported unreadable or changed files. */
	uploadsDegraded?: string;
	/** Configuration warnings that were in force for the run. Absent in older manifests. */
	warnings?: string[];
}

/**
 * How far a restored table's row count may fall short of the manifest's before a drill calls it a
 * failure. The counts are taken right after `pg_dump`, not inside its snapshot, so a database that
 * is still being written to drifts by a few rows; the failure this catches is the gross one — a
 * restore whose data entries mostly failed and left tables that exist but are empty.
 */
export const ROW_COUNT_TOLERANCE = 0.05;

/**
 * A stamp this far ahead of the clock is one machine's NTP failure, not a backup from the future.
 * `latest` skips those: without the guard one wrong clock leaves a set that shadows every real
 * backup until real time catches up with it.
 */
export const FUTURE_STAMP_TOLERANCE_MS = 3_600_000;

export interface ManifestFile {
	name: string;
	bytes: number;
	/** Hex SHA-256 of the file as it was written. Absent in older manifests. */
	sha256?: string;
}

/**
 * Shape check for a manifest read back from disk, where anything may have been edited or truncated.
 * The fields added after the first release are optional, so manifests written by an older version
 * still read back as valid.
 */
export function isManifest(value: unknown): value is Manifest {
	return (
		isRecord(value) &&
		typeof value.stamp === 'string' &&
		typeof value.createdAt === 'string' &&
		typeof value.database === 'string' &&
		typeof value.pgDumpVersion === 'string' &&
		typeof value.uploadsIncluded === 'boolean' &&
		(value.tableEntries === undefined || typeof value.tableEntries === 'number') &&
		(value.rowCounts === undefined || isNumberRecord(value.rowCounts)) &&
		(value.uploadsDegraded === undefined || typeof value.uploadsDegraded === 'string') &&
		(value.warnings === undefined || isStringArray(value.warnings)) &&
		Array.isArray(value.files) &&
		value.files.every(
			(file: unknown) =>
				isRecord(file) &&
				typeof file.name === 'string' &&
				typeof file.bytes === 'number' &&
				(file.sha256 === undefined || typeof file.sha256 === 'string'),
		)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

function isNumberRecord(value: unknown): boolean {
	return (
		isRecord(value) &&
		!Array.isArray(value) &&
		Object.values(value).every((entry) => typeof entry === 'number')
	);
}

export function stampFor(date: Date): string {
	const iso = date.toISOString(); // 2026-09-09T12:34:56.789Z
	return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
}

export function isStamp(candidate: string): boolean {
	return STAMP_PATTERN.test(candidate) && stampToDate(candidate) !== null;
}

/** The instant a stamp denotes, or null when it is not a well-formed stamp. */
export function stampToDate(stamp: string): Date | null {
	if (!STAMP_PATTERN.test(stamp)) return null;
	const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;
	const date = new Date(iso);
	// `new Date` normalises impossible dates such as month 13; round-tripping catches those.
	return Number.isNaN(date.getTime()) || stampFor(date) !== stamp ? null : date;
}

export function artifactName(kind: ArtifactKind, stamp: string): string {
	return `${ARTIFACT_PREFIX}${stamp}${SUFFIXES[kind]}`;
}

export const dumpName = (stamp: string) => artifactName('dump', stamp);
export const uploadsName = (stamp: string) => artifactName('uploads', stamp);
export const manifestName = (stamp: string) => artifactName('manifest', stamp);

export interface ParsedArtifact {
	stamp: string;
	kind: ArtifactKind;
}

/** Recognises an artifact from a file name or an S3 key; anything else yields null. */
export function parseArtifact(nameOrKey: string): ParsedArtifact | null {
	const base = nameOrKey.slice(nameOrKey.lastIndexOf('/') + 1);
	const match = NAME_PATTERN.exec(base);
	if (!match) return null;
	const stamp = match[1] as string;
	if (stampToDate(stamp) === null) return null;
	const kind = (Object.keys(SUFFIXES) as ArtifactKind[]).find((k) => SUFFIXES[k] === match[2]);
	return kind ? { stamp, kind } : null;
}

/** The stamp of an artifact file name or key, or null when it is not one of ours. */
export function parseStamp(nameOrKey: string): string | null {
	return parseArtifact(nameOrKey)?.stamp ?? null;
}

/**
 * Sets that survive pruning no matter how old they are. Age-only retention empties the directory
 * when backups stop (a broken schedule, a container that will not start, a wrong clock) exactly
 * when the last good set is the one thing that matters, so the newest few are a floor.
 */
export const RETENTION_FLOOR_SETS = 3;

/**
 * Names whose stamp is older than `retentionDays` before `now`, except those of the newest
 * {@link RETENTION_FLOOR_SETS} complete sets. Names that are not artifacts are never selected,
 * which keeps pruning safe inside a bucket shared with the uploads.
 */
export function selectExpired(names: string[], retentionDays: number, now: Date): string[] {
	const cutoff = now.getTime() - retentionDays * 86_400_000;
	const floor = newestCompleteStamps(names, RETENTION_FLOOR_SETS);
	return names.filter((name) => {
		const stamp = parseStamp(name);
		if (stamp === null || floor.has(stamp)) return false;
		const date = stampToDate(stamp);
		return date !== null && date.getTime() < cutoff;
	});
}

/**
 * Stamps of the newest `count` sets that have both a dump and a manifest. The manifest is written
 * and uploaded last, so its presence is what makes a set restorable rather than half-written.
 */
export function newestCompleteStamps(names: string[], count: number): Set<string> {
	const complete: string[] = [];
	for (const [stamp, artifacts] of groupByStamp(names)) {
		const kinds = new Set(artifacts.map((artifact) => artifact.kind));
		if (kinds.has('dump') && kinds.has('manifest')) complete.push(stamp);
		if (complete.length === count) break;
	}
	return new Set(complete);
}

/** Groups artifact names (or keys) by stamp, newest first. */
export function groupByStamp(names: string[]): Map<string, ParsedArtifact[]> {
	const groups = new Map<string, ParsedArtifact[]>();
	for (const name of names) {
		const parsed = parseArtifact(name);
		if (!parsed) continue;
		const list = groups.get(parsed.stamp) ?? [];
		list.push(parsed);
		groups.set(parsed.stamp, list);
	}
	return new Map([...groups.entries()].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)));
}

/**
 * The newest stamp among the names that carry a dump, or null. Stamps are the UTC instant the run
 * started, so ordering by stamp is ordering by the manifest's `createdAt` without reading 30 files.
 * Stamps more than {@link FUTURE_STAMP_TOLERANCE_MS} ahead of `now` are skipped, not sorted highest:
 * see {@link futureStamps}.
 */
export function latestDumpStamp(names: string[], now: Date = new Date()): string | null {
	const horizon = now.getTime() + FUTURE_STAMP_TOLERANCE_MS;
	let latest: string | null = null;
	for (const name of names) {
		const parsed = parseArtifact(name);
		if (parsed?.kind !== 'dump') continue;
		const date = stampToDate(parsed.stamp);
		if (date === null || date.getTime() > horizon) continue;
		if (latest === null || parsed.stamp > latest) latest = parsed.stamp;
	}
	return latest;
}

/**
 * Stamps among the names that are further ahead of `now` than {@link FUTURE_STAMP_TOLERANCE_MS} —
 * a clock that was wrong when the set was written. They are reported rather than silently dropped:
 * the set is still restorable by its stamp, it just cannot be `latest`.
 */
export function futureStamps(names: string[], now: Date = new Date()): string[] {
	const horizon = now.getTime() + FUTURE_STAMP_TOLERANCE_MS;
	const stamps = new Set<string>();
	for (const name of names) {
		const stamp = parseStamp(name);
		const date = stamp === null ? null : stampToDate(stamp);
		if (stamp !== null && date !== null && date.getTime() > horizon) stamps.add(stamp);
	}
	return [...stamps].sort();
}

export function createManifest(input: {
	stamp: string;
	database: string;
	pgDumpVersion: string;
	files: ManifestFile[];
	tableEntries: number;
	rowCounts: Record<string, number> | null;
	uploadsDegraded: string | null;
	warnings: string[];
}): Manifest {
	const createdAt = stampToDate(input.stamp)?.toISOString();
	if (!createdAt) throw new Error(`Invalid stamp: ${input.stamp}`);
	return {
		stamp: input.stamp,
		createdAt,
		database: input.database,
		pgDumpVersion: input.pgDumpVersion,
		uploadsIncluded: input.files.some((file) => parseArtifact(file.name)?.kind === 'uploads'),
		files: input.files,
		tableEntries: input.tableEntries,
		...(input.rowCounts ? { rowCounts: input.rowCounts } : {}),
		...(input.uploadsDegraded ? { uploadsDegraded: input.uploadsDegraded } : {}),
		warnings: input.warnings,
	};
}
