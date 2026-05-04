import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';
import {
  AppData,
  BoxOrder,
  BoxProfile,
  DEFAULT_BOX_PROFILE,
  DEFAULT_PROFILE,
  DEFAULT_SETTINGS,
  DEFAULT_SUBSCRIPTION,
  DayLog,
  EMPTY_ADDRESS,
  Profile,
  Settings,
  ShippingAddress,
  Subscription,
} from './types';
import { loadData, saveData, clearData as clearStorage } from './storage';
import { setLocale, t as translate } from './i18n';
import { ThemeColors, resolveColors } from './theme';
import { computePredictions, CyclePredictions } from './cycle';
import { rescheduleNotifications } from './notifications';

interface AppContextValue {
  ready: boolean;
  data: AppData;
  predictions: CyclePredictions;
  colors: ThemeColors;
  // mutations
  upsertLog: (log: DayLog) => Promise<void>;
  upsertLogs: (logs: DayLog[]) => Promise<void>;
  removeLog: (date: string) => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  updateProfile: (patch: Partial<Profile>) => Promise<void>;
  setOnboardingDone: (done: boolean) => Promise<void>;
  updateSubscription: (patch: Partial<Subscription>) => Promise<void>;
  updateShippingAddress: (patch: Partial<ShippingAddress>) => Promise<void>;
  updateBoxProfile: (patch: Partial<BoxProfile>) => Promise<void>;
  upsertOrder: (order: BoxOrder) => Promise<void>;
  replaceOrders: (orders: BoxOrder[]) => Promise<void>;
  replaceData: (next: AppData) => Promise<void>;
  resetAll: () => Promise<void>;
  // i18n helpers tied to language so consumers re-render on change
  t: (key: string, opts?: Record<string, unknown>) => string;
  language: Settings['language'];
}

const AppContext = createContext<AppContextValue | null>(null);

