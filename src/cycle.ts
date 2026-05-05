import { addDays, differenceInCalendarDays, format, parseISO } from 'date-fns';
import { DayLog, Settings } from './types';

export const fmt = (d: Date): string => format(d, 'yyyy-MM-dd');

const isBleeding = (log: DayLog | undefined): boolean => {
  if (!log || !log.flow) return false;
  return log.flow !== 'none';
};

/**
 * Identifies cycle starts (first day of bleeding after at least one non-bleeding
 * day or no log). Returns ISO date strings sorted ascending.
 */
export const findPeriodStarts = (logs: Record<string, DayLog>): string[] => {
  const dates = Object.keys(logs)
    .filter((d) => isBleeding(logs[d]))
    .sort();
  if (dates.length === 0) return [];

  const starts: string[] = [];
  for (const d of dates) {
    const prev = fmt(addDays(parseISO(d), -1));
    if (!isBleeding(logs[prev])) {
      starts.push(d);
    }
  }
  return starts;
};

export interface CycleStats {
  cycleLengths: number[];
  averageCycleLength: number | null;
  shortestCycle: number | null;
  longestCycle: number | null;
  periodStarts: string[];
  averagePeriodLength: number | null;
  /** True if the spread between the last 3 cycle lengths is > 7 days. */
  irregular: boolean;
  /** How many recent finished cycles were used to compute the average. */
  recentCyclesUsed: number;
}

export const computeCycleStats = (
  logs: Record<string, DayLog>,
  settings: Settings,
): CycleStats => {
  const periodStarts = findPeriodStarts(logs);
  const cycleLengths: number[] = [];
  for (let i = 1; i < periodStarts.length; i++) {
    const len = differenceInCalendarDays(
      parseISO(periodStarts[i]),
      parseISO(periodStarts[i - 1]),
    );
    if (len >= 15 && len <= 60) cycleLengths.push(len);
  }

  // Use only the **last 3–6 finished cycles** for the rolling average so the
  // prediction stays responsive to recent shifts. Fewer than 3 finished
  // cycles → fall back to the manual setting in `computePredictions`.
  const recent = cycleLengths.slice(-6);
  const avg =
    recent.length >= 3
      ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
      : null;

  // Irregular flag: spread between the last 3 cycles > 7 days.
  let irregular = false;
  if (recent.length >= 3) {
    const last3 = recent.slice(-3);
    const spread = Math.max(...last3) - Math.min(...last3);
    irregular = spread > 7;
  }

  // Compute average period length by counting consecutive bleeding days
  // starting from each detected period start.
  const periodLengths: number[] = [];
  for (const start of periodStarts) {
    let len = 0;
    let cursor = parseISO(start);
    while (isBleeding(logs[fmt(cursor)])) {
      len++;
      cursor = addDays(cursor, 1);
      if (len > 14) break; // safety
    }
    if (len > 0) periodLengths.push(len);
  }
  const avgPeriod =
    periodLengths.length > 0
      ? Math.round(periodLengths.reduce((a, b) => a + b, 0) / periodLengths.length)
      : null;

  return {
    cycleLengths,
    averageCycleLength: avg,
    shortestCycle: cycleLengths.length ? Math.min(...cycleLengths) : null,
    longestCycle: cycleLengths.length ? Math.max(...cycleLengths) : null,
    periodStarts,
    averagePeriodLength: avgPeriod,
    irregular,
    recentCyclesUsed: recent.length,
  };
};

export interface CyclePredictions {
  lastPeriodStart: string | null;
  nextPeriodStart: string | null;
  nextPeriodEnd: string | null;
  ovulation: string | null;
  fertileStart: string | null;
  fertileEnd: string | null;
  cycleDay: number | null; // 1-based day of current cycle
  daysUntilNextPeriod: number | null;
  effectiveCycleLength: number;
  effectivePeriodLength: number;
  /** True when the last 3 finished cycles spread > 7 days. */
  irregular: boolean;
  /** Did the average come from logs (>=3 cycles) or from settings fallback? */
  averageSource: 'logs' | 'settings';
}

