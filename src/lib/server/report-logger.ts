import { env } from '$env/dynamic/private';

type LogLevel = 'quiet' | 'info' | 'debug';
type EventLevel = 'info' | 'debug' | 'warn' | 'error';

const LOG_LEVEL_RANK: Record<LogLevel, number> = {
	quiet: 0,
	info: 1,
	debug: 2
};

function coerceLevel(raw?: string): LogLevel {
	if (raw === 'quiet' || raw === 'debug') return raw;
	return 'info';
}

function shouldEmit(configLevel: LogLevel, level: EventLevel): boolean {
	if (configLevel === 'quiet') return level === 'error';
	if (level === 'debug') return LOG_LEVEL_RANK[configLevel] >= LOG_LEVEL_RANK.debug;
	return true;
}

function serializeFields(fields?: Record<string, unknown>): string {
	if (!fields) return '';
	const parts: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		if (value === null || value === undefined) continue;
		if (typeof value === 'object') continue;
		parts.push(`${key}=${String(value)}`);
	}
	return parts.join(' ');
}

export function createReportLogger(service: string) {
	const level = coerceLevel(env.REPORT_LOG_LEVEL);

	function emit(event: string, eventLevel: EventLevel, fields?: Record<string, unknown>): void {
		if (!shouldEmit(level, eventLevel)) return;
		const prefix = `REPORT_AUDIT service=${service} level=${eventLevel} event=${event}`;
		const payload = serializeFields(fields);
		const line = payload ? `${prefix} ${payload}` : prefix;

		if (eventLevel === 'warn') {
			console.warn(line);
			return;
		}
		if (eventLevel === 'error') {
			console.error(line);
			return;
		}
		console.info(line);
	}

	return {
		info: (event: string, fields?: Record<string, unknown>) => emit(event, 'info', fields),
		debug: (event: string, fields?: Record<string, unknown>) => emit(event, 'debug', fields),
		warn: (event: string, fields?: Record<string, unknown>) => emit(event, 'warn', fields),
		error: (event: string, fields?: Record<string, unknown>) => emit(event, 'error', fields)
	};
}
