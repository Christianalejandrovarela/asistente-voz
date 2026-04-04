import React, { useCallback, useRef } from "react";
import {
  FlatList,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { VoiceOrb } from "@/components/VoiceOrb";
import { MessageBubble } from "@/components/MessageBubble";
import { AssistantStatus, ChatMessage, useAssistant } from "@/context/AssistantContext";
import { useColors } from "@/hooks/useColors";

const STATUS_LABELS: Record<AssistantStatus, string> = {
  idle: "Iniciando...",
  recording: "Escuchando...",
  processing: "Pensando...",
  speaking: "Respondiendo...",
};

export default function MainScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { status, isSessionActive, messages, isBluetoothActive, debugInfo, startSession, stopSession, interruptSpeaking } = useAssistant();
  const listRef = useRef<FlatList>(null);

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
    ? "Toca para interrumpir"
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
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Feather name="mic" size={28} color={colors.mutedForeground} />
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              Toca el botón para iniciar{"\n"}una conversación
            </Text>
          </View>
        }
      />

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
  list: { flex: 1 },
  listContent: {
    paddingVertical: 8,
    flexGrow: 1,
    justifyContent: "flex-end",
  },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingVertical: 60,
    paddingHorizontal: 40,
    transform: [{ scaleY: -1 }],
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
});
