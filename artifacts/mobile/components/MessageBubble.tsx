import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";
import { ChatMessage } from "@/context/AssistantContext";

interface MessageBubbleProps {
  message: ChatMessage;
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const colors = useColors();
  const isUser = message.role === "user";

  return (
    <View style={[styles.container, isUser ? styles.userContainer : styles.assistantContainer]}>
      {!isUser && (
        <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
          <Feather name="cpu" size={14} color="#fff" />
        </View>
      )}
      <View
        style={[
          styles.bubble,
          isUser
            ? [styles.userBubble, { backgroundColor: colors.primary }]
            : [styles.assistantBubble, { backgroundColor: colors.card, borderColor: colors.border }],
        ]}
      >
        <Text
          style={[
            styles.text,
            isUser
              ? { color: colors.primaryForeground }
              : { color: colors.cardForeground },
          ]}
        >
          {message.text}
        </Text>
        <Text
          style={[
            styles.time,
            isUser
              ? { color: "rgba(255,255,255,0.6)" }
              : { color: colors.mutedForeground },
          ]}
        >
          {formatTime(message.timestamp)}
        </Text>
      </View>
      {isUser && (
        <View style={[styles.avatar, { backgroundColor: colors.secondary }]}>
          <Feather name="mic" size={14} color={colors.primary} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginVertical: 4,
    paddingHorizontal: 16,
    gap: 8,
  },
  userContainer: {
    justifyContent: "flex-end",
  },
  assistantContainer: {
    justifyContent: "flex-start",
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  bubble: {
    maxWidth: "75%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
    gap: 4,
  },
  userBubble: {
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    borderWidth: 1,
    borderBottomLeftRadius: 4,
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
    fontFamily: "Inter_400Regular",
  },
  time: {
    fontSize: 11,
    alignSelf: "flex-end",
    fontFamily: "Inter_400Regular",
  },
});
