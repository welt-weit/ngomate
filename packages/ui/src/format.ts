export function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
	if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
	return `${Math.round(bytes / 1024)} KB`
}

/** The most capable model this computer has the memory and the disk for. Catalog order breaks a tie. */
export function recommendedModelId(
	models: { id: string; minRamGb: number; sizeBytes: number; installed?: boolean }[],
	ramGb: number,
	freeDiskBytes = Number.POSITIVE_INFINITY,
): string | null {
	const fits = models.filter(
		(model) => model.minRamGb <= ramGb && (model.installed || model.sizeBytes < freeDiskBytes),
	)
	const best = Math.max(...fits.map((model) => model.minRamGb))
	return fits.find((model) => model.minRamGb === best)?.id ?? null
}

export function makeId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
