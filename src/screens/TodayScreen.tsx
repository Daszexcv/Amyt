import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle as SvgCircle, Rect } from 'react-native-svg';
import { addDays, format, parseISO } from 'date-fns';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import { useSubscription } from '../hooks/useSubscription';
import { RootStackParamList } from '../navigation';
import { i18n, tArray } from '../i18n';
import {
  buildPhaseSegments,
  CyclePhase,
  fertileWindowInfo,
  phaseForCycleDay,
} from '../cycle';
import { ThemeColors } from '../theme';
import { PhaseRing } from '../components/PhaseRing';
import { WaveBackground } from '../components/WaveBackground';

const ruDayWord = (n: number): string => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return 'дней';
  if (b > 1 && b < 5) return 'дня';
  if (b === 1) return 'день';
  return 'дней';
};

const formatDays = (n: number, locale: string): string => {
  if (locale === 'ru') return `${n} ${ruDayWord(n)}`;
  return n === 1 ? `${n} day` : `${n} days`;
};

const SERIF =
  // Stack of warm, elegant serifs that work on iOS, Android and the web build.
  'Cochin, "Hoefler Text", "Times New Roman", Georgia, serif';

const formatDayMonth = (date: Date, monthsGenitive: string[]): string => {
  const day = date.getDate();
  const month = monthsGenitive[date.getMonth()] ?? '';
  return `${day} ${month}`;
};

const phaseTitleKey = (phase: CyclePhase): string => {
  switch (phase) {
    case 'period':
      return 'today.phasePeriod';
    case 'follicular':
      return 'today.phaseFollicular';
    case 'fertile':
      return 'today.phaseFertile';
    case 'ovulation':
      return 'today.phaseOvulation';
    case 'luteal':
      return 'today.phaseLuteal';
    default:
      return 'today.phaseFollicular';
  }
};

const phaseInnerKey = (phase: CyclePhase): string => {
  switch (phase) {
    case 'period':
      return 'today.innerPeriod';
    case 'follicular':
      return 'today.innerFollicular';
    case 'fertile':
      return 'today.innerFertile';
    case 'ovulation':
      return 'today.innerOvulation';
    case 'luteal':
      return 'today.innerLuteal';
    default:
      return 'today.innerFollicular';
  }
};

const DropIcon: React.FC<{ size: number; colors: ThemeColors }> = ({
  size,
  colors,
}) => (
  <Svg width={size} height={size} viewBox="0 0 64 80">
    <Path
      d="M32 4 C 32 4 8 30 8 50 C 8 64 19 76 32 76 C 45 76 56 64 56 50 C 56 30 32 4 32 4 Z"
      fill={colors.fertile}
      stroke={colors.primary}
      strokeWidth={2}
    />
    <Path
      d="M40 28 L 42 32 L 46 34 L 42 36 L 40 40 L 38 36 L 34 34 L 38 32 Z"
      fill={colors.card}
      opacity={0.85}
    />
    <SvgCircle cx={48} cy={26} r={2} fill={colors.card} opacity={0.9} />
  </Svg>
);

const HeartIcon: React.FC<{ size: number; colors: ThemeColors }> = ({
  size,
  colors,
}) => (
  <Svg width={size} height={size} viewBox="0 0 64 64">
    <Path
      d="M32 56 C 32 56 8 40 8 24 C 8 14 16 8 24 8 C 28 8 30 10 32 14 C 34 10 36 8 40 8 C 48 8 56 14 56 24 C 56 40 32 56 32 56 Z"
      fill={colors.fertile}
      stroke={colors.primary}
      strokeWidth={2}
    />
  </Svg>
);

