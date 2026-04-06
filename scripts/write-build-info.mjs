import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const packageJsonPath = path.join(repoRoot, 'package.json');
const outputPath = path.join(repoRoot, 'src', 'lib', 'server', 'build-info.generated.json');

async function readPackageVersion() {
	try {
		const raw = await fs.readFile(packageJsonPath, 'utf8');
		const parsed = JSON.parse(raw);
		const version = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
		return version || '0.0.0';
	} catch {
		return '0.0.0';
	}
}

async function readText(filePath) {
	try {
		const raw = await fs.readFile(filePath, 'utf8');
		return raw.trim();
	} catch {
		return null;
	}
}

async function readPackedRef(gitDir, refName) {
	const packedPath = path.join(gitDir, 'packed-refs');
	const packed = await readText(packedPath);
	if (!packed) return null;

	for (const line of packed.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('^')) continue;
		const [sha, ref] = trimmed.split(/\s+/);
		if (ref === refName && sha) return sha;
	}
	return null;
}

async function readHeadMetadata() {
	const gitDir = path.join(repoRoot, '.git');
	const headPath = path.join(gitDir, 'HEAD');
	const head = await readText(headPath);
	if (!head) {
		return { commitHash: null, branch: null, commitTimestamp: null, source: 'build-script' };
	}

	let refName = null;
	let branch = null;
	let commitHash = null;

	if (head.startsWith('ref:')) {
		refName = head.slice(4).trim();
		if (refName.startsWith('refs/heads/')) {
			branch = refName.slice('refs/heads/'.length);
		}
		commitHash = await readText(path.join(gitDir, refName));
		if (!commitHash) {
			commitHash = await readPackedRef(gitDir, refName);
		}
	} else {
		commitHash = head;
		branch = 'detached';
	}

	let commitTimestamp = null;
	const logPath = refName ? path.join(gitDir, 'logs', refName) : path.join(gitDir, 'logs', 'HEAD');
	const logs = await readText(logPath);
	if (logs) {
		const lines = logs.split(/\r?\n/).filter(Boolean);
		const last = lines[lines.length - 1] ?? '';
		const prefix = last.split('\t')[0] ?? '';
		const pieces = prefix.trim().split(/\s+/);
		const unixText = pieces.length >= 2 ? pieces[pieces.length - 2] : '';
		const unix = Number(unixText);
		if (Number.isFinite(unix) && unix > 0) {
			commitTimestamp = new Date(unix * 1000).toISOString();
		}
	}

	return {
		commitHash: commitHash || null,
		branch: branch || null,
		commitTimestamp,
		source: commitHash ? 'git-files' : 'build-script'
	};
}

async function main() {
	const version = await readPackageVersion();
	const gitMeta = await readHeadMetadata();
	const commitHash = gitMeta.commitHash;
	const commitShort = commitHash ? commitHash.slice(0, 12) : null;

	const payload = {
		version,
		commitHash,
		commitShort,
		branch: gitMeta.branch,
		commitTimestamp: gitMeta.commitTimestamp,
		buildTimestamp: new Date().toISOString(),
		treeState: 'unknown',
		source: gitMeta.source
	};

	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
	console.log(`[build-info] wrote ${outputPath}`);
}

main().catch((error) => {
	console.error('[build-info] failed', error?.message ?? String(error));
	process.exitCode = 1;
});
