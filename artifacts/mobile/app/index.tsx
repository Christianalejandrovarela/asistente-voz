import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FlatList,
  Modal,
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
import * as NavigationBar from "expo-navigation-bar";
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

  // ── Navigation bar + status bar: hide entirely in Modo Bolsillo ─────────────
  // AMOLED pixels: pure #000000 = 0 W emission.  Any lit pixel (white nav bar,
  // status icons, UI text) wastes power.  We use React Native's Modal with
  // statusBarTranslucent to cover the status bar area, and expo-navigation-bar
  // to hide the Android system nav bar entirely.
  // Restoration runs synchronously when the overlay dismisses so the user can
  // navigate normally immediately after.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (amoledActive) {
      // Full immersive: hide the system nav bar (bottom edge).
      // "overlay-swipe" = one swipe from bottom edge re-shows it momentarily.
      void NavigationBar.setVisibilityAsync("hidden");
      void NavigationBar.setBehaviorAsync("overlay-swipe");
    } else {
      void NavigationBar.setVisibilityAsync("visible");
    }
  }, [amoledActive]);

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
          A React Native Modal with statusBarTranslucent={true} draws from
          pixel (0,0) of the physical screen, overriding both the status bar
          area and the safe area insets — nothing is clipped.
          backgroundColor: '#000000' = AMOLED pixels off = ~0 W.
          NO text, NO icons, NO status indicators inside: any lit pixel costs
          battery. Pure black silence.
          The navigation bar is hidden separately via expo-navigation-bar
          (see useEffect above).  It's restored when the overlay dismisses.
          Tap anywhere (or press a volume key) to exit.
      ─────────────────────────────────────────────────────────────────────── */}
      <Modal
        visible={amoledActive && Platform.OS !== "web"}
        transparent
        statusBarTranslucent
        animationType="none"
        onRequestClose={resetInactivityTimer}
      >
        {/* StatusBar hidden=true removes the top status bar icons + background. */}
        <StatusBar hidden translucent backgroundColor="transparent" />
        <TouchableWithoutFeedback onPress={resetInactivityTimer}>
          {/* flex:1 fills the entire Modal viewport = full physical screen */}
          <View style={styles.amoledOverlay} />
        </TouchableWithoutFeedback>
      </Modal>
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
  // ── AMOLED overlay style ───────────────────────────────────────────────────
  // flex:1 fills the entire Modal viewport (= full physical screen because
  // the Modal uses statusBarTranslucent and draws edge-to-edge).
  // backgroundColor '#000000' = AMOLED pixels completely off.
  // No content, no text, no indicators: absolute darkness.
  amoledOverlay: {
    flex: 1,
    backgroundColor: "#000000",
  },
});