const CalendarIcon: React.FC<{ size: number; colors: ThemeColors }> = ({
  size,
  colors,
}) => (
  <Svg width={size} height={size} viewBox="0 0 64 64">
    <Rect
      x={8}
      y={14}
      width={48}
      height={42}
      rx={6}
      fill={colors.card}
      stroke={colors.primary}
      strokeWidth={2}
    />
    <Rect x={8} y={14} width={48} height={10} rx={6} fill={colors.fertile} />
    <Rect x={18} y={6} width={4} height={12} rx={2} fill={colors.primary} />
    <Rect x={42} y={6} width={4} height={12} rx={2} fill={colors.primary} />
    <Rect x={16} y={30} width={8} height={6} rx={1.5} fill={colors.fertile} />
    <Rect x={28} y={30} width={8} height={6} rx={1.5} fill={colors.fertile} />
    <Rect x={40} y={30} width={8} height={6} rx={1.5} fill={colors.fertile} />
    <Rect x={16} y={40} width={8} height={6} rx={1.5} fill={colors.fertile} />
    <Rect x={28} y={40} width={8} height={6} rx={1.5} fill={colors.primary} />
    <Rect x={40} y={40} width={8} height={6} rx={1.5} fill={colors.fertile} />
  </Svg>
);

type Nav = NativeStackNavigationProp<RootStackParamList>;

