declare module 'node:fs' {
	const fs: {
		existsSync(path: string): boolean;
		readFileSync(path: string, encoding: string): string;
	};
	export default fs;
}

declare module 'node:fs/promises' {
	const fsPromises: any;
	export default fsPromises;
}

declare module 'node:path' {
	const path: any;
	export default path;
}

declare module 'crypto' {
	export function randomUUID(): string;
	export function createHash(algorithm: string): {
		update(input: string): { digest(encoding: 'hex'): string };
		digest(encoding: 'hex'): string;
	};
}

declare const process: {
	env: Record<string, string | undefined>;
};
