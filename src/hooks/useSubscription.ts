import { differenceInCalendarDays, isBefore, parseISO } from 'date-fns';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../AppContext';
import { findPeriodStarts } from '../cycle';
import { encodeCycleCode } from '../cycleCode';
import { DEFAULT_SUBSCRIPTION, Subscription, SubscriptionTier } from '../types';
import { activateCode, fetchSubscriptionByCycleCode } from '../utils/activation';

export type SubscriptionType = 'premium' | 'basic_box' | 'vip_box' | 'none';

export type AutoSyncStatus =
  | 'idle' // no cycle data yet — nothing to poll with
  | 'syncing' // poll in flight
  | 'matched' // backend returned a paid subscription
  | 'unmatched' // valid cycle code, but bot doesn't know it yet (user hasn't /sync'd or hasn't paid)
  | 'error'; // network / backend error

export interface UseSubscriptionApi {
  subscription: Subscription;
  tier: SubscriptionTier;
  /** Friendlier alias used by gates / settings: which kind of plan is active. */
  subscriptionType: SubscriptionType;
  isActive: boolean;
  isBasic: boolean;
  isVip: boolean;
  /** True when any active plan unlocks Premium features (premium / basic / vip). */
  isPremium: boolean;
  /** True when an active plan ships physical boxes (basic / vip). */
  isBoxActive: boolean;
  daysLeft: number;
  /** Cycle-sync code computed from local logs (null until a period start is known). */
  cycleSyncCode: string | null;
  /** Status of the auto-sync poll against the FlowCare backend. */
  autoSyncStatus: AutoSyncStatus;
  /** ISO timestamp of the last successful poll, or null. */
  lastAutoSyncAt: string | null;
  /** Manually re-trigger a poll. Resolves to the resulting status. */
  refreshAutoSync: () => Promise<AutoSyncStatus>;
  /**
   * Send the user-entered activation code to the FlowCare API. Kept as a
   * fallback for users whose auto-sync didn't pick up the subscription
   * (e.g. when their cycle-sync code changed and they haven't re-/sync'd
   * with the bot). On success persists tier + renewsAt locally.
   */
  activate: (code: string) => Promise<
    | { ok: true; tier: SubscriptionTier; expires: string }
    | { ok: false; reason: 'empty' | 'invalid' | 'network' }
  >;
}

const isActiveNow = (sub: Subscription, now = new Date()): boolean => {
  if (sub.tier === 'free' || !sub.renewsAt) return false;
  try {
    return !isBefore(parseISO(sub.renewsAt), now);
  } catch {
    return false;
  }
};

const computeDaysLeft = (sub: Subscription, now = new Date()): number => {
  if (!sub.renewsAt) return 0;
  try {
    const days = differenceInCalendarDays(parseISO(sub.renewsAt), now);
    return Math.max(0, days);
  } catch {
    return 0;
  }
};

const productIdFor = (tier: SubscriptionTier): string | null => {
  switch (tier) {
    case 'vip':
      return 'vip_monthly';
    case 'premium':
      return 'premium_monthly';
    case 'basic':
      return 'basic_monthly';
    default:
      return null;
  }
};

/**
 * Subscription state hook.
 *
 * Source of truth: the FlowCare backend (`./api/`) which is fed by
 * the Telegram bot (`./bot/`). The app generates a deterministic
 * cycle-sync code from local cycle data and polls
 * `GET /v1/subscription?cycle_code=...`; once the user has run
 * `/sync <code>` in the bot at least once, any subsequent paid
 * subscription is picked up automatically — no activation code to copy.
 *
 * The legacy 8-char activation code path is preserved as a manual
 * fallback via `activate(code)`.
 */
