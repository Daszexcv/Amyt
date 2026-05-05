import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { format, parseISO } from 'date-fns';
import { ru } from 'date-fns/locale';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useApp } from '../AppContext';
import { i18n } from '../i18n';
import {
  DayLog,
  FlowLevel,
  FLOW_LEVELS,
  MOODS,
  MoodKey,
  SYMPTOMS,
  SymptomKey,
} from '../types';
import { RootStackParamList } from '../navigation';

type Props = NativeStackScreenProps<RootStackParamList, 'DayDetail'>;

export const DayDetailScreen: React.FC<Props> = ({ route, navigation }) => {
  const { date } = route.params;
  const { data, upsertLog, removeLog, colors, t } = useApp();
  const existing = data.logs[date];

  const [flow, setFlow] = useState<FlowLevel | undefined>(existing?.flow);
  const [symptoms, setSymptoms] = useState<SymptomKey[]>(existing?.symptoms ?? []);
  const [moods, setMoods] = useState<MoodKey[]>(existing?.moods ?? []);
  const [tempText, setTempText] = useState<string>(
    existing?.temperature !== undefined ? String(existing.temperature) : '',
  );
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [intimacy, setIntimacy] = useState(existing?.intimacy ?? false);

  const styles = useMemo(() => makeStyles(colors), [colors]);

  useEffect(() => {
    const locale = i18n.locale === 'ru' ? ru : undefined;
    navigation.setOptions({
      title: format(parseISO(date), 'd MMMM yyyy', { locale }),
    });
  }, [date, navigation]);

  const isPeriodDay = flow !== undefined && flow !== 'none';

  const toggle = <T extends string>(arr: T[], item: T): T[] =>
    arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item];

  const handleSave = async () => {
    const parsedTemp = tempText.trim() ? Number(tempText.replace(',', '.')) : undefined;
    const cleanTemp =
      parsedTemp !== undefined && !Number.isNaN(parsedTemp) ? parsedTemp : undefined;
    const log: DayLog = {
      date,
      flow,
      symptoms: symptoms.length ? symptoms : undefined,
      moods: moods.length ? moods : undefined,
      temperature: cleanTemp,
      notes: notes.trim() || undefined,
      intimacy: intimacy || undefined,
    };
    await upsertLog(log);
    navigation.goBack();
  };

  const handleDelete = () => {
    Alert.alert(t('day.delete'), '', [
      { text: t('settings.cancel'), style: 'cancel' },
      {
        text: t('settings.confirm'),
        style: 'destructive',
        onPress: async () => {
          await removeLog(date);
          navigation.goBack();
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.periodCard}>
            <View style={styles.periodRow}>
              <Text style={styles.periodLabel}>{t('day.periodStarted')}</Text>
              <Switch
                value={isPeriodDay}
                onValueChange={(on) => {
                  if (on) {
                    if (!flow || flow === 'none') setFlow('medium');
                  } else {
                    setFlow(undefined);
                  }
                }}
                trackColor={{ true: colors.primary, false: colors.border }}
              />
            </View>
            {isPeriodDay && (
              <Text style={styles.periodHint}>{t('day.periodStartedHint')}</Text>
            )}
          </View>

          <Section title={t('day.flow')} colors={colors}>
            <View style={styles.chipRow}>
              {FLOW_LEVELS.map((lvl) => {
                const active = flow === lvl;
                return (
                  <Pressable
                    key={lvl}
                    onPress={() => setFlow(active ? undefined : lvl)}
                    style={[
                      styles.chip,
                      active && {
                        backgroundColor: colors.primary,
                        borderColor: colors.primary,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        active && { color: colors.primaryText },
                      ]}
                    >
                      {t(`flow.${lvl}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>

          <Section title={t('day.symptoms')} colors={colors}>
            <View style={styles.chipRow}>
              {SYMPTOMS.map((s) => {
                const active = symptoms.includes(s);
                return (
                  <Pressable
                    key={s}
                    onPress={() => setSymptoms((cur) => toggle(cur, s))}
                    style={[
                      styles.chip,
                      active && {
                        backgroundColor: colors.accent,
                        borderColor: colors.accent,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        active && { color: colors.primaryText },
                      ]}
                    >
                      {t(`symptoms.${s}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>

          <Section title={t('day.mood')} colors={colors}>
            <View style={styles.chipRow}>
              {MOODS.map((m) => {
                const active = moods.includes(m);
                return (
                  <Pressable
                    key={m}
                    onPress={() => setMoods((cur) => toggle(cur, m))}
                    style={[
                      styles.chip,
                      active && {
                        backgroundColor: colors.accent,
                        borderColor: colors.accent,
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        active && { color: colors.primaryText },
                      ]}
                    >
                      {t(`moods.${m}`)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Section>

          <Section title={t('day.temperature')} colors={colors}>
            <TextInput
              value={tempText}
              onChangeText={setTempText}
              keyboardType="decimal-pad"
              placeholder="36.6"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
            />
          </Section>

          <Section title={t('day.intimacy')} colors={colors}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>{t('day.intimacy')}</Text>
              <Switch
                value={intimacy}
                onValueChange={setIntimacy}
                trackColor={{ true: colors.primary, false: colors.border }}
              />
            </View>
          </Section>

          <Section title={t('day.notes')} colors={colors}>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder={t('day.notesPlaceholder')}
              placeholderTextColor={colors.textMuted}
              style={[styles.input, styles.notesInput]}
              multiline
            />
          </Section>

          <Pressable style={styles.saveBtn} onPress={handleSave}>
            <Text style={styles.saveBtnText}>{t('day.save')}</Text>
          </Pressable>
          {existing && (
            <Pressable style={styles.deleteBtn} onPress={handleDelete}>
              <Text style={styles.deleteBtnText}>{t('day.delete')}</Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const Section: React.FC<{
  title: string;
  colors: ReturnType<typeof useApp>['colors'];
  children: React.ReactNode;
}> = ({ title, colors, children }) => {
  const styles = makeStyles(colors);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
};

const makeStyles = (colors: ReturnType<typeof useApp>['colors']) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.background },
    content: { padding: 16, paddingBottom: 32 },
    periodCard: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 16,
    },
    periodRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    periodLabel: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '600',
      flex: 1,
      paddingRight: 12,
    },
    periodHint: {
      color: colors.textMuted,
      fontSize: 13,
      marginTop: 8,
      lineHeight: 18,
    },
    section: { marginBottom: 16 },
    sectionTitle: {
      color: colors.textMuted,
      fontWeight: '600',
      fontSize: 13,
      marginBottom: 8,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    sectionBody: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.border,
    },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      marginRight: 8,
      marginBottom: 8,
      backgroundColor: colors.surface,
    },
    chipText: { color: colors.text, fontSize: 14 },
    input: {
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: colors.text,
      backgroundColor: colors.surface,
    },
    notesInput: {
      minHeight: 100,
      textAlignVertical: 'top',
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    rowLabel: { color: colors.text, fontSize: 16 },
    saveBtn: {
      backgroundColor: colors.primary,
      paddingVertical: 14,
      borderRadius: 14,
      alignItems: 'center',
      marginTop: 8,
    },
    saveBtnText: {
      color: colors.primaryText,
      fontWeight: '700',
      fontSize: 16,
    },
    deleteBtn: {
      paddingVertical: 12,
      alignItems: 'center',
      marginTop: 8,
    },
    deleteBtnText: { color: colors.danger, fontWeight: '600' },
  });