export const TodayScreen: React.FC = () => {
  const { data, predictions, colors, t, language, upsertLogs } = useApp();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const navigation = useNavigation<Nav>();
  const { isVip } = useSubscription();
  // `language` from settings is 'auto' | 'en' | 'ru'. For pluralisation we
  // always want the resolved locale ('en' or 'ru'), so use i18n.locale.
  void language;
  const locale = i18n.locale === 'ru' ? 'ru' : 'en';
  const vipShipDate = useMemo(() => {
    if (!isVip || !predictions.nextPeriodStart) return null;
    try {
      return addDays(parseISO(predictions.nextPeriodStart), -5);
    } catch {
      return null;
    }
  }, [isVip, predictions.nextPeriodStart]);

  const today = new Date();
  const todayKey = format(today, 'yyyy-MM-dd');
  const [confirmDismissed, setConfirmDismissed] = useState(false);
  const [confirmJustSaved, setConfirmJustSaved] = useState(false);
  const todayAlreadyLogged = (() => {
    const log = data.logs[todayKey];
    return !!(log && log.flow && log.flow !== 'none');
  })();

  // Show the "did your period start today?" prompt within ±7 days of the
  // predicted next-period start, when the user hasn't already logged a flow.
  const showConfirmCard = (() => {
    if (todayAlreadyLogged) return false;
    if (confirmDismissed) return false;
    const days = predictions.daysUntilNextPeriod;
    if (days === null) return false;
    return days <= 7 && days >= -7;
  })();

  const onConfirmYes = async () => {
    await upsertLogs([{ date: todayKey, flow: 'medium' }]);
    setConfirmJustSaved(true);
  };
  const onConfirmNo = () => setConfirmDismissed(true);
  const cycleLen = predictions.effectiveCycleLength;
  const periodLen = predictions.effectivePeriodLength;
  const lutealLen = data.settings.lutealPhaseLength;

  const segments = useMemo(
    () => buildPhaseSegments(cycleLen, periodLen, lutealLen),
    [cycleLen, periodLen, lutealLen],
  );

  const cycleDay = predictions.cycleDay;
  const phase: CyclePhase = cycleDay
    ? phaseForCycleDay(cycleDay, segments)
    : 'unknown';

  // Tap into the language signal to keep month names reactive on locale change.
  void language;

  const monthsGen = tArray('monthsGenitive');
  const dateStr = formatDayMonth(today, monthsGen);

  const fertile = fertileWindowInfo(cycleDay, segments);

  const ringSize = Math.min(width - 80, 260);

  const renderCenter = () => {
    const innerLabel = t(phaseInnerKey(phase));
    const iconSize = ringSize * 0.32;
    return (
      <View style={styles.ringCenter}>
        <DropIcon size={iconSize} colors={colors} />
        <Text
          style={[styles.ringLabel, { fontFamily: SERIF }]}
          numberOfLines={2}
        >
          {innerLabel}
        </Text>
      </View>
    );
  };

  const untilPeriodValue = (() => {
    const days = predictions.daysUntilNextPeriod;
    if (days === null) return '—';
    if (days === 0) return t('today.cardUntilPeriodNow');
    if (days < 0) {
      return language === 'ru'
        ? `Задержка ${formatDays(Math.abs(days), 'ru')}`
        : `Late ${formatDays(Math.abs(days), 'en')}`;
    }
    return formatDays(days, locale);
  })();

  const fertileValue = (() => {
    if (predictions.lastPeriodStart === null) return '—';
    if (fertile.isInside) {
      return formatDays(fertile.remaining, locale);
    }
    if (fertile.total === 0) return '—';
    if (cycleDay !== null) {
      const nextStart = predictions.fertileStart
        ? parseISO(predictions.fertileStart)
        : null;
      if (nextStart) {
        const diff = Math.ceil(
          (nextStart.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
        );
        if (diff > 0) {
          return locale === 'ru'
            ? `через ${formatDays(diff, 'ru')}`
            : `in ${formatDays(diff, 'en')}`;
        }
      }
      return t('today.fertileEnded');
    }
    return formatDays(fertile.total, locale);
  })();

  const nextOvulationValue = (() => {
    if (!predictions.ovulation) return '—';
    const ovDate = parseISO(predictions.ovulation);
    // If the ovulation date in `predictions` already passed today, advance by
    // one cycle so the card always shows an upcoming date.
    let target = ovDate;
    if (target.getTime() < today.getTime() - 1000 * 60 * 60 * 24) {
      target = addDays(target, cycleLen);
    }
    return formatDayMonth(target, monthsGen);
  })();

  const isEmpty = !predictions.lastPeriodStart;

  return (
    <TodayInner
      isEmpty={isEmpty}
      dateStr={dateStr}
      cycleDay={cycleDay}
      phase={phase}
      cycleLen={cycleLen}
      segments={segments}
      ringSize={ringSize}
      renderCenter={renderCenter}
      untilPeriodValue={untilPeriodValue}
      fertileValue={fertileValue}
      nextOvulationValue={nextOvulationValue}
      colors={colors}
      styles={styles}
      t={t}
      insets={insets}
      showConfirmCard={showConfirmCard}
      confirmJustSaved={confirmJustSaved}
      onConfirmYes={onConfirmYes}
      onConfirmNo={onConfirmNo}
      isVip={isVip}
      vipShipDate={vipShipDate}
      onTapBox={() => navigation.navigate('Subscription' as never)}
    />
  );
};

interface TodayInnerProps {
  isEmpty: boolean;
  dateStr: string;
  cycleDay: number | null;
  phase: CyclePhase;
  cycleLen: number;
  segments: ReturnType<typeof buildPhaseSegments>;
  ringSize: number;
  renderCenter: () => React.ReactNode;
  untilPeriodValue: string;
  fertileValue: string;
  nextOvulationValue: string;
  colors: ThemeColors;
  styles: ReturnType<typeof makeStyles>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  insets: { top: number; right: number; bottom: number; left: number };
  showConfirmCard: boolean;
  confirmJustSaved: boolean;
  onConfirmYes: () => void;
  onConfirmNo: () => void;
  isVip: boolean;
  vipShipDate: Date | null;
  onTapBox: () => void;
}

const TodayInner: React.FC<TodayInnerProps> = ({
  isEmpty,
  dateStr,
  cycleDay,
  phase,
  cycleLen,
  segments,
  ringSize,
  renderCenter,
  untilPeriodValue,
  fertileValue,
  nextOvulationValue,
  colors,
  styles,
  t,
  insets,
  showConfirmCard,
  confirmJustSaved,
  onConfirmYes,
  onConfirmNo,
  isVip,
  vipShipDate,
  onTapBox,
}) => {
  const dash = t('today.placeholderValue');
  const showCycleDay = !isEmpty && cycleDay !== null;
  const phaseText = isEmpty ? t('today.placeholderPhase') : t(phaseTitleKey(phase));
  const cardUntil = isEmpty ? dash : untilPeriodValue;
  const cardFertile = isEmpty ? dash : fertileValue;
  const cardOvulation = isEmpty ? dash : nextOvulationValue;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <WaveBackground colors={colors} />
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: 24 + Math.max(insets.bottom, 24) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerWrap}>
          <Text style={[styles.headerLabel, { fontFamily: SERIF }]}>
            {t('today.header')}
          </Text>
          <View style={styles.divider} />
        </View>

        <View style={styles.dateBlock}>
          <Text style={[styles.bigDate, { fontFamily: SERIF }]}>{dateStr}</Text>
          <View style={styles.subDivider} />
          {showCycleDay && cycleDay !== null && (
            <Text style={styles.cycleDay}>
              {t('today.cycleDay', { n: cycleDay })}
            </Text>
          )}
          <Text style={styles.phaseLabel}>{phaseText}</Text>
        </View>

        <View style={styles.ringWrap}>
          <PhaseRing
            size={ringSize}
            cycleLen={cycleLen}
            cycleDay={isEmpty ? null : cycleDay}
            segments={isEmpty ? [] : segments}
            colors={colors}
          >
            {renderCenter()}
          </PhaseRing>
        </View>

        <View style={styles.cards}>
          <InfoCard
            colors={colors}
            icon={<DropIcon size={28} colors={colors} />}
            label={t('today.cardUntilPeriod')}
            value={cardUntil}
            serif={SERIF}
          />
          <InfoCard
            colors={colors}
            icon={<HeartIcon size={28} colors={colors} />}
            label={t('today.cardFertileWindow')}
            value={cardFertile}
            serif={SERIF}
          />
          <InfoCard
            colors={colors}
            icon={<CalendarIcon size={28} colors={colors} />}
            label={t('today.cardNextOvulation')}
            value={cardOvulation}
            serif={SERIF}
          />
        </View>

        {isEmpty ? (
          <View style={styles.ctaWrap}>
            <Text style={styles.ctaHint}>{t('today.noCycleHint')}</Text>
          </View>
        ) : null}

        {isVip && vipShipDate ? (
          <Pressable style={styles.vipCard} onPress={onTapBox}>
            <View style={styles.vipIconWrap}>
              <Svg width={28} height={28} viewBox="0 0 24 24" fill="none">
                <Path
                  d="M3 7.5 12 3l9 4.5v9L12 21 3 16.5v-9Z"
                  stroke={colors.primary}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                />
                <Path d="M3 7.5 12 12l9-4.5" stroke={colors.primary} strokeWidth={1.5} strokeLinejoin="round" />
                <Path d="M12 12v9" stroke={colors.primary} strokeWidth={1.5} />
              </Svg>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.vipLabel}>{t('today.boxLabel')}</Text>
              <Text style={styles.vipDate}>{format(vipShipDate, 'd MMM')}</Text>
              <Text style={styles.vipHint}>{t('today.boxHint')}</Text>
            </View>
          </Pressable>
        ) : null}

        {!isEmpty && showConfirmCard && !confirmJustSaved ? (
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>{t('today.confirmTitle')}</Text>
            <Text style={styles.confirmHint}>{t('today.confirmHint')}</Text>
            <View style={styles.confirmRow}>
              <Pressable
                style={[styles.confirmBtn, styles.confirmBtnPrimary]}
                onPress={onConfirmYes}
              >
                <Text style={styles.confirmBtnPrimaryText}>
                  {t('today.confirmYes')}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.confirmBtn, styles.confirmBtnGhost]}
                onPress={onConfirmNo}
              >
                <Text style={styles.confirmBtnGhostText}>
                  {t('today.confirmNo')}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {!isEmpty && confirmJustSaved ? (
          <View style={styles.confirmCard}>
            <Text style={styles.confirmTitle}>
              {t('today.confirmSavedTitle')}
            </Text>
            <Text style={styles.confirmHint}>
              {t('today.confirmSavedHint')}
            </Text>
          </View>
        ) : null}

        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
};