export interface CycleForecastEntry {
  /** ISO date — first day of bleeding for this projected cycle. */
  cycle_start: string;
  /** Last day of bleeding for this projected cycle. */
  period_end: string;
  /** Predicted ovulation date (cycle_start + cycleLen - lutealPhase). */
  ovulation: string;
  /** Start of the 6-day fertile window (ovulation - 5d). */
  fertile_start: string;
  /** End of the fertile window (ovulation + 1d). */
  fertile_end: string;
}

/**
 * Project the next ``count`` cycles forward from the latest known
 * period start. Used by the Telegram-pairing flow to ship a privacy-
 * minimal forecast (just bleeding / ovulation / fertile dates) to the
 * bot so it can schedule box deliveries without the user typing a code.
 */
export const forecastUpcomingCycles = (
  logs: Record<string, DayLog>,
  settings: Settings,
  today: Date = new Date(),
  count = 3,
): CycleForecastEntry[] => {
  const stats = computeCycleStats(logs, settings);
  const cycleLen = stats.averageCycleLength ?? settings.averageCycleLength;
  const periodLen = stats.averagePeriodLength ?? settings.averagePeriodLength;
  const lastStart = stats.periodStarts.length
    ? stats.periodStarts[stats.periodStarts.length - 1]
    : null;
  if (!lastStart) return [];

  let cursor = addDays(parseISO(lastStart), cycleLen);
  while (differenceInCalendarDays(cursor, today) < 0) {
    cursor = addDays(cursor, cycleLen);
  }

  const out: CycleForecastEntry[] = [];
  for (let i = 0; i < count; i++) {
    const cycleStart = cursor;
    const periodEnd = addDays(cycleStart, Math.max(0, periodLen - 1));
    const ovulation = addDays(cycleStart, cycleLen - settings.lutealPhaseLength);
    const fertileStart = addDays(ovulation, -5);
    const fertileEnd = addDays(ovulation, 1);
    out.push({
      cycle_start: fmt(cycleStart),
      period_end: fmt(periodEnd),
      ovulation: fmt(ovulation),
      fertile_start: fmt(fertileStart),
      fertile_end: fmt(fertileEnd),
    });
    cursor = addDays(cursor, cycleLen);
  }
  return out;
};

export const computePredictions = (
  logs: Record<string, DayLog>,
  settings: Settings,
  today: Date = new Date(),
): CyclePredictions => {
  const stats = computeCycleStats(logs, settings);
  const cycleLen = stats.averageCycleLength ?? settings.averageCycleLength;
  const periodLen = stats.averagePeriodLength ?? settings.averagePeriodLength;
  const averageSource: 'logs' | 'settings' =
    stats.averageCycleLength !== null ? 'logs' : 'settings';

  const lastStart = stats.periodStarts.length
    ? stats.periodStarts[stats.periodStarts.length - 1]
    : null;

  if (!lastStart) {
    return {
      lastPeriodStart: null,
      nextPeriodStart: null,
      nextPeriodEnd: null,
      ovulation: null,
      fertileStart: null,
      fertileEnd: null,
      cycleDay: null,
      daysUntilNextPeriod: null,
      effectiveCycleLength: cycleLen,
      effectivePeriodLength: periodLen,
      irregular: stats.irregular,
      averageSource,
    };
  }

  // Roll the predicted next-period start forward until it's in the future
  // relative to today, so predictions stay meaningful even if the user hasn't
  // logged the latest period yet.
  let nextStart = addDays(parseISO(lastStart), cycleLen);
  while (differenceInCalendarDays(nextStart, today) < 0) {
    nextStart = addDays(nextStart, cycleLen);
  }
  const nextEnd = addDays(nextStart, Math.max(0, periodLen - 1));
  const ovulation = addDays(nextStart, -settings.lutealPhaseLength);
  const fertileStart = addDays(ovulation, -5);
  const fertileEnd = addDays(ovulation, 1);

  const cycleDay = differenceInCalendarDays(today, parseISO(lastStart)) + 1;
  const daysUntil = differenceInCalendarDays(nextStart, today);

  return {
    lastPeriodStart: lastStart,
    nextPeriodStart: fmt(nextStart),
    nextPeriodEnd: fmt(nextEnd),
    ovulation: fmt(ovulation),
    fertileStart: fmt(fertileStart),
    fertileEnd: fmt(fertileEnd),
    cycleDay: cycleDay > 0 ? cycleDay : null,
    daysUntilNextPeriod: daysUntil,
    effectiveCycleLength: cycleLen,
    effectivePeriodLength: periodLen,
    irregular: stats.irregular,
    averageSource,
  };
};

