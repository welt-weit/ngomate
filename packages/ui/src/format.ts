export function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
	if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
	return `${Math.round(bytes / 1024)} KB`
}

/** Which models this computer can run, smallest first, so the first one offered is a safe choice. */
export function recommendedModelId(
	models: { id: string; minRamGb: number; sizeBytes: number }[],
	ramGb: number,
): string | null {
	const fitting = models
		.filter((model) => model.minRamGb <= ramGb)
		.sort((a, b) => a.sizeBytes - b.sizeBytes)
	return fitting[0]?.id ?? null
}

export function makeId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
