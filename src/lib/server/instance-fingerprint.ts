const runtimeId =
	(process.env.AWS_LAMBDA_LOG_STREAM_NAME ??
		process.env.HOSTNAME ??
		process.env.AWS_EXECUTION_ENV ??
		'local-runtime')
		.toString()
		.trim() || 'local-runtime';

const nonce = Math.random().toString(36).slice(2, 8);
const instanceId = `${runtimeId}:${nonce}`;

export function getInstanceFingerprint(): string {
	return instanceId;
}
