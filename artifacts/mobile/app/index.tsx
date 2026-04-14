import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  NativeEventEmitter,
  NativeModules,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { VoiceOrb } from "@/components/VoiceOrb";
import { MessageBubble } from "@/components/MessageBubble";
import { AssistantStatus, ChatMessage, useAssistant } from "@/context/AssistantContext";
import { useColors } from "@/hooks/useColors";

// Native volume-key emitter — only available on Android (native build).
// Falls back to null on web / iOS so the rest of the code is always safe.
const volumeKeyEmitter =
  Platform.OS === "android" && NativeModules.VolumeKeyModule
    ? new NativeEventEmitter(NativeModules.VolumeKeyModule)
    : null;

const STATUS_LABELS: Record<AssistantStatus, string> = {
  idle: "Listo",
  waiting: "¿Algo más?",
  recording: "Escuchando...",
  processing: "Pensando...",
  speaking: "Respondiendo...",
};

// How long without a touch before the AMOLED black overlay appears (ms).
const AMOLED_TIMEOUT_MS = 20_000;

export default function MainScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { status, isSessionActive, messages, isBluetoothActive, debugInfo, startSession, stopSession, interruptSpeaking } = useAssistant();
  const listRef = useRef<FlatList>(null);

  // ── AMOLED "Modo Bolsillo" overlay ─────────────────────────────────────────
  // After AMOLED_TIMEOUT_MS of no touch, a full-screen black View covers the UI.
  // AMOLED panels use ~0 power for pure black pixels, so this saves battery while
  // keeping the screen physically on (useKeepAwake in _layout prevents OS timeout).
  // Touching anywhere dismisses the overlay and resets the inactivity timer.
  const [amoledActive, setAmoledActive] = useState(false);
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resetInactivityTimer = useCallback(() => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    setAmoledActive(false);
    inactivityTimer.current = setTimeout(() => {
      setAmoledActive(true);
    }, AMOLED_TIMEOUT_MS);
  }, []);

  // Start timer on mount, clear on unmount.
  useEffect(() => {
    resetInactivityTimer();
    return () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    };
  }, [resetInactivityTimer]);

  // ── Volume keys → dismiss AMOLED overlay ────────────────────────────────────
  // When the AMOLED black overlay is active, pressing VOLUME_UP or VOLUME_DOWN
  // dismisses it and restores the normal UI.  The system still handles the
  // actual volume change (we don't consume the key event natively).
  // Uses the VolumeKeyModule native Kotlin module injected via withVolumeKeys.js.
  useEffect(() => {
    if (!volumeKeyEmitter) return;
    const sub = volumeKeyEmitter.addListener("VolumeKeyPressed", () => {
      // Dismiss overlay and reset inactivity timer — amoledActive check is
      // implicit: resetInactivityTimer() always sets amoledActive = false.
      resetInactivityTimer();
    });
    return () => sub.remove();
  }, [resetInactivityTimer]);

  const handleOrbPress = useCallback(async () => {
    if (!isSessionActive) {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await startSession();
    } else if (status === "speaking") {
      // Interrupt the AI mid-response and start listening immediately
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await interruptSpeaking();
    } else {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await stopSession();
    }
  }, [isSessionActive, status, startSession, stopSession, interruptSpeaking]);

  const webTopPad = Platform.OS === "web" ? 67 : 0;
  const webBotPad = Platform.OS === "web" ? 34 : 0;

  const renderItem = ({ item }: { item: ChatMessage }) => (
    <MessageBubble message={item} />
  );

  const reversedMessages = [...messages].reverse();

  const statusLabel = isSessionActive
    ? STATUS_LABELS[status]
    : "Toca para comenzar";

  const hintText = !isSessionActive
    ? " "
    : status === "speaking"
    ? "Habla o toca para interrumpir"
    : status === "waiting"
    ? "Habla para continuar o toca para terminar"
    : "Toca para terminar";

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
      onTouchStart={resetInactivityTimer}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {isBluetoothActive && (
            <View style={styles.btBadge}>
              <Feather name="bluetooth" size={12} color={colors.primary} />
              <Text style={[styles.btText, { color: colors.primary }]}>BT</Text>
            </View>
          )}
          {isSessionActive && (
            <View style={[styles.liveBadge, { backgroundColor: "rgba(34, 197, 94, 0.15)" }]}>
              <View style={styles.liveDot} />
              <Text style={[styles.liveText, { color: "#22c55e" }]}>EN VIVO</Text>
            </View>
          )}
        </View>
        <Pressable
          style={styles.settingsBtn}
          onPress={() => router.push("/settings")}
          testID="settings-button"
        >
          <Feather name="settings" size={22} color={colors.mutedForeground} />
        </Pressable>
      </View>

      <View style={styles.listWrapper}>
        <FlatList
          ref={listRef}
          data={reversedMessages}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          inverted
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          scrollEnabled={!!reversedMessages.length}
          style={styles.list}
        />
        {reversedMessages.length === 0 && (
          <View style={styles.emptyState} pointerEvents="none">
            <Feather name="mic" size={28} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Toca el botón para iniciar{"\n"}una conversación
            </Text>
          </View>
        )}
      </View>

      <View style={styles.orbArea}>
        <Text style={[styles.statusLabel, { color: colors.mutedForeground }]}>
          {statusLabel}
        </Text>

        <Pressable
          onPress={handleOrbPress}
          style={({ pressed }) => [
            styles.orbWrapper,
            pressed && styles.orbPressed,
          ]}
          testID="voice-orb"
        >
          <VoiceOrb status={isSessionActive ? status : "idle"} size={100} />
        </Pressable>

        <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
          {hintText}
        </Text>
      </View>

      {Platform.OS !== "web" && (
        <View style={styles.debugBar}>
          <Text style={styles.debugText}>{debugInfo}</Text>
        </View>
      )}

      {/* ── AMOLED "Modo Bolsillo" overlay ──────────────────────────────────
          Full-screen pure-black View that appears after 20 s of inactivity.
          AMOLED pixels emit zero light at #000000 → near-zero battery draw.
          The screen stays physically ON (useKeepAwake) so the OS never kills
          the JS thread — the voice loop keeps running underneath.
          Tap anywhere to dismiss and see the UI again.
      ─────────────────────────────────────────────────────────────────────── */}
      {amoledActive && Platform.OS !== "web" && (
        <TouchableWithoutFeedback onPress={resetInactivityTimer}>
          <View style={styles.amoledOverlay}>
            <StatusBar hidden />
            {isSessionActive && (
              <View style={styles.amoledPill}>
                <View style={[styles.amoledDot, { backgroundColor: status === "speaking" ? "#4f6ef7" : status === "recording" ? "#22c55e" : "#666" }]} />
                <Text style={styles.amoledLabel}>
                  {status === "speaking" ? "Respondiendo" : status === "recording" ? "Escuchando" : status === "processing" ? "Pensando" : "En espera"}
                </Text>
              </View>
            )}
            <Text style={styles.amoledHint}>Toca para ver</Text>
          </View>
        </TouchableWithoutFeedback>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  btBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: "rgba(79, 110, 247, 0.12)",
  },
  btText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
  },
  liveBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#22c55e",
  },
  liveText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.8,
  },
  settingsBtn: { padding: 8 },
  listWrapper: { flex: 1 },
  list: { flex: 1 },
  listContent: {
    paddingVertical: 8,
    flexGrow: 1,
    justifyContent: "flex-end",
  },
  emptyState: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyText: {
    textAlign: "center",
    fontSize: 15,
    lineHeight: 22,
    fontFamily: "Inter_400Regular",
  },
  orbArea: {
    alignItems: "center",
    paddingBottom: 16,
    paddingTop: 8,
    gap: 8,
  },
  statusLabel: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    letterSpacing: 0.3,
  },
  orbWrapper: { padding: 8 },
  orbPressed: { transform: [{ scale: 0.96 }] },
  hintText: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    height: 18,
  },
  debugBar: {
    backgroundColor: "rgba(0,0,0,0.7)",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  debugText: {
    color: "#aaa",
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  // ── AMOLED overlay styles ──────────────────────────────────────────────────
  amoledOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#000000",
    zIndex: 999,
    alignItems: "center",
    justifyContent: "flex-end",
    paddingBottom: 48,
  },
  amoledPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  amoledDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  amoledLabel: {
    color: "rgba(255,255,255,0.35)",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  amoledHint: {
    color: "rgba(255,255,255,0.15)",
    fontSize: 12,
    fontFamily: "Inter_400Regular",
  },
});
