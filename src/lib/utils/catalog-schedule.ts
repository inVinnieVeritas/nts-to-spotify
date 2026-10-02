export const SCHEDULE_INTERVALS = {
	daily: 86_400_000,
	weekly: 7 * 86_400_000,
	fortnightly: 14 * 86_400_000,
	monthly: 30 * 86_400_000
} as const;
export type ScheduleFrequency = keyof typeof SCHEDULE_INTERVALS;
export type ScheduleStatus =
	'waiting' | 'complete' | 'cooldown' | 'busy' | 'conflict' | 'unavailable' | 'missing-progress';
export type CatalogSchedule = {
	showAlias: string;
	enabled: boolean;
	frequency: ScheduleFrequency;
	nextRunAt: number;
	nextCheckAt: number;
	updatedAt: number;
	lastRunAt: number;
	lastStatus: ScheduleStatus;
	lastScanned: number;
	lastSearches: number;
};
export const isScheduleFrequency = (value: unknown): value is ScheduleFrequency =>
	typeof value === 'string' && Object.hasOwn(SCHEDULE_INTERVALS, value);
export const isCatalogSchedule = (value: unknown): value is CatalogSchedule => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const s = value as CatalogSchedule;
	return (
		typeof s.showAlias === 'string' &&
		/^[a-z0-9-]{1,500}$/.test(s.showAlias) &&
		typeof s.enabled === 'boolean' &&
		isScheduleFrequency(s.frequency) &&
		[
			'waiting',
			'complete',
			'cooldown',
			'busy',
			'conflict',
			'unavailable',
			'missing-progress'
		].includes(s.lastStatus) &&
		[s.nextRunAt, s.nextCheckAt, s.updatedAt, s.lastRunAt, s.lastScanned, s.lastSearches].every(
			(v) => Number.isSafeInteger(v) && v >= 0
		)
	);
};