export type DayMarker =
  | 'period'
  | 'predictedPeriod'
  | 'ovulation'
  | 'fertile'
  | 'logged'
  | 'today';

export const buildDayMarkers = (
  logs: Record<string, DayLog>,
  predictions: CyclePredictions,
  settings: Settings,
  today: Date = new Date(),
): Record<string, DayMarker[]> => {
  const markers: Record<string, DayMarker[]> = {};
  const add = (date: string, m: DayMarker) => {
    if (!markers[date]) markers[date] = [];
    if (!markers[date].includes(m)) markers[date].push(m);
  };

  for (const [date, log] of Object.entries(logs)) {
    if (isBleeding(log)) add(date, 'period');
    else if (
      log.symptoms?.length ||
      log.moods?.length ||
      log.temperature !== undefined ||
      log.notes ||
      log.intimacy
    ) {
      add(date, 'logged');
    }
  }

  // Project the cycle forward for ~12 months so users can see future
  // predicted periods, ovulations, and fertile windows on the calendar
  // far ahead — useful for planning travel, conception, etc.
  if (predictions.nextPeriodStart) {
    const cycleLen = predictions.effectiveCycleLength;
    const periodLen = predictions.effectivePeriodLength;
    const luteal = settings.lutealPhaseLength;
    const horizonDays = 365;
    let startCursor = parseISO(predictions.nextPeriodStart);
    while (differenceInCalendarDays(startCursor, today) <= horizonDays) {
      // Predicted bleeding days
      for (let i = 0; i < periodLen; i++) {
        const d = fmt(addDays(startCursor, i));
        if (!isBleeding(logs[d])) add(d, 'predictedPeriod');
      }
      // Ovulation + fertile window for this projected cycle
      if (settings.showFertileWindow) {
        const ovDate = addDays(startCursor, -luteal);
        const fertileStart = addDays(ovDate, -5);
        const fertileEnd = addDays(ovDate, 1);
        let fc = fertileStart;
        while (differenceInCalendarDays(fc, fertileEnd) <= 0) {
          add(fmt(fc), 'fertile');
          fc = addDays(fc, 1);
        }
        add(fmt(ovDate), 'ovulation');
      }
      startCursor = addDays(startCursor, cycleLen);
    }
  }

  add(fmt(today), 'today');
  return markers;
};

const isBleedingExport = isBleeding;
export { isBleedingExport as isBleeding };

export type CyclePhase =
  | 'period'
  | 'follicular'
  | 'fertile'
  | 'ovulation'
  | 'luteal'
  | 'unknown';

export interface PhaseSegment {
  phase: CyclePhase;
  /** 1-based day-of-cycle (inclusive). */
  startDay: number;
  /** 1-based day-of-cycle (inclusive). */
  endDay: number;
}

