import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useColors } from "@/hooks/useColors";
import { AssistantStatus } from "@/context/AssistantContext";

interface VoiceOrbProps {
  status: AssistantStatus;
  size?: number;
}

export function VoiceOrb({ status, size = 160 }: VoiceOrbProps) {
  const colors = useColors();
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  const ring1Scale = useSharedValue(1);
  const ring1Opacity = useSharedValue(0);
  const ring2Scale = useSharedValue(1);
  const ring2Opacity = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(scale);
    cancelAnimation(opacity);
    cancelAnimation(ring1Scale);
    cancelAnimation(ring1Opacity);
    cancelAnimation(ring2Scale);
    cancelAnimation(ring2Opacity);

    if (status === "idle") {
      scale.value = withRepeat(
        withSequence(
          withTiming(1.03, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.97, { duration: 2000, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      );
      opacity.value = 1;
      ring1Opacity.value = 0;
      ring2Opacity.value = 0;
    } else if (status === "recording") {
      scale.value = withRepeat(
        withSequence(
          withTiming(1.08, { duration: 400, easing: Easing.out(Easing.ease) }),
          withTiming(0.95, { duration: 400, easing: Easing.in(Easing.ease) })
        ),
        -1,
        true
      );
      ring1Scale.value = withRepeat(
        withSequence(
          withTiming(1.5, { duration: 800, easing: Easing.out(Easing.ease) }),
          withTiming(1, { duration: 0 })
        ),
        -1
      );
      ring1Opacity.value = withRepeat(
        withSequence(
          withTiming(0.4, { duration: 200 }),
          withTiming(0, { duration: 600, easing: Easing.out(Easing.ease) })
        ),
        -1
      );
      ring2Scale.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 400 }),
          withTiming(1.8, { duration: 800, easing: Easing.out(Easing.ease) }),
          withTiming(1, { duration: 0 })
        ),
        -1
      );
      ring2Opacity.value = withRepeat(
        withSequence(
          withTiming(0, { duration: 400 }),
          withTiming(0.25, { duration: 200 }),
          withTiming(0, { duration: 600, easing: Easing.out(Easing.ease) })
        ),
        -1
      );
    } else if (status === "processing") {
      scale.value = withRepeat(
        withSequence(
          withTiming(1.05, { duration: 600, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.95, { duration: 600, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      );
      opacity.value = withRepeat(
        withSequence(
          withTiming(0.7, { duration: 600 }),
          withTiming(1, { duration: 600 })
        ),
        -1,
        true
      );
      ring1Opacity.value = 0;
      ring2Opacity.value = 0;
    } else if (status === "speaking") {
      scale.value = withRepeat(
        withSequence(
          withTiming(1.1, { duration: 300, easing: Easing.out(Easing.ease) }),
          withTiming(0.98, { duration: 300, easing: Easing.in(Easing.ease) })
        ),
        -1,
        true
      );
      ring1Scale.value = withRepeat(
        withSequence(
          withTiming(1.6, { duration: 600, easing: Easing.out(Easing.ease) }),
          withTiming(1, { duration: 0 })
        ),
        -1
      );
      ring1Opacity.value = withRepeat(
        withSequence(
          withTiming(0.3, { duration: 100 }),
          withTiming(0, { duration: 500, easing: Easing.out(Easing.ease) })
        ),
        -1
      );
      ring2Scale.value = withRepeat(
        withSequence(
          withTiming(2.2, { duration: 900, easing: Easing.out(Easing.ease) }),
          withTiming(1, { duration: 0 })
        ),
        -1
      );
      ring2Opacity.value = withRepeat(
        withSequence(
          withTiming(0.15, { duration: 150 }),
          withTiming(0, { duration: 750, easing: Easing.out(Easing.ease) })
        ),
        -1
      );
    }
  }, [status]);

  const orbStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const ring1Style = useAnimatedStyle(() => ({
    transform: [{ scale: ring1Scale.value }],
    opacity: ring1Opacity.value,
  }));

  const ring2Style = useAnimatedStyle(() => ({
    transform: [{ scale: ring2Scale.value }],
    opacity: ring2Opacity.value,
  }));

  const getOrbColor = () => {
    switch (status) {
      case "recording":
        return "#ef4444";
      case "processing":
        return "#f59e0b";
      case "speaking":
        return "#10b981";
      default:
        return colors.primary;
    }
  };

  const orbColor = getOrbColor();

  return (
    <View style={[styles.container, { width: size * 2.5, height: size * 2.5 }]}>
      <Animated.View
        style={[
          styles.ring,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: orbColor,
          },
          ring2Style,
        ]}
      />
      <Animated.View
        style={[
          styles.ring,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: orbColor,
          },
          ring1Style,
        ]}
      />
      <Animated.View
        style={[
          styles.orb,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: orbColor,
            shadowColor: orbColor,
          },
          orbStyle,
        ]}
      >
        <View
          style={[
            styles.innerGlow,
            {
              width: size * 0.6,
              height: size * 0.6,
              borderRadius: size * 0.3,
              backgroundColor: "rgba(255,255,255,0.15)",
            },
          ]}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
  },
  orb: {
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 30,
    elevation: 10,
  },
  innerGlow: {
    position: "absolute",
    top: "20%",
    left: "20%",
  },
});
