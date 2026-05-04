/**
 * Activation API client.
 *
 * The Telegram bot at ./bot/ issues activation codes after a paid
 * subscription. The Lira app POSTs the user-entered code here and gets
 * back the canonical tariff + expiry, which it then writes into the
 * local subscription state.
 *
 * Demo mode: when `EXPO_PUBLIC_DEMO_ACTIVATION === '1'` is set at build
 * time, the client will additionally accept three deterministic test
 * codes (LIRADEMO / LIRABASIC / LIRAVIP) that grant 30 days of the
 * matching tier without contacting the backend. This is meant for
 * preview/staging builds where the FlowCare API is not deployed; it is
 * gated by an explicit env flag so production bundles do not ship the
 * shortcut.
 */
import Constants from 'expo-constants';

import { SubscriptionTier } from '../types';

export interface ActivateResponse {
  valid: boolean;
  tariff?: SubscriptionTier;
  expires?: string;
  redeemed_at?: string;
}

const PLACEHOLDER_HOST = 'flowcare-api.example.com';
const fallbackBase = `https://${PLACEHOLDER_HOST}`;

const baseUrl = (): string => {
  const fromExtra =
    (Constants?.expoConfig?.extra as Record<string, unknown> | undefined)?.[
      'activationApiUrl'
    ] ??
    (Constants?.manifest2?.extra as Record<string, unknown> | undefined)?.[
      'activationApiUrl'
    ];
  if (typeof fromExtra === 'string' && fromExtra.length > 0) return fromExtra;
  return fallbackBase;
};

const isPlaceholderApi = (url: string): boolean => url.includes(PLACEHOLDER_HOST);

export const isDemoModeEnabled = (): boolean =>
  process.env.EXPO_PUBLIC_DEMO_ACTIVATION === '1';

/** Demo codes accepted only when EXPO_PUBLIC_DEMO_ACTIVATION === '1'. */
const DEMO_CODES: Record<string, SubscriptionTier> = {
  LIRADEMO: 'premium',
  LIRABASIC: 'basic',
  LIRAVIP: 'vip',
};

const demoActivate = (code: string): ActivateResponse | null => {
  const tariff = DEMO_CODES[code];
  if (!tariff) return null;
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);
  const nowIso = new Date().toISOString();
  return {
    valid: true,
    tariff,
    expires: expires.toISOString().slice(0, 10),
    redeemed_at: nowIso,
  };
};

export const activateCode = async (
  code: string,
  deviceId?: string,
): Promise<ActivateResponse> => {
  const trimmed = code.trim().toUpperCase();
  const url = `${baseUrl().replace(/\/$/, '')}/v1/activate`;
  const usingPlaceholder = isPlaceholderApi(url);
  const demoEnabled = isDemoModeEnabled();

  // When demo mode is on AND the configured API is the unreachable
  // placeholder (e.g. preview builds), short-circuit to demo codes
  // without making a doomed network call.
  if (demoEnabled && usingPlaceholder) {
    const demo = demoActivate(trimmed);
    if (demo) return demo;
    return { valid: false };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: trimmed, device_id: deviceId ?? null }),
    });
    if (!res.ok) {
      if (demoEnabled) {
        const demo = demoActivate(trimmed);
        if (demo) return demo;
      }
      return { valid: false };
    }
    const json = (await res.json()) as ActivateResponse;
    if (!json.valid && demoEnabled) {
      const demo = demoActivate(trimmed);
      if (demo) return demo;
    }
    return json;
  } catch {
    if (demoEnabled) {
      const demo = demoActivate(trimmed);
      if (demo) return demo;
    }
    return { valid: false };
  }
};

export const isLikelyCode = (input: string): boolean => /^[A-Z0-9]{6,12}$/i.test(input.trim());