const InfoCard: React.FC<{
  colors: ThemeColors;
  icon: React.ReactNode;
  label: string;
  value: string;
  serif: string;
}> = ({ colors, icon, label, value, serif }) => {
  const styles = makeStyles(colors);
  return (
    <View style={styles.infoCard}>
      <View style={styles.infoIcon}>{icon}</View>
      <Text style={styles.infoLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[styles.infoValue, { fontFamily: serif }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
};

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    scroll: {
      paddingHorizontal: 24,
      paddingTop: 8,
      paddingBottom: 24,
      alignItems: 'center',
    },
    headerWrap: {
      width: '100%',
      alignItems: 'center',
      marginTop: 8,
      marginBottom: 12,
    },
    headerLabel: {
      fontSize: 18,
      color: colors.textMuted,
      letterSpacing: 1,
    },
    divider: {
      height: 1,
      backgroundColor: colors.border,
      width: '70%',
      marginTop: 12,
    },
    dateBlock: {
      alignItems: 'center',
      marginTop: 4,
      marginBottom: 4,
    },
    bigDate: {
      fontSize: 48,
      color: colors.primary,
      fontWeight: '300',
      letterSpacing: 0.5,
      marginBottom: 4,
    },
    subDivider: {
      height: 1,
      backgroundColor: colors.border,
      width: 110,
      marginTop: 6,
      marginBottom: 6,
    },
    cycleDay: {
      fontSize: 16,
      color: colors.textMuted,
      marginBottom: 0,
    },
    phaseLabel: {
      fontSize: 14,
      color: colors.textMuted,
      letterSpacing: 0.6,
      textAlign: 'center',
      paddingHorizontal: 12,
    },
    ringWrap: {
      marginVertical: 8,
      alignItems: 'center',
    },
    ringCenter: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
    },
    ringLabel: {
      marginTop: 10,
      fontSize: 16,
      color: colors.textMuted,
      textAlign: 'center',
      letterSpacing: 0.4,
    },
    cards: {
      flexDirection: 'row',
      width: '100%',
      marginTop: 12,
    },
    infoCard: {
      flex: 1,
      backgroundColor: colors.card,
      borderRadius: 18,
      paddingVertical: 14,
      paddingHorizontal: 10,
      marginHorizontal: 4,
      alignItems: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.05,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    },
    infoIcon: {
      marginBottom: 6,
    },
    infoLabel: {
      fontSize: 11,
      color: colors.textMuted,
      letterSpacing: 0.3,
      textAlign: 'center',
      marginBottom: 4,
    },
    infoValue: {
      fontSize: 18,
      color: colors.text,
      fontWeight: '500',
      textAlign: 'center',
    },
    ctaWrap: {
      width: '100%',
      alignItems: 'center',
      marginTop: 18,
    },
    ctaBtn: {
      backgroundColor: colors.primary,
      paddingVertical: 14,
      paddingHorizontal: 28,
      borderRadius: 999,
      shadowColor: '#000',
      shadowOpacity: 0.08,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
      elevation: 2,
    },
    ctaBtnText: {
      color: colors.primaryText,
      fontSize: 16,
      fontWeight: '700',
      letterSpacing: 0.4,
    },
    ctaHint: {
      marginTop: 10,
      fontSize: 12,
      color: colors.textMuted,
      textAlign: 'center',
      maxWidth: 280,
      lineHeight: 17,
    },
    vipCard: {
      marginTop: 16,
      marginHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      backgroundColor: colors.card,
      borderRadius: 18,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderWidth: 1,
      borderColor: colors.accent,
    },
    vipIconWrap: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    vipLabel: {
      color: colors.textMuted,
      fontSize: 12,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      fontWeight: '600',
    },
    vipDate: {
      color: colors.primary,
      fontSize: 18,
      fontWeight: '700',
      marginTop: 2,
      fontFamily: SERIF,
    },
    vipHint: {
      color: colors.textMuted,
      fontSize: 12,
      marginTop: 2,
    },
    confirmCard: {
      marginTop: 16,
      marginHorizontal: 16,
      backgroundColor: colors.card,
      borderRadius: 18,
      paddingHorizontal: 18,
      paddingVertical: 16,
      borderWidth: 1,
      borderColor: colors.accent,
    },
    confirmTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.text,
      textAlign: 'center',
      fontFamily: SERIF,
    },
    confirmHint: {
      marginTop: 6,
      fontSize: 12.5,
      color: colors.textMuted,
      textAlign: 'center',
      lineHeight: 17,
    },
    confirmRow: {
      marginTop: 14,
      flexDirection: 'row',
      gap: 10,
    },
    confirmBtn: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
    },
    confirmBtnPrimary: {
      backgroundColor: colors.primary,
    },
    confirmBtnPrimaryText: {
      color: '#FFFCF7',
      fontSize: 14,
      fontWeight: '700',
      letterSpacing: 0.3,
    },
    confirmBtnGhost: {
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: colors.accent,
    },
    confirmBtnGhostText: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '600',
    },
  });