export const buildPhaseSegments = (
  cycleLen: number,
  periodLen: number,
  lutealPhaseLength: number,
): PhaseSegment[] => {
  const safeCycle = Math.max(15, cycleLen);
  const safePeriod = Math.max(1, Math.min(periodLen, safeCycle - 4));
  const safeLuteal = Math.max(9, Math.min(lutealPhaseLength, safeCycle - safePeriod - 2));

  const ovulationDay = safeCycle - safeLuteal;
  const fertileStartDay = Math.max(safePeriod + 1, ovulationDay - 5);
  const fertileEndDay = Math.min(safeCycle, ovulationDay + 1);

  const segments: PhaseSegment[] = [];
  segments.push({ phase: 'period', startDay: 1, endDay: safePeriod });
  if (fertileStartDay > safePeriod + 1) {
    segments.push({
      phase: 'follicular',
      startDay: safePeriod + 1,
      endDay: fertileStartDay - 1,
    });
  }
  if (ovulationDay > fertileStartDay) {
    segments.push({
      phase: 'fertile',
      startDay: fertileStartDay,
      endDay: ovulationDay - 1,
    });
  }
  segments.push({ phase: 'ovulation', startDay: ovulationDay, endDay: ovulationDay });
  if (fertileEndDay > ovulationDay) {
    segments.push({
      phase: 'fertile',
      startDay: ovulationDay + 1,
      endDay: fertileEndDay,
    });
  }
  if (safeCycle > fertileEndDay) {
    segments.push({
      phase: 'luteal',
      startDay: fertileEndDay + 1,
      endDay: safeCycle,
    });
  }
  return segments;
};

export const phaseForCycleDay = (
  cycleDay: number,
  segments: PhaseSegment[],
): CyclePhase => {
  for (const s of segments) {
    if (cycleDay >= s.startDay && cycleDay <= s.endDay) return s.phase;
  }
  return 'unknown';
};

export interface FertileWindowInfo {
  total: number;
  remaining: number;
  isInside: boolean;
}

export const fertileWindowInfo = (
  cycleDay: number | null,
  segments: PhaseSegment[],
): FertileWindowInfo => {
  let start: number | null = null;
  let end: number | null = null;
  for (const s of segments) {
    if (s.phase === 'fertile' || s.phase === 'ovulation') {
      if (start === null || s.startDay < start) start = s.startDay;
      if (end === null || s.endDay > end) end = s.endDay;
    }
  }
  if (start === null || end === null) {
    return { total: 0, remaining: 0, isInside: false };
  }
  const total = end - start + 1;
  if (cycleDay === null) return { total, remaining: total, isInside: false };
  if (cycleDay < start) return { total, remaining: total, isInside: false };
  if (cycleDay > end) return { total, remaining: 0, isInside: false };
  return { total, remaining: end - cycleDay + 1, isInside: true };
};

export interface CycleHistoryEntry {
  /** ISO date of the first bleeding day. */
  start: string;
  /** ISO date of the last day of the cycle (start of next cycle - 1), or null
   *  for the still-running cycle. */
  end: string | null;
  /** Cycle length in days, or null if it's the current cycle. */
  cycleLength: number | null;
  /** Period length in days (consecutive bleeding days from start). */
  periodLength: number;
  /** All logs that fall inside this cycle, sorted by date. */
  logs: DayLog[];
}

export const computeCycleHistory = (
  logs: Record<string, DayLog>,
): CycleHistoryEntry[] => {
  const starts = findPeriodStarts(logs);
  if (starts.length === 0) return [];
  const entries: CycleHistoryEntry[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const nextStart = i < starts.length - 1 ? starts[i + 1] : null;
    const end =
      nextStart !== null ? fmt(addDays(parseISO(nextStart), -1)) : null;
    const cycleLength =
      nextStart !== null
        ? differenceInCalendarDays(parseISO(nextStart), parseISO(start))
        : null;

    let periodLength = 0;
    let cursor = parseISO(start);
    while (isBleeding(logs[fmt(cursor)])) {
      periodLength++;
      cursor = addDays(cursor, 1);
      if (periodLength > 14) break;
    }

    const cycleLogs: DayLog[] = [];
    const cycleEndIso = end ?? fmt(new Date());
    for (const [date, log] of Object.entries(logs)) {
      if (date >= start && date <= cycleEndIso) cycleLogs.push(log);
    }
    cycleLogs.sort((a, b) => a.date.localeCompare(b.date));

    entries.push({ start, end, cycleLength, periodLength, logs: cycleLogs });
  }
  return entries;
};

export interface SymptomCount {
  key: string;
  count: number;
}

export const countSymptoms = (
  logs: Record<string, DayLog>,
): SymptomCount[] => {
  const counts: Record<string, number> = {};
  for (const log of Object.values(logs)) {
    for (const s of log.symptoms ?? []) counts[s] = (counts[s] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
};
