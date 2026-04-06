import generated from '$lib/server/build-info.generated.json';

export type BuildTreeState = 'clean' | 'dirty' | 'unknown';

export type BuildInfo = {
	version: string;
	commitHash: string | null;
	commitShort: string | null;
	branch: string | null;
	commitTimestamp: string | null;
	buildTimestamp: string | null;
	treeState: BuildTreeState;
	source: string;
};

const serverStartedAt = new Date().toISOString();

function nonEmpty(value: unknown): string | null {
	const text = typeof value === 'string' ? value.trim() : '';
	return text.length > 0 ? text : null;
}

function normalizeTreeState(value: unknown): BuildTreeState {
	const text = nonEmpty(value)?.toLowerCase();
	if (text === 'clean' || text === 'dirty') return text;
	return 'unknown';
}

function readEnv(keys: string[]): string | null {
	for (const key of keys) {
		const value = nonEmpty(process.env[key]);
		if (value) return value;
	}
	return null;
}

function commitShort(commitHash: string | null, fallback: unknown): string | null {
	const explicit = nonEmpty(fallback);
	if (explicit) return explicit;
	return commitHash ? commitHash.slice(0, 12) : null;
}

export function getBuildInfo(): BuildInfo {
	const generatedRecord = (generated ?? {}) as Record<string, unknown>;

	const version =
		nonEmpty(generatedRecord.version) ?? readEnv(['APP_VERSION', 'npm_package_version']) ?? '0.0.0';
	const commitHash =
		nonEmpty(generatedRecord.commitHash) ??
		readEnv([
			'REPORT_GIT_COMMIT',
			'AWS_COMMIT_ID',
			'CODEBUILD_RESOLVED_SOURCE_VERSION',
			'VERCEL_GIT_COMMIT_SHA',
			'GIT_COMMIT',
			'COMMIT_SHA'
		]);
	const branch = nonEmpty(generatedRecord.branch) ?? readEnv(['AWS_BRANCH', 'VERCEL_GIT_COMMIT_REF', 'GIT_BRANCH']);
	const commitTimestamp =
		nonEmpty(generatedRecord.commitTimestamp) ?? readEnv(['REPORT_GIT_COMMIT_TIMESTAMP', 'COMMIT_TIMESTAMP']);
	const buildTimestamp =
		nonEmpty(generatedRecord.buildTimestamp) ?? readEnv(['REPORT_BUILD_TIMESTAMP', 'BUILD_TIMESTAMP']) ?? serverStartedAt;
	const source = nonEmpty(generatedRecord.source) ?? 'runtime';

	return {
		version,
		commitHash,
		commitShort: commitShort(commitHash, generatedRecord.commitShort),
		branch,
		commitTimestamp,
		buildTimestamp,
		treeState: normalizeTreeState(generatedRecord.treeState),
		source
	};
}

