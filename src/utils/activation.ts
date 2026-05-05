/**
 * Activation API client.
 *
 * The Telegram bot at ./bot/ issues activation codes after a paid
 * subscription. The Lira app POSTs the user-entered code here and gets
 * back the canonical tariff + expiry, which it then writes into the
 * local subscription state.
 */
import Constants from 'expo-constants';

import { SubscriptionTier } from '../types';

export interface ActivateResponse {
  valid: boolean;
  tariff?: SubscriptionTier;
  expires?: string;
  redeemed_at?: string;
}

export interface SubscriptionLookupResponse {
  valid: boolean;
  tariff?: SubscriptionTier;
  expires?: string;
  started_at?: string;
}

const fallbackBase = 'https://flowcare-api.example.com';

const baseUrl = (): string => {
  const fromEnv =
    typeof process !== 'undefined' && process.env
      ? process.env.EXPO_PUBLIC_ACTIVATION_API_URL
      : undefined;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
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

const splitBasicAuth = (rawUrl: string): { url: string; headers: Record<string, string> } => {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) {
      const credentials =
        typeof btoa === 'function'
          ? btoa(`${parsed.username}:${parsed.password}`)
          : Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');
      parsed.username = '';
      parsed.password = '';
      return {
        url: parsed.toString(),
        headers: { Authorization: `Basic ${credentials}` },
      };
    }
  } catch {
    // Fall through and return the URL as-is.
  }
  return { url: rawUrl, headers: {} };
};

export const activateCode = async (
  code: string,
  deviceId?: string,
): Promise<ActivateResponse> => {
  const { url, headers: authHeaders } = splitBasicAuth(
    `${baseUrl().replace(/\/$/, '')}/v1/activate`,
  );
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ code: code.trim().toUpperCase(), device_id: deviceId ?? null }),
    });
    if (!res.ok) {
      return { valid: false };
    }
    const json = (await res.json()) as ActivateResponse;
    return json;
  } catch {
    return { valid: false };
  }
};

/**
 * Auto-sync: ask the bot whether the cycle-sync code in our hands is
 * already bound to a paid subscription. The user runs `/sync XXXX-XXXX`
 * in the FlowCare bot once; after that the same code unlocks the
 * subscription on every device automatically.
 */
export const fetchSubscriptionByCycleCode = async (
  cycleCode: string,
): Promise<SubscriptionLookupResponse> => {
  const { url, headers: authHeaders } = splitBasicAuth(
    `${baseUrl().replace(/\/$/, '')}/v1/subscription?cycle_code=${encodeURIComponent(cycleCode.trim().toUpperCase())}`,
  );
  try {
    const res = await fetch(url, { method: 'GET', headers: authHeaders });
    if (!res.ok) {
      return { valid: false };
    }
    const json = (await res.json()) as SubscriptionLookupResponse;
    return json;
  } catch {
    return { valid: false };
  }
};

export const isLikelyCode = (input: string): boolean => /^[A-Z0-9]{6,12}$/i.test(input.trim());
