import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackupConfig } from './config';
import type { Logger } from './log';
import {
	type ArtifactKind,
	artifactName,
	futureStamps,
	groupByStamp,
	isManifest,
	type Manifest,
	manifestName,
	newestCompleteStampsBySource,
	stampToDate,
} from './names';
import { BackupBucket } from './s3';

export interface BackupSet {
	stamp: string;
	createdAt: string;
	/** Which artifacts exist locally, by kind. */
	local: ArtifactKind[];
	/** Which artifacts exist in the bucket, by kind. */
	remote: ArtifactKind[];
	/** Total bytes of the artifacts, local sizes preferred over remote ones. */
	bytes: number;
	/** The manifest's contents when it is available locally. */
	manifest: Manifest | null;
}

export interface ListResult {
	sets: BackupSet[];
	/** Pre-restore dumps in `BACKUP_DIR`; nothing prunes these, so their size is the operator's problem. */
	safetyDumps: { name: string; bytes: number; modified: string }[];
	/** Age of the newest usable set in milliseconds, or null when there is none. */
	newestAgeMs: number | null;
	/** False when the newest set is older than `maxAgeMs`, which is what makes `list` exit non-zero. */
	fresh: boolean;
}

/** Pre-restore dumps are deliberately outside the artifact naming; this is how `list` finds them. */
const SAFETY_DUMP_PATTERN = /_pre_restore\.dump$/;

/**
 * Every backup set known locally or remotely, newest first, and logs one line per set. Also answers
 * the question a monitoring system actually asks ("is there a recent backup"), because a set of
 * six-week-old sets lists exactly as cleanly as last night's.
 */
export async function listBackups(
	config: BackupConfig,
	log: Logger,
	bucket: BackupBucket | null = config.s3 ? new BackupBucket(config.s3) : null,
	now: Date = new Date(),
): Promise<ListResult> {
	await mkdir(config.backupDir, { recursive: true });
	const localNames = await readdir(config.backupDir);
	const localSizes = new Map<string, number>();
	const safetyDumps: ListResult['safetyDumps'] = [];
	for (const name of localNames) {
		const info = await stat(join(config.backupDir, name)).catch(() => null);
		if (!info?.isFile()) continue;
		localSizes.set(name, info.size);
		if (SAFETY_DUMP_PATTERN.test(name)) {
			safetyDumps.push({
				name,
				bytes: info.size,
				modified: new Date(info.mtimeMs).toISOString(),
			});
		}
	}
	const remote = bucket ? await bucket.list() : [];
	const remoteSizes = new Map(remote.map((object) => [object.key, object.size]));

	const localGroups = groupByStamp(localNames);
	const remoteGroups = groupByStamp(remote.map((object) => object.key));
	const stamps = [...new Set([...localGroups.keys(), ...remoteGroups.keys()])].sort().reverse();
	const ahead = new Set(futureStamps([...localNames, ...remote.map((object) => object.key)], now));

	const sets: BackupSet[] = [];
	for (const stamp of stamps) {
		const local = (localGroups.get(stamp) ?? []).map((artifact) => artifact.kind);
		const remoteKinds = (remoteGroups.get(stamp) ?? []).map((artifact) => artifact.kind);
		let bytes = 0;
		for (const kind of new Set([...local, ...remoteKinds])) {
			const name = artifactName(kind, stamp);
			const remoteBytes = bucket ? remoteSizes.get(bucket.keyFor(name)) : undefined;
			bytes += localSizes.get(name) ?? remoteBytes ?? 0;
		}
		const manifest = local.includes('manifest')
			? await readManifest(join(config.backupDir, manifestName(stamp)), log)
			: null;
		const set: BackupSet = {
			stamp,
			createdAt: stampToDate(stamp)?.toISOString() ?? '',
			local,
			remote: remoteKinds,
			bytes,
			manifest,
		};
		sets.push(set);
		log.info(`backup ${stamp}`, {
			createdAt: set.createdAt,
			local: set.local,
			remote: set.remote,
			bytes: set.bytes,
			database: manifest?.database,
			pgDumpVersion: manifest?.pgDumpVersion,
			uploadsIncluded: manifest?.uploadsIncluded,
			uploadsDegraded: manifest?.uploadsDegraded,
			rows: manifest?.rowCounts
				? Object.values(manifest.rowCounts).reduce((sum, count) => sum + count, 0)
				: undefined,
			futureDated: ahead.has(stamp) || undefined,
		});
	}

	for (const dump of safetyDumps) {
		log.info(`pre-restore dump ${dump.name}`, {
			...dump,
			hint: 'nothing prunes these; delete it once you are sure the restore was the right one',
		});
	}
	if (ahead.size > 0) {
		log.warn('some sets are dated in the future and are skipped by "restore latest"', {
			stamps: [...ahead],
			hint: 'check the clock (NTP) of the machine that wrote them',
		});
	}

	// The newest set that could actually be restored: a manifest without its dump is not a backup,
	// and a future-dated stamp is not evidence that a backup happened.
	const complete = newestCompleteStampsBySource(
		[localNames, remote.map((object) => object.key)],
		Number.POSITIVE_INFINITY,
	);
	const usableStamp = [...complete].find((stamp) => !ahead.has(stamp));
	const newestAgeMs =
		usableStamp === undefined ? null : now.getTime() - (stampToDate(usableStamp)?.getTime() ?? 0);
	// An infinite limit is `--no-max-age`: list, do not judge.
	const fresh =
		!Number.isFinite(config.maxAgeMs) || (newestAgeMs !== null && newestAgeMs <= config.maxAgeMs);
	log.info('backup sets', {
		count: sets.length,
		dir: config.backupDir,
		bucket: bucket ? `${bucket.bucket}/${bucket.prefix}` : null,
		safetyDumps: safetyDumps.length,
		safetyDumpBytes: safetyDumps.reduce((sum, dump) => sum + dump.bytes, 0),
		newest: usableStamp ?? null,
		newestAgeMs,
		maxAgeMs: config.maxAgeMs,
		fresh,
	});
	if (!fresh) {
		log.error(
			newestAgeMs === null
				? 'no restorable backup set exists'
				: `the newest backup set is ${humanMs(newestAgeMs)} old, past the ${humanMs(config.maxAgeMs)} limit`,
			{ newest: usableStamp ?? null, maxAgeMs: config.maxAgeMs },
		);
	}
	return { sets, safetyDumps, newestAgeMs, fresh };
}

/** Coarse but never "0 h": the operator reads this line to decide whether to be worried. */
function humanMs(ms: number): string {
	if (ms >= 2 * 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
	if (ms >= 2 * 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
	if (ms >= 2 * 60_000) return `${Math.round(ms / 60_000)}m`;
	return `${Math.round(ms / 1_000)}s`;
}

/** A manifest that does not parse or has the wrong shape is reported, not trusted. */
async function readManifest(path: string, log: Logger): Promise<Manifest | null> {
	let parsed: unknown;
	try {
		parsed = await Bun.file(path).json();
	} catch (error) {
		log.warn('manifest is not readable JSON', { file: path, error });
		return null;
	}
	if (isManifest(parsed)) return parsed;
	log.warn('manifest is malformed; ignoring it', { file: path });
	return null;
}