const isLogEmpty = (log: DayLog): boolean => {
  if (log.flow && log.flow !== 'none') return false;
  if (log.symptoms && log.symptoms.length > 0) return false;
  if (log.moods && log.moods.length > 0) return false;
  if (log.temperature !== undefined && !Number.isNaN(log.temperature)) return false;
  if (log.notes && log.notes.trim().length > 0) return false;
  if (log.intimacy) return false;
  return true;
};

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const system = useColorScheme();
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<AppData>({
    logs: {},
    settings: { ...DEFAULT_SETTINGS },
    profile: { ...DEFAULT_PROFILE },
    onboardingDone: false,
    subscription: { ...DEFAULT_SUBSCRIPTION },
    shippingAddress: { ...EMPTY_ADDRESS },
    boxProfile: { ...DEFAULT_BOX_PROFILE },
    orders: [],
  });

  useEffect(() => {
    let mounted = true;
    loadData().then((loaded) => {
      if (!mounted) return;
      setLocale(loaded.settings.language);
      dataRef.current = loaded;
      setData(loaded);
      setReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Keep i18n in sync synchronously during render so the same render that
  // bumps `language` already produces translated strings.
  setLocale(data.settings.language);

  // Latest-data ref so callbacks always read the freshest snapshot. Without
  // this, awaiting two mutator calls back-to-back (e.g. updateSettings then
  // upsertLogs in onboarding finalize) clobbers each other because each
  // closure captured `data` from the render before the first call resolved.
  const dataRef = useRef<AppData>(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const persist = useCallback(async (next: AppData) => {
    dataRef.current = next;
    setData(next);
    await saveData(next);
  }, []);

  const upsertLog = useCallback(
    async (log: DayLog) => {
      const current = dataRef.current;
      const next: AppData = { ...current, logs: { ...current.logs } };
      if (isLogEmpty(log)) {
        delete next.logs[log.date];
      } else {
        next.logs[log.date] = log;
      }
      await persist(next);
    },
    [persist],
  );

  // Apply many log changes at once.
  const upsertLogs = useCallback(
    async (logs: DayLog[]) => {
      const current = dataRef.current;
      const next: AppData = { ...current, logs: { ...current.logs } };
      for (const log of logs) {
        if (isLogEmpty(log)) {
          delete next.logs[log.date];
        } else {
          next.logs[log.date] = log;
        }
      }
      await persist(next);
    },
    [persist],
  );

  const removeLog = useCallback(
    async (date: string) => {
      const current = dataRef.current;
      const next: AppData = { ...current, logs: { ...current.logs } };
      delete next.logs[date];
      await persist(next);
    },
    [persist],
  );

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const current = dataRef.current;
      const next: AppData = {
        ...current,
        settings: { ...current.settings, ...patch },
      };
      await persist(next);
    },
    [persist],
  );

  const updateProfile = useCallback(
    async (patch: Partial<Profile>) => {
      const current = dataRef.current;
      const next: AppData = {
        ...current,
        profile: { ...current.profile, ...patch },
      };
      await persist(next);
    },
    [persist],
  );

  const setOnboardingDone = useCallback(
    async (done: boolean) => {
      const current = dataRef.current;
      const next: AppData = { ...current, onboardingDone: done };
      await persist(next);
    },
    [persist],
  );

  const updateSubscription = useCallback(
    async (patch: Partial<Subscription>) => {
      const current = dataRef.current;
      const next: AppData = {
        ...current,
        subscription: { ...current.subscription, ...patch },
      };
      await persist(next);
    },
    [persist],
  );

  const updateShippingAddress = useCallback(
    async (patch: Partial<ShippingAddress>) => {
      const current = dataRef.current;
      const next: AppData = {
        ...current,
        shippingAddress: { ...current.shippingAddress, ...patch },
      };
      await persist(next);
    },
    [persist],
  );

  const updateBoxProfile = useCallback(
    async (patch: Partial<BoxProfile>) => {
      const current = dataRef.current;
      const next: AppData = {
        ...current,
        boxProfile: { ...current.boxProfile, ...patch },
      };
      await persist(next);
    },
    [persist],
  );

  const upsertOrder = useCallback(
    async (order: BoxOrder) => {
      const current = dataRef.current;
      const idx = current.orders.findIndex((o) => o.id === order.id);
      const orders =
        idx >= 0
          ? current.orders.map((o, i) => (i === idx ? order : o))
          : [...current.orders, order];
      const next: AppData = { ...current, orders };
      await persist(next);
    },
    [persist],
  );

  const replaceOrders = useCallback(
    async (orders: BoxOrder[]) => {
      const current = dataRef.current;
      const next: AppData = { ...current, orders };
      await persist(next);
    },
    [persist],
  );

  const replaceData = useCallback(
    async (next: AppData) => {
      await persist(next);
    },
    [persist],
  );

  const resetAll = useCallback(async () => {
    await clearStorage();
    const fresh: AppData = {
      logs: {},
      settings: { ...DEFAULT_SETTINGS },
      profile: { ...DEFAULT_PROFILE },
      onboardingDone: false,
      subscription: { ...DEFAULT_SUBSCRIPTION },
      shippingAddress: { ...EMPTY_ADDRESS },
      boxProfile: { ...DEFAULT_BOX_PROFILE },
      orders: [],
    };
    dataRef.current = fresh;
    setData(fresh);
  }, []);

  const predictions = useMemo(
    () => computePredictions(data.logs, data.settings),
    [data.logs, data.settings],
  );

  const colors = useMemo(
    () => resolveColors(data.settings.theme, system),
    [data.settings.theme, system],
  );

  const language = data.settings.language;
  const t = useCallback(
    (key: string, opts?: Record<string, unknown>) => {
      void language;
      return translate(key, opts);
    },
    [language],
  );

  // Keep scheduled local notifications in sync with predictions / settings.
  useEffect(() => {
    if (!ready) return;
    void rescheduleNotifications(predictions, data.settings, translate);
  }, [
    ready,
    predictions,
    data.settings.notifyPrePeriod,
    data.settings.notifyPeriodStart,
    data.settings.notifyFertile,
    data.settings.notifyOvulation,
    data.settings.notifyVitamins,
    data.settings.notifyVitaminsTime,
    data.settings,
  ]);

  // Subscription is now activated locally via Telegram-bot-issued codes
  // (see src/utils/activation.ts); shipping/orders are tracked by the bot,
  // so the app no longer reconciles BoxOrders here. Auto-expiry on cold
  // start is handled in storage.ts:normalize().

  const value = useMemo<AppContextValue>(
    () => ({
      ready,
      data,
      predictions,
      colors,
      upsertLog,
      upsertLogs,
      removeLog,
      updateSettings,
      updateProfile,
      setOnboardingDone,
      updateSubscription,
      updateShippingAddress,
      updateBoxProfile,
      upsertOrder,
      replaceOrders,
      replaceData,
      resetAll,
      t,
      language,
    }),
    [
      ready,
      data,
      predictions,
      colors,
      upsertLog,
      upsertLogs,
      removeLog,
      updateSettings,
      updateProfile,
      setOnboardingDone,
      updateSubscription,
      updateShippingAddress,
      updateBoxProfile,
      upsertOrder,
      replaceOrders,
      replaceData,
      resetAll,
      t,
      language,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export const useApp = (): AppContextValue => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
};
