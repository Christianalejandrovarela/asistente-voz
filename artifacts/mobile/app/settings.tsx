import React from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAssistant } from "@/context/AssistantContext";
import { useColors } from "@/hooks/useColors";

const VOICES = [
  { id: "nova", label: "Nova", description: "Amigable y expresiva" },
  { id: "alloy", label: "Alloy", description: "Equilibrada y versátil" },
  { id: "echo", label: "Echo", description: "Cálida y natural" },
  { id: "fable", label: "Fable", description: "Expresiva e intensa" },
  { id: "onyx", label: "Onyx", description: "Profunda y sonora" },
  { id: "shimmer", label: "Shimmer", description: "Suave y clara" },
] as const;

type VoiceId = (typeof VOICES)[number]["id"];

const LANGUAGES = [
  { code: "es", label: "Español", flag: "🇪🇸" },
  { code: "en", label: "English", flag: "🇺🇸" },
  { code: "fr", label: "Français", flag: "🇫🇷" },
  { code: "de", label: "Deutsch", flag: "🇩🇪" },
  { code: "it", label: "Italiano", flag: "🇮🇹" },
  { code: "pt", label: "Português", flag: "🇧🇷" },
  { code: "zh", label: "中文", flag: "🇨🇳" },
  { code: "ja", label: "日本語", flag: "🇯🇵" },
  { code: "ko", label: "한국어", flag: "🇰🇷" },
  { code: "ar", label: "العربية", flag: "🇸🇦" },
] as const;

type LanguageCode = (typeof LANGUAGES)[number]["code"];

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { settings, updateSettings, clearHistory, rollingBuffer, toggleRollingBuffer } = useAssistant();

  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const webBotPad = Platform.OS === "web" ? 34 : 0;

  const handleClearHistory = () => {
    Alert.alert(
      "Borrar historial",
      "¿Seguro que quieres borrar toda la conversación?",
      [
        { text: "Cancelar", style: "cancel" },
        {
          text: "Borrar",
          style: "destructive",
          onPress: () => {
            clearHistory();
            router.back();
          },
        },
      ]
    );
  };

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          paddingTop: insets.top + webTopPad,
          paddingBottom: insets.bottom + webBotPad,
        },
      ]}
    >
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backBtn}>
          <Feather name="arrow-left" size={22} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Ajustes</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* ─── Language ─── */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>IDIOMA</Text>
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {LANGUAGES.map((lang, idx) => {
            const isSelected = settings.language === lang.code;
            const isLast = idx === LANGUAGES.length - 1;
            return (
              <Pressable
                key={lang.code}
                style={[
                  styles.optionRow,
                  !isLast && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
                ]}
                onPress={() => updateSettings({ language: lang.code as LanguageCode })}
                testID={`lang-${lang.code}`}
              >
                <Text style={styles.flag}>{lang.flag}</Text>
                <Text style={[styles.optionName, { color: colors.foreground }]}>{lang.label}</Text>
                {isSelected && (
                  <View style={[styles.check, { backgroundColor: colors.primary }]}>
                    <Feather name="check" size={14} color="#fff" />
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>

        {/* ─── Voice ─── */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>VOZ DEL ASISTENTE</Text>
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {VOICES.map((voice, idx) => {
            const isSelected = settings.voice === voice.id;
            const isLast = idx === VOICES.length - 1;
            return (
              <Pressable
                key={voice.id}
                style={[
                  styles.optionRow,
                  !isLast && { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
                ]}
                onPress={() => updateSettings({ voice: voice.id as VoiceId })}
                testID={`voice-${voice.id}`}
              >
                <View style={styles.voiceInfo}>
                  <Text style={[styles.optionName, { color: colors.foreground }]}>{voice.label}</Text>
                  <Text style={[styles.voiceDesc, { color: colors.mutedForeground }]}>{voice.description}</Text>
                </View>
                {isSelected && (
                  <View style={[styles.check, { backgroundColor: colors.primary }]}>
                    <Feather name="check" size={14} color="#fff" />
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>

        {/* ─── Rolling Buffer ─── */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>GRABACIÓN CONTINUA</Text>
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.switchRow}>
            <View style={styles.switchInfo}>
              <Text style={[styles.infoTitle, { color: colors.foreground }]}>Grabación continua</Text>
              <Text style={[styles.infoDesc, { color: colors.mutedForeground }]}>
                Graba en segundo plano y mantiene los últimos 10 minutos de audio. Requiere build nativo con EAS.
              </Text>
            </View>
            <Switch
              value={rollingBuffer.isActive}
              onValueChange={(val) => void toggleRollingBuffer(val)}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor="#fff"
              testID="rolling-buffer-toggle"
            />
          </View>
        </View>

        {/* ─── Info ─── */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>INFORMACIÓN</Text>
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.infoRow}>
            <Feather name="bluetooth" size={18} color={colors.mutedForeground} />
            <View style={styles.infoText}>
              <Text style={[styles.infoTitle, { color: colors.foreground }]}>Control Bluetooth</Text>
              <Text style={[styles.infoDesc, { color: colors.mutedForeground }]}>
                Pulsa play/pausa en tus auriculares para activar el micrófono. Requiere build nativo con EAS.
              </Text>
            </View>
          </View>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <View style={styles.infoRow}>
            <Feather name="refresh-cw" size={18} color={colors.mutedForeground} />
            <View style={styles.infoText}>
              <Text style={[styles.infoTitle, { color: colors.foreground }]}>Servicio en segundo plano</Text>
              <Text style={[styles.infoDesc, { color: colors.mutedForeground }]}>
                La app permanece activa 24/7 con notificación persistente. Requiere build nativo con EAS.
              </Text>
            </View>
          </View>
        </View>

        {/* ─── Conversation ─── */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>CONVERSACIÓN</Text>
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Pressable style={styles.dangerRow} onPress={handleClearHistory} testID="clear-history">
            <Feather name="trash-2" size={18} color={colors.destructive} />
            <Text style={[styles.dangerText, { color: colors.destructive }]}>Borrar historial</Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    padding: 4,
    width: 40,
  },
  title: {
    flex: 1,
    textAlign: "center",
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
  },
  placeholder: {
    width: 40,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 40,
    gap: 8,
  },
  sectionLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
    marginBottom: 4,
    marginTop: 16,
    marginLeft: 4,
  },
  section: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  flag: {
    fontSize: 22,
  },
  voiceInfo: {
    flex: 1,
  },
  optionName: {
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    marginBottom: 2,
  },
  voiceDesc: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  infoText: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    marginBottom: 4,
  },
  infoDesc: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
  dangerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  dangerText: {
    fontSize: 16,
    fontFamily: "Inter_500Medium",
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  switchInfo: {
    flex: 1,
  },
});
