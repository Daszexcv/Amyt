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
  const extra =
    (Constants?.expoConfig?.extra as Record<string, unknown> | undefined) ??
    (Constants?.manifest2?.extra as Record<string, unknown> | undefined) ??
    {};
  const fromExtra = extra['activationApiUrl'];
  if (typeof fromExtra === 'string' && fromExtra.length > 0) return fromExtra;
  return FALLBACK_BASE;
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
  const url = `${baseUrl().replace(/\/$/, '')}/v1/pair/init`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const url = `${baseUrl().replace(/\/$/, '')}/v1/pair/${encodeURIComponent(token)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    return { paired: false, expired: false };
  }
  return (await res.json()) as PairStatusResponse;
};

export const isPairingApiConfigured = (): boolean =>
  !baseUrl().includes('flowcare-api.example.com');
