export type FlowLevel = 'none' | 'spotting' | 'light' | 'medium' | 'heavy';

export type SymptomKey =
  | 'cramps'
  | 'headache'
  | 'backache'
  | 'bloating'
  | 'breastTenderness'
  | 'acne'
  | 'fatigue'
  | 'nausea'
  | 'cravings'
  | 'insomnia';

export type MoodKey =
  | 'happy'
  | 'calm'
  | 'sad'
  | 'anxious'
  | 'irritable'
  | 'energetic'
  | 'tired'
  | 'sensitive';

export interface DayLog {
  date: string; // YYYY-MM-DD
  flow?: FlowLevel;
  symptoms?: SymptomKey[];
  moods?: MoodKey[];
  temperature?: number; // basal body temperature in °C
  notes?: string;
  intimacy?: boolean;
}

export interface Settings {
  averageCycleLength: number; // days
  averagePeriodLength: number; // days
  lutealPhaseLength: number; // days, used for ovulation prediction
  language: 'auto' | 'en' | 'ru';
  theme: 'auto' | 'light' | 'dark';
  showFertileWindow: boolean;
  /** Reminder the day before the predicted period start. */
  notifyPrePeriod: boolean;
  /** Reminder on the predicted period start day itself. */
  notifyPeriodStart: boolean;
  /** Reminder on the first day of the fertile window. */
  notifyFertile: boolean;
  /** Reminder on the predicted ovulation day. */
  notifyOvulation: boolean;
  /** Daily reminder for taking vitamins / supplements. */
  notifyVitamins: boolean;
  /** Time-of-day for the daily vitamin reminder, formatted as HH:MM (24h). */
  notifyVitaminsTime: string;
}

export const DEFAULT_SETTINGS: Settings = {
  averageCycleLength: 28,
  averagePeriodLength: 5,
  lutealPhaseLength: 14,
  language: 'auto',
  theme: 'light',
  showFertileWindow: true,
  notifyPrePeriod: false,
  notifyPeriodStart: false,
  notifyFertile: false,
  notifyOvulation: false,
  notifyVitamins: false,
  notifyVitaminsTime: '09:00',
};

export interface Profile {
  name: string;
  birthdate: string | null; // YYYY-MM-DD
  pinHash: string | null;
}

export const DEFAULT_PROFILE: Profile = {
  name: '',
  birthdate: null,
  pinHash: null,
};

export type SubscriptionTier = 'free' | 'premium' | 'basic' | 'vip';

export interface Subscription {
  tier: SubscriptionTier;
  productId: string | null;
  /** ISO date when the current period started. */
  startedAt: string | null;
  /** ISO date for the next billing/renewal cycle (= expiration when activated by code). */
  renewsAt: string | null;
  /** True after user explicitly cancelled — keeps tier active until renewsAt. */
  cancelled: boolean;
  /** Last time the status was synced with the store. */
  lastSyncedAt: string | null;
  /** Activation code redeemed (when subscription is activated via Telegram bot). */
  activationCode: string | null;
}

export const DEFAULT_SUBSCRIPTION: Subscription = {
  tier: 'free',
  productId: null,
  startedAt: null,
  renewsAt: null,
  cancelled: false,
  lastSyncedAt: null,
  activationCode: null,
};

export interface ShippingAddress {
  country: string;
  city: string;
  street: string;
  building: string;
  apartment: string;
  postalCode: string;
  phone: string;
}

export const EMPTY_ADDRESS: ShippingAddress = {
  country: '',
  city: '',
  street: '',
  building: '',
  apartment: '',
  postalCode: '',
  phone: '',
};

export type HygieneType =
  | 'pads_regular'
  | 'pads_organic'
  | 'tampons'
  | 'cup'
  | 'period_underwear'
  | 'none';

export type AllergyKey =
  | 'chocolate'
  | 'nuts'
  | 'gluten'
  | 'lactose'
  | 'essential_oils'
  | 'fragrance'
  | 'latex';

export type DietKey =
  | 'regular'
  | 'healthy'
  | 'vegetarian'
  | 'vegan'
  | 'sugar_free';

export type GoalKey = 'weight_loss' | 'weight_gain' | 'self_care';

export type FlavorKey = 'chocolate' | 'fruits' | 'citrus' | 'mint';

export type CareItem =
  | 'face_masks'
  | 'eye_patches'
  | 'candles'
  | 'tea'
  | 'cream'
  | 'balm'
  | 'scrub';

export interface BoxProfile {
  hygieneTypes: HygieneType[];
  flowIntensity: 'light' | 'medium' | 'heavy' | null;
  allergies: AllergyKey[];
  sensitiveSkin: boolean;
  allergyNotes: string;
  diet: DietKey | null;
  goal: GoalKey | null;
  favoriteFlavors: FlavorKey[];
  careItems: CareItem[];
  surpriseGift: boolean;
  brandPreferences: string;
  wantsSamples: boolean;
  notes: string;
  configured: boolean;
}

export const DEFAULT_BOX_PROFILE: BoxProfile = {
  hygieneTypes: [],
  flowIntensity: null,
  allergies: [],
  sensitiveSkin: false,
  allergyNotes: '',
  diet: null,
  goal: null,
  favoriteFlavors: [],
  careItems: [],
  surpriseGift: true,
  brandPreferences: '',
  wantsSamples: true,
  notes: '',
  configured: false,
};

export type OrderStatus = 'processing' | 'shipped' | 'delivered' | 'cancelled';

export interface BoxOrder {
  id: string;
  /** ISO date when the order was created. */
  createdAt: string;
  /** Predicted period start the box was scheduled around. */
  cycleAnchor: string;
  /** ISO date the box ships from the warehouse. */
  shipDate: string;
  /** ISO date the box is expected to arrive (~3 days after ship). */
  estimatedDelivery: string;
  status: OrderStatus;
  /** Snapshot of address at time of order. */
  address: ShippingAddress;
}

export interface AppData {
  logs: Record<string, DayLog>; // keyed by YYYY-MM-DD
  settings: Settings;
  profile: Profile;
  onboardingDone: boolean;
  subscription: Subscription;
  shippingAddress: ShippingAddress;
  boxProfile: BoxProfile;
  orders: BoxOrder[];
}

export const SYMPTOMS: SymptomKey[] = [
  'cramps',
  'headache',
  'backache',
  'bloating',
  'breastTenderness',
  'acne',
  'fatigue',
  'nausea',
  'cravings',
  'insomnia',
];

export const MOODS: MoodKey[] = [
  'happy',
  'calm',
  'sad',
  'anxious',
  'irritable',
  'energetic',
  'tired',
  'sensitive',
];

export const FLOW_LEVELS: FlowLevel[] = ['none', 'spotting', 'light', 'medium', 'heavy'];