export const useSubscription = (): UseSubscriptionApi => {
  const { data, updateSubscription } = useApp();
  const sub = data.subscription;

  // Compute the cycle-sync code from local logs. Returns null until the
  // user has logged at least one period start.
  const cycleSyncCode = useMemo<string | null>(() => {
    const starts = findPeriodStarts(data.logs);
    const startDate = starts.length > 0 ? starts[starts.length - 1] : null;
    if (!startDate) return null;
    try {
      return encodeCycleCode({
        startDate,
        cycleLength: data.settings.averageCycleLength,
        periodLength: data.settings.averagePeriodLength,
      });
    } catch {
      return null;
    }
  }, [
    data.logs,
    data.settings.averageCycleLength,
    data.settings.averagePeriodLength,
  ]);

  const [autoSyncStatus, setAutoSyncStatus] = useState<AutoSyncStatus>(
    cycleSyncCode ? 'idle' : 'idle',
  );
  const [lastAutoSyncAt, setLastAutoSyncAt] = useState<string | null>(null);

  // Latest cycle code we polled with — used by the manual refresh closure
  // and by the effect to avoid duplicate polls when the code is unchanged.
  const lastPolledCodeRef = useRef<string | null>(null);

  useEffect(() => {
    if (sub.tier !== 'free' && sub.renewsAt && !isActiveNow(sub)) {
      void updateSubscription({ ...DEFAULT_SUBSCRIPTION });
    }
  }, [sub, updateSubscription]);

  const runPoll = useCallback(
    async (code: string): Promise<AutoSyncStatus> => {
      setAutoSyncStatus('syncing');
      const res = await fetchSubscriptionByCycleCode(code);
      if (!res.valid || !res.tariff || !res.expires) {
        setAutoSyncStatus('unmatched');
        setLastAutoSyncAt(new Date().toISOString());
        return 'unmatched';
      }
      const renewsAtIso = `${res.expires}T00:00:00.000Z`;
      const startedIso = res.started_at
        ? `${res.started_at}T00:00:00.000Z`
        : new Date().toISOString();
      const nowIso = new Date().toISOString();
      // Only write to storage if the resolved subscription differs from
      // what we already have — avoids spurious storage writes on every
      // poll once the subscription is stable.
      const sameTier = sub.tier === res.tariff;
      const sameRenews = sub.renewsAt === renewsAtIso;
      if (!sameTier || !sameRenews) {
        await updateSubscription({
          tier: res.tariff,
          productId: productIdFor(res.tariff),
          startedAt: startedIso,
          renewsAt: renewsAtIso,
          cancelled: false,
          lastSyncedAt: nowIso,
          activationCode: sub.activationCode ?? null,
        });
      } else {
        await updateSubscription({
          ...sub,
          lastSyncedAt: nowIso,
        });
      }
      setAutoSyncStatus('matched');
      setLastAutoSyncAt(nowIso);
      return 'matched';
    },
    [sub, updateSubscription],
  );

  // Auto-poll on mount and whenever the cycle-sync code changes.
  useEffect(() => {
    if (!cycleSyncCode) {
      setAutoSyncStatus('idle');
      lastPolledCodeRef.current = null;
      return;
    }
    if (lastPolledCodeRef.current === cycleSyncCode) return;
    lastPolledCodeRef.current = cycleSyncCode;
    runPoll(cycleSyncCode).catch(() => {
      setAutoSyncStatus('error');
    });
  }, [cycleSyncCode, runPoll]);

  const refreshAutoSync = useCallback(async (): Promise<AutoSyncStatus> => {
    if (!cycleSyncCode) {
      setAutoSyncStatus('idle');
      return 'idle';
    }
    try {
      return await runPoll(cycleSyncCode);
    } catch {
      setAutoSyncStatus('error');
      return 'error';
    }
  }, [cycleSyncCode, runPoll]);

  const activate = useCallback<UseSubscriptionApi['activate']>(
    async (code) => {
      const trimmed = code.trim();
      if (!trimmed) return { ok: false, reason: 'empty' };
      const res = await activateCode(trimmed);
      if (!res.valid || !res.tariff || !res.expires) {
        return { ok: false, reason: 'invalid' };
      }
      const renewsAtIso = `${res.expires}T00:00:00.000Z`;
      const nowIso = new Date().toISOString();
      await updateSubscription({
        tier: res.tariff,
        productId: productIdFor(res.tariff),
        startedAt: nowIso,
        renewsAt: renewsAtIso,
        cancelled: false,
        lastSyncedAt: nowIso,
        activationCode: trimmed,
      });
      return { ok: true, tier: res.tariff, expires: res.expires };
    },
    [updateSubscription],
  );

  const active = isActiveNow(sub);
  const isBasic = active && sub.tier === 'basic';
  const isVip = active && sub.tier === 'vip';
  const isBoxActive = isBasic || isVip;
  const isPremiumOnly = active && sub.tier === 'premium';
  const isPremium = isPremiumOnly || isBoxActive;
  const subscriptionType: SubscriptionType = !active
    ? 'none'
    : sub.tier === 'vip'
      ? 'vip_box'
      : sub.tier === 'basic'
        ? 'basic_box'
        : sub.tier === 'premium'
          ? 'premium'
          : 'none';

  return {
    subscription: sub,
    tier: sub.tier,
    subscriptionType,
    isActive: active,
    isBasic,
    isVip,
    isPremium,
    isBoxActive,
    daysLeft: computeDaysLeft(sub),
    cycleSyncCode,
    autoSyncStatus,
    lastAutoSyncAt,
    refreshAutoSync,
    activate,
  };
};
