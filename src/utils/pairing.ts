/**
 * Telegram pairing API client.
 *
 * Replaces the activation-code flow with a single deep-link tap:
 *
 *   1. App calls `POST /v1/pair/init` and receives { token, deep_link }.
 *   2. App opens `deep_link` (`https://t.me/<bot>?start=link_<token>`).
 *      The user lands in the FlowCare bot and Telegram fires
 *      `/start link_<token>` for us.
 *   3. The bot's pairing handler claims the token against the user's
 *      Telegram account.
 *   4. App polls `GET /v1/pair/<token>` until the response says
 *      `paired: true`, then mirrors the returned tariff + expires into
 *      local subscription state.
 */
import Constants from 'expo-constants';

import { SubscriptionTier } from '../types';

/**
 * Pre-built / preview deploys without a live backend opt into a
 * client-only "demo" pairing flow by setting `EXPO_PUBLIC_DEMO_ACTIVATION=1`.
 * In demo mode the app fakes a successful pair after the deep-link is
 * opened so the UX can be exercised end-to-end without a server.
 */
export const isDemoActivationEnabled = (): boolean => {
  // ``process.env.EXPO_PUBLIC_*`` is inlined at build time by Expo.
  const flag =
    typeof process !== 'undefined' && process.env
      ? process.env.EXPO_PUBLIC_DEMO_ACTIVATION
      : undefined;
  return flag === '1' || flag === 'true';
};

export interface PairInitResponse {
  token: string;
  deep_link: string;
  expires_at: string;
}

export interface PairStatusResponse {
  paired: boolean;
  expired: boolean;
  tariff?: SubscriptionTier | null;
  expires?: string | null;
  telegram_username?: string | null;
}

const FALLBACK_BASE = 'https://flowcare-api.example.com';

const baseUrl = (): string => {
  const fromEnv =
    typeof process !== 'undefined' && process.env
      ? process.env.EXPO_PUBLIC_ACTIVATION_API_URL
      : undefined;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const extra =
    (Constants?.expoConfig?.extra as Record<string, unknown> | undefined) ??
    (Constants?.manifest2?.extra as Record<string, unknown> | undefined) ??
    {};
  const fromExtra = extra['activationApiUrl'];
  if (typeof fromExtra === 'string' && fromExtra.length > 0) return fromExtra;
  return FALLBACK_BASE;
};

/**
 * Strip ``user:password@`` credentials from the URL (if present) and
 * return the bare URL alongside an ``Authorization: Basic ...`` header.
 *
 * Browsers silently drop URL-embedded credentials before issuing
 * ``fetch()``, so any preview that is gated by HTTP Basic auth
 * (e.g. Devin's port-tunnel) needs the auth promoted to a header.
 */
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

const botUsername = (): string => {
  const extra =
    (Constants?.expoConfig?.extra as Record<string, unknown> | undefined) ??
    (Constants?.manifest2?.extra as Record<string, unknown> | undefined) ??
    {};
  const fromExtra = extra['botUsername'];
  if (typeof fromExtra === 'string' && fromExtra.length > 0) {
    return fromExtra.replace(/^@/, '');
  }
  return 'lowerBsk24_bot';
};

export class PairingNotConfiguredError extends Error {
  constructor() {
    super('Pairing API URL is not configured for this build.');
    this.name = 'PairingNotConfiguredError';
  }
}

export const initPair = async (): Promise<PairInitResponse> => {
  const { url, headers: authHeaders } = splitBasicAuth(
    `${baseUrl().replace(/\/$/, '')}/v1/pair/init`,
  );
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
  });
  if (!res.ok) {
    throw new Error(`pair/init responded ${res.status}`);
  }
  const json = (await res.json()) as PairInitResponse;
  // Some setups (preview without backend) may return a placeholder; the
  // server is the source of truth, but keep the client deterministic.
  if (!json.deep_link) {
    json.deep_link = `https://t.me/${botUsername()}?start=link_${json.token}`;
  }
  return json;
};

export const fetchPairStatus = async (
  token: string,
): Promise<PairStatusResponse> => {
  const { url, headers: authHeaders } = splitBasicAuth(
    `${baseUrl().replace(/\/$/, '')}/v1/pair/${encodeURIComponent(token)}`,
  );
  const res = await fetch(url, { method: 'GET', headers: authHeaders });
  if (!res.ok) {
    return { paired: false, expired: false };
  }
  return (await res.json()) as PairStatusResponse;
};

export const isPairingApiConfigured = (): boolean =>
  !baseUrl().includes('flowcare-api.example.com');
