const CATEGORICAL_PALETTE = [
	'#e76f51',
	'#2a9d8f',
	'#457b9d',
	'#e9c46a',
	'#f4a261',
	'#8ecae6',
	'#6d597a',
	'#43aa8b',
	'#f94144',
	'#577590',
	'#7f5539',
	'#277da1',
	'#b56576',
	'#90be6d',
	'#f3722c',
	'#4d908e',
	'#bc6c25',
	'#118ab2',
	'#ef476f',
	'#073b4c',
	'#3d405b',
	'#81b29a',
	'#ff9f1c',
	'#5f0f40'
];

function hashString(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const normalized = hex.replace('#', '').trim();
	const full =
		normalized.length === 3
			? normalized
					.split('')
					.map((char) => `${char}${char}`)
					.join('')
			: normalized;
	const parsed = Number.parseInt(full, 16);
	return {
		r: (parsed >> 16) & 255,
		g: (parsed >> 8) & 255,
		b: parsed & 255
	};
}

function rgbToHex(r: number, g: number, b: number): string {
	return `#${[r, g, b]
		.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
		.join('')}`;
}

export function colorForCategory(label: string): string {
	const key = label.trim().toLowerCase() || 'unspecified';
	return CATEGORICAL_PALETTE[hashString(key) % CATEGORICAL_PALETTE.length];
}

export function colorWithAlpha(hex: string, alpha: number): string {
	const { r, g, b } = hexToRgb(hex);
	return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha))})`;
}

export function lightenColor(hex: string, amount: number): string {
	const { r, g, b } = hexToRgb(hex);
	const mix = Math.max(0, Math.min(1, amount));
	return rgbToHex(r + (255 - r) * mix, g + (255 - g) * mix, b + (255 - b) * mix);
}

export function sortEntriesByValueThenLabel(
	items: Array<{ label: string; value: number }>
): Array<{ label: string; value: number }> {
	return [...items].sort((a, b) => {
		if (b.value !== a.value) return b.value - a.value;
		return a.label.localeCompare(b.label);
	});
}
