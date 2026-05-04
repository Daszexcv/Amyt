import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { parseISO } from 'date-fns';
import Svg, { Circle, Line, Path, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { useApp } from '../AppContext';
import { useSubscription } from '../hooks/useSubscription';
import {
  computeCycleStats,
  countSymptoms,
} from '../cycle';
import { tArray } from '../i18n';
import { SERIF_STACK, WaveBackground } from '../components/WaveBackground';
import { PremiumGate } from '../components/PremiumGate';
import { ThemeColors } from '../theme';
import { exportToPdf } from '../utils/exportPdf';

export const AnalyticsScreen: React.FC = () => {
  const { data, predictions, colors, t, language } = useApp();
  const { isPremium } = useSubscription();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  void language;

  const stats = useMemo(
    () => computeCycleStats(data.logs, data.settings),
    [data.logs, data.settings],
  );
  const symptomCounts = useMemo(() => countSymptoms(data.logs), [data.logs]);

  const months = tArray('monthsGenitive');
  const fmtDate = (iso: string | null): string => {
    if (!iso) return '—';
    const d = parseISO(iso);
    return `${d.getDate()} ${months[d.getMonth()] ?? ''}`;
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <WaveBackground colors={colors} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.h1}>{t('analytics.title')}</Text>

        {isPremium ? (
          <Pressable
            style={styles.exportBtn}
            onPress={() => {
              void exportToPdf(data, 'analytics');
            }}
          >
            <Text style={styles.exportBtnText}>Экспорт аналитики в PDF</Text>
          </Pressable>
        ) : null}

        {/* Forecast block is available to free users — period, ovulation,
            and basic averages. Deep charts stay behind PremiumGate below. */}
        <Text style={styles.section}>{t('analytics.forecast')}</Text>
        <View style={styles.row}>
          <ForecastCard
            label={t('analytics.nextPeriod')}
            value={fmtDate(predictions.nextPeriodStart)}
            colors={colors}
            tint={colors.period}
          />
          <ForecastCard
            label={t('analytics.nextOvulation')}
            value={fmtDate(predictions.ovulation)}
            colors={colors}
            tint={colors.ovulation}
          />
        </View>

        <View style={styles.row}>
          <ForecastCard
            label={t('analytics.avgCycle')}
            value={
              stats.averageCycleLength !== null
                ? `${stats.averageCycleLength} ${t('analytics.days')}`
                : '—'
            }
            colors={colors}
          />
          <ForecastCard
            label={t('analytics.avgPeriod')}
            value={
              stats.averagePeriodLength !== null
                ? `${stats.averagePeriodLength} ${t('analytics.days')}`
                : '—'
            }
            colors={colors}
          />
        </View>

        {isPremium ? (
          <>
            <Text style={styles.section}>
              {t('analytics.cycleLengthChartTitle')}
            </Text>
            {stats.cycleLengths.length >= 2 ? (
              <View style={styles.chartCard}>
                <CycleLengthChart
                  values={stats.cycleLengths.slice(-6)}
                  average={stats.averageCycleLength}
                  colors={colors}
                />
              </View>
            ) : (
              <View style={styles.chartCard}>
                <Text style={styles.muted}>
                  {t('analytics.cycleLengthChartHint')}
                </Text>
              </View>
            )}

            <Text style={styles.section}>{t('analytics.symptomsTitle')}</Text>
            {symptomCounts.length > 0 ? (
              <View style={styles.chartCard}>
                <SymptomsBreakdown
                  data={symptomCounts}
                  labelFor={(k) => t(`symptoms.${k}`)}
                  colors={colors}
                />
              </View>
            ) : (
              <View style={styles.chartCard}>
                <Text style={styles.muted}>{t('analytics.symptomsHint')}</Text>
              </View>
            )}
          </>
        ) : (
          <PremiumGate
            feature="Графики цикла и симптомы"
            body="История длительности циклов, статистика симптомов по фазам, irregular-флаг и экспорт всей аналитики в PDF. Открывается с любой подпиской — Premium / Базовая / VIP."
          />
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
    </SafeAreaView>
  );
};

const ForecastCard: React.FC<{
  label: string;
  value: string;
  colors: ThemeColors;
  tint?: string;
}> = ({ label, value, colors, tint }) => {
  const styles = makeStyles(colors);
  return (
    <View style={[styles.card, { borderColor: tint ?? colors.border }]}>
      <Text style={styles.cardLabel}>{label}</Text>
      <Text style={[styles.cardValue, tint ? { color: tint } : null]}>
        {value}
      </Text>
    </View>
  );
};

const CycleLengthChart: React.FC<{
  values: number[];
  average: number | null;
  colors: ThemeColors;
}> = ({ values, average, colors }) => {
  const W = 280;
  const H = 140;
  const PAD_L = 28;
  const PAD_R = 12;
  const PAD_T = 14;
  const PAD_B = 22;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const min = Math.min(...values) - 1;
  const max = Math.max(...values) + 1;
  const span = Math.max(1, max - min);
  const stepX = values.length > 1 ? innerW / (values.length - 1) : innerW;
  const points = values
    .map((v, i) => {
      const x = PAD_L + stepX * i;
      const y = PAD_T + innerH - ((v - min) / span) * innerH;
      return `${x},${y}`;
    })
    .join(' ');
  const avgY =
    average !== null
      ? PAD_T + innerH - ((average - min) / span) * innerH
      : null;

  return (
    <Svg width={W} height={H}>
      <Rect x={0} y={0} width={W} height={H} fill="transparent" />
      {avgY !== null && (
        <Line
          x1={PAD_L}
          x2={W - PAD_R}
          y1={avgY}
          y2={avgY}
          stroke={colors.textMuted}
          strokeWidth={1}
          strokeDasharray="4 4"
          opacity={0.5}
        />
      )}
      <Polyline
        points={points}
        fill="none"
        stroke={colors.primary}
        strokeWidth={2}
      />
      {values.map((v, i) => {
        const x = PAD_L + stepX * i;
        const y = PAD_T + innerH - ((v - min) / span) * innerH;
        return (
          <React.Fragment key={`p${i}`}>
            <Circle cx={x} cy={y} r={4} fill={colors.primary} />
            <SvgText
              x={x}
              y={y - 8}
              fontSize="10"
              fill={colors.text}
              textAnchor="middle"
            >
              {String(v)}
            </SvgText>
          </React.Fragment>
        );
      })}
      <SvgText
        x={PAD_L - 4}
        y={PAD_T + innerH}
        fontSize="10"
        fill={colors.textMuted}
        textAnchor="end"
      >
        {String(Math.round(min))}
      </SvgText>
      <SvgText
        x={PAD_L - 4}
        y={PAD_T + 8}
        fontSize="10"
        fill={colors.textMuted}
        textAnchor="end"
      >
        {String(Math.round(max))}
      </SvgText>
    </Svg>
  );
};

const PALETTE = [
  '#C99275',
  '#E8A78F',
  '#D4B59A',
  '#B59C84',
  '#8E6F58',
  '#E8C4A8',
  '#A28066',
  '#CFA88B',
  '#7E624C',
  '#F0D7BF',
];

const SymptomsBreakdown: React.FC<{
  data: { key: string; count: number }[];
  labelFor: (k: string) => string;
  colors: ThemeColors;
}> = ({ data, labelFor, colors }) => {
  const top = data.slice(0, 6);
  const total = top.reduce((a, b) => a + b.count, 0);
  const W = 280;
  const R = 60;
  const CX = W / 2;
  const CY = R + 10;
  let cumulative = 0;
  const arcs: { d: string; color: string }[] = [];
  for (let i = 0; i < top.length; i++) {
    const value = top[i].count / total;
    const startAngle = cumulative * 2 * Math.PI - Math.PI / 2;
    cumulative += value;
    const endAngle = cumulative * 2 * Math.PI - Math.PI / 2;
    const x1 = CX + R * Math.cos(startAngle);
    const y1 = CY + R * Math.sin(startAngle);
    const x2 = CX + R * Math.cos(endAngle);
    const y2 = CY + R * Math.sin(endAngle);
    const largeArc = value > 0.5 ? 1 : 0;
    const d =
      top.length === 1
        ? `M ${CX - R} ${CY} a ${R} ${R} 0 1 0 ${R * 2} 0 a ${R} ${R} 0 1 0 -${R * 2} 0`
        : `M ${CX} ${CY} L ${x1} ${y1} A ${R} ${R} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    arcs.push({ d, color: PALETTE[i % PALETTE.length] });
  }
  return (
    <View>
      <Svg width={W} height={R * 2 + 20}>
        {arcs.map((a, i) => (
          <Path key={i} d={a.d} fill={a.color} />
        ))}
        <Circle cx={CX} cy={CY} r={R * 0.55} fill={colors.card} />
      </Svg>
      <View style={{ marginTop: 12 }}>
        {top.map((s, i) => (
          <View key={s.key} style={legendStyles.row}>
            <View
              style={[
                legendStyles.dot,
                { backgroundColor: PALETTE[i % PALETTE.length] },
              ]}
            />
            <Text style={[legendStyles.label, { color: colors.text }]}>
              {labelFor(s.key)}
            </Text>
            <Text style={[legendStyles.value, { color: colors.textMuted }]}>
              {s.count}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
};

const legendStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  label: { flex: 1, fontSize: 13 },
  value: { fontSize: 13, fontWeight: '600' },
});

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    content: { padding: 16, paddingTop: 8 },
    h1: {
      fontSize: 32,
      fontFamily: SERIF_STACK,
      fontWeight: '300',
      color: colors.primary,
      marginBottom: 8,
      marginTop: 8,
    },
    section: {
      fontSize: 12,
      color: colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      fontWeight: '600',
      marginTop: 14,
      marginBottom: 8,
    },
    row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
    exportBtn: {
      backgroundColor: colors.primary,
      borderRadius: 12,
      paddingVertical: 11,
      paddingHorizontal: 16,
      alignItems: 'center',
      marginTop: 6,
      marginBottom: 6,
    },
    exportBtnText: {
      color: colors.primaryText,
      fontWeight: '700',
      fontSize: 14,
      letterSpacing: 0.3,
    },
    card: {
      flex: 1,
      backgroundColor: colors.card,
      borderRadius: 18,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: '#000',
      shadowOpacity: 0.04,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
      elevation: 1,
    },
    cardLabel: {
      color: colors.textMuted,
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      fontWeight: '600',
      marginBottom: 6,
    },
    cardValue: {
      fontSize: 18,
      color: colors.text,
      fontFamily: SERIF_STACK,
    },
    chartCard: {
      backgroundColor: colors.card,
      borderRadius: 18,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
    },
    muted: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  });
