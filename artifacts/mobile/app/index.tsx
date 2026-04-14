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

// Native volume-key emitter (Android only — native build).
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

// Auto-timeout: seconds of inactivity before Modo Bolsillo activates automatically.
const AMOLED_TIMEOUT_MS = 20_000;

export default function MainScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { status, isSessionActive, messages, isBluetoothActive, debugInfo, startSession, stopSession, interruptSpeaking } = useAssistant();
  const listRef = useRef<FlatList>(null);

  // ── Modo Bolsillo state ─────────────────────────────────────────────────────
  const [amoledActive, setAmoledActive] = useState(false);
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── ACTIVATE: button press OR auto-timeout ──────────────────────────────────
  const activatePocketMode = useCallback(() => {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    setAmoledActive(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
  }, []);

  // ── EXIT: volume button OR 3-second long press (ONLY these two paths) ───────
  const exitPocketMode = useCallback(() => {
    setAmoledActive(false);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Restart the auto-timeout after exiting.
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(activatePocketMode, AMOLED_TIMEOUT_MS);
  }, [activatePocketMode]);

  // Auto-timeout: start on mount, restart whenever the user touches the main UI.
  const resetAutoTimeout = useCallback(() => {
    if (amoledActive) return; // Do not reset while in pocket mode.
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    inactivityTimer.current = setTimeout(activatePocketMode, AMOLED_TIMEOUT_MS);
  }, [amoledActive, activatePocketMode]);

  useEffect(() => {
    resetAutoTimeout();
    return () => {
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Volume keys → EXIT Modo Bolsillo ────────────────────────────────────────
  useEffect(() => {
    if (!volumeKeyEmitter) return;
    const sub = volumeKeyEmitter.addListener("VolumeKeyPressed", exitPocketMode);
    return () => sub.remove();
  }, [exitPocketMode]);

  // ── Navigation bar: hide in Modo Bolsillo, restore on exit ──────────────────
  // expo-navigation-bar controls the Android system bottom bar.
  // "overlay-swipe" means a brief swipe shows it momentarily then re-hides.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (amoledActive) {
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

  const statusLabel = isSessionActive ? STATUS_LABELS[status] : "Toca para comenzar";

  const hintText = !isSessionActive
    ? " "
    : status === "speaking"
    ? "Habla o toca para interrumpir"
    : status === "waiting"
    ? "Habla para continuar o toca para terminar"
    : "Toca para terminar";

  return (
    // ── ROOT view: fills the FULL physical screen ─────────────────────────────
    // With androidStatusBar.translucent=true in app.json, this View starts at
    // pixel (0,0) of the screen — underneath the status bar.  That means the
    // absolute-positioned AMOLED overlay below can cover EVERYTHING.
    <View style={styles.root} onTouchStart={resetAutoTimeout}>

      {/* Normal status bar — hidden when Modo Bolsillo is active */}
      <StatusBar
        translucent
        barStyle="light-content"
        backgroundColor="transparent"
        hidden={amoledActive}
      />

      {/* ── Main UI (safe-area insets applied here, not on root) ──────────── */}
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
        {/* Header */}
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

        {/* Message list */}
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

        {/* Orb area */}
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

        {/* ── ACTIVAR MODO BOLSILLO button ──────────────────────────────────
            REGLA 1: Botón grande y visible en la pantalla principal normal.
            Fondo rojo (#dc2626), texto blanco, tamaño generoso.
            Al presionarlo activa el overlay negro inmediatamente.
        ──────────────────────────────────────────────────────────────────── */}
        {Platform.OS !== "web" && (
          <Pressable
            style={({ pressed }) => [
              styles.pocketBtn,
              pressed && styles.pocketBtnPressed,
            ]}
            onPress={activatePocketMode}
            testID="pocket-mode-button"
          >
            <Feather name="moon" size={20} color="#fff" />
            <Text style={styles.pocketBtnText}>ACTIVAR MODO BOLSILLO</Text>
          </Pressable>
        )}

        {Platform.OS !== "web" && (
          <View style={styles.debugBar}>
            <Text style={styles.debugText}>{debugInfo}</Text>
          </View>
        )}
      </View>

      {/* ══════════════════════════════════════════════════════════════════════
          REGLA 2 — OSCURIDAD ABSOLUTA
          position:'absolute' con top/bottom/left/right=0 cubre el FULL screen
          porque el root View ya se extiende bajo la status bar (translucent).
          zIndex:9999 garantiza que queda por encima de TODO el UI.
          backgroundColor:'#000000' = píxeles AMOLED completamente apagados.
          NO hay NI UN SOLO elemento visible dentro — cero texto, cero íconos.

          REGLA 3 — DOS SALIDAS
          A) Botón físico de volumen → exitPocketMode() (listener arriba).
          B) onLongPress con delayLongPress={3000} → 3 segundos de presión
             continua para salir. Los toques rápidos son ignorados (sin onPress).
      ══════════════════════════════════════════════════════════════════════ */}
      {amoledActive && Platform.OS !== "web" && (
        <Pressable
          style={styles.amoledOverlay}
          onLongPress={exitPocketMode}
          delayLongPress={3000}
          android_disableSound
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Root fills full physical screen (translucent status bar in app.json).
  root: {
    flex: 1,
  },
  // Inner container carries safe-area padding so UI content is never clipped.
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
  // ── ACTIVAR MODO BOLSILLO button ──────────────────────────────────────────
  pocketBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginHorizontal: 20,
    marginBottom: 12,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: "#dc2626",
  },
  pocketBtnPressed: {
    backgroundColor: "#b91c1c",
    transform: [{ scale: 0.97 }],
  },
  pocketBtnText: {
    color: "#ffffff",
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.5,
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
  // ── AMOLED OVERLAY — REGLA 2 ─────────────────────────────────────────────
  // position:'absolute' + 0,0,0,0 + zIndex:9999 = cubre TODO, incluyendo
  // la status bar (root View es translucent).  #000000 = cero emisión AMOLED.
  amoledOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    backgroundColor: "#000000",
  },
});
