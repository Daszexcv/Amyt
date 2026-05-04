import { Platform } from 'react-native';
import { addDays, parseISO, startOfDay } from 'date-fns';
import type { CyclePredictions } from './cycle';
import type { Settings } from './types';

// expo-notifications imports must be wrapped because the package is unavailable
// in pure web SSR contexts; we lazy-load it.
const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

let cachedNotif: typeof import('expo-notifications') | null = null;
const loadNotif = async (): Promise<typeof import('expo-notifications') | null> => {
  if (!isNative) return null;
  if (cachedNotif) return cachedNotif;
  try {
    cachedNotif = await import('expo-notifications');
    return cachedNotif;
  } catch {
    return null;
  }
};

const TAG = 'cycletracker.scheduled';

export interface DailyTime {
  hour: number;
  minute: number;
}

export interface NotificationPlan {
  /** One-shot reminder the day before the predicted period start. */
  prePeriodAt: Date | null;
  /** One-shot reminder on the predicted period start day. */
  periodStartAt: Date | null;
  /** One-shot reminder on the first day of the fertile window. */
  fertileStartAt: Date | null;
  /** One-shot reminder on the predicted ovulation day. */
  ovulationAt: Date | null;
  /** Daily recurring reminder for vitamins, or null when disabled / invalid time. */
  vitaminsDaily: DailyTime | null;
}

/** Parse HH:MM (24h). Returns null on garbage. */
const parseHHMM = (raw: string): DailyTime | null => {
  const m = raw?.match?.(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
};

/** Build the next future-only notification fire times based on the latest
 *  predictions. Cycle-anchored reminders fire at 09:00 local on the target day;
 *  the daily vitamin reminder uses the user-configured time. */
export const buildNotificationPlan = (
  predictions: CyclePredictions,
  settings: Settings,
  now: Date = new Date(),
): NotificationPlan => {
  const at9 = (iso: string): Date => {
    const d = startOfDay(parseISO(iso));
    d.setHours(9, 0, 0, 0);
    return d;
  };
  const future = (d: Date): Date | null => (d.getTime() > now.getTime() ? d : null);

  let prePeriodAt: Date | null = null;
  if (settings.notifyPrePeriod && predictions.nextPeriodStart) {
    prePeriodAt = future(addDays(at9(predictions.nextPeriodStart), -1));
  }

  let periodStartAt: Date | null = null;
  if (settings.notifyPeriodStart && predictions.nextPeriodStart) {
    periodStartAt = future(at9(predictions.nextPeriodStart));
  }

  let fertileStartAt: Date | null = null;
  if (settings.notifyFertile && predictions.fertileStart) {
    fertileStartAt = future(at9(predictions.fertileStart));
  }

  let ovulationAt: Date | null = null;
  if (settings.notifyOvulation && predictions.ovulation) {
    ovulationAt = future(at9(predictions.ovulation));
  }

  const vitaminsDaily =
    settings.notifyVitamins && settings.notifyVitaminsTime
      ? parseHHMM(settings.notifyVitaminsTime)
      : null;

  return { prePeriodAt, periodStartAt, fertileStartAt, ovulationAt, vitaminsDaily };
};

export const isNotificationsSupported = (): boolean => isNative;

export interface ScheduleResult {
  ok: boolean;
  reason?: 'unsupported' | 'denied' | 'error';
}

const wantsAnyReminder = (settings: Settings): boolean =>
  settings.notifyPrePeriod ||
  settings.notifyPeriodStart ||
  settings.notifyFertile ||
  settings.notifyOvulation ||
  settings.notifyVitamins;

/** Cancel any of our previous reminders and schedule the new ones based on
 *  the latest predictions. Safe to call from a useEffect on every change. */
export const rescheduleNotifications = async (
  predictions: CyclePredictions,
  settings: Settings,
  t: (key: string) => string,
): Promise<ScheduleResult> => {
  const Notif = await loadNotif();
  if (!Notif) return { ok: false, reason: 'unsupported' };

  // Always clear our previous reminders first, so disabling a toggle takes
  // effect immediately.
  try {
    const existing = await Notif.getAllScheduledNotificationsAsync();
    for (const n of existing) {
      if (n.content.data && (n.content.data as { tag?: string }).tag === TAG) {
        await Notif.cancelScheduledNotificationAsync(n.identifier);
      }
    }
  } catch {
    // ignore
  }
  if (!wantsAnyReminder(settings)) return { ok: true };

  // Ensure permission.
  const perm = await Notif.getPermissionsAsync();
  let granted = perm.granted;
  if (!granted) {
    const req = await Notif.requestPermissionsAsync();
    granted = req.granted;
  }
  if (!granted) return { ok: false, reason: 'denied' };

  const plan = buildNotificationPlan(predictions, settings);
  const scheduleOnce = async (when: Date, title: string, body: string) => {
    await Notif.scheduleNotificationAsync({
      content: { title, body, data: { tag: TAG } },
      trigger: { type: Notif.SchedulableTriggerInputTypes.DATE, date: when },
    });
  };
  const scheduleDaily = async (
    daily: DailyTime,
    title: string,
    body: string,
  ) => {
    await Notif.scheduleNotificationAsync({
      content: { title, body, data: { tag: TAG } },
      trigger: {
        type: Notif.SchedulableTriggerInputTypes.DAILY,
        hour: daily.hour,
        minute: daily.minute,
      },
    });
  };

  const appTitle = t('app.title');

  try {
    if (plan.prePeriodAt) {
      await scheduleOnce(
        plan.prePeriodAt,
        appTitle,
        t('notifications.prePeriodBody'),
      );
    }
    if (plan.periodStartAt) {
      await scheduleOnce(
        plan.periodStartAt,
        appTitle,
        t('notifications.periodStartBody'),
      );
    }
    if (plan.fertileStartAt) {
      await scheduleOnce(
        plan.fertileStartAt,
        appTitle,
        t('notifications.fertileStartBody'),
      );
    }
    if (plan.ovulationAt) {
      await scheduleOnce(
        plan.ovulationAt,
        appTitle,
        t('notifications.ovulationBody'),
      );
    }
    if (plan.vitaminsDaily) {
      await scheduleDaily(
        plan.vitaminsDaily,
        appTitle,
        t('notifications.vitaminsBody'),
      );
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
};
