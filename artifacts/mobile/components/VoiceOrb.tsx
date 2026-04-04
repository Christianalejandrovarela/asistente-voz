import React, { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { useColors } from "@/hooks/useColors";
import { AssistantStatus } from "@/context/AssistantContext";

interface VoiceOrbProps {
  status: AssistantStatus;
  size?: number;
}

export function VoiceOrb({ status, size = 160 }: VoiceOrbProps) {
  const colors = useColors();

  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const ring1Scale = useRef(new Animated.Value(1)).current;
  const ring1Opacity = useRef(new Animated.Value(0)).current;
  const ring2Scale = useRef(new Animated.Value(1)).current;
  const ring2Opacity = useRef(new Animated.Value(0)).current;

  const animsRef = useRef<Animated.CompositeAnimation[]>([]);

  useEffect(() => {
    animsRef.current.forEach((a) => a.stop());
    animsRef.current = [];

    if (status === "idle") {
      scale.setValue(1);
      opacity.setValue(1);
      ring1Opacity.setValue(0);
      ring2Opacity.setValue(0);

      const anim = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.03, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(scale, { toValue: 0.97, duration: 2000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      );
      animsRef.current.push(anim);
      anim.start();
    } else if (status === "recording") {
      opacity.setValue(1);
      const scaleAnim = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.08, duration: 400, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(scale, { toValue: 0.95, duration: 400, easing: Easing.in(Easing.ease), useNativeDriver: true }),
        ])
      );
      const r1s = Animated.loop(
        Animated.sequence([
          Animated.timing(ring1Scale, { toValue: 1.5, duration: 800, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(ring1Scale, { toValue: 1, duration: 0, useNativeDriver: true }),
        ])
      );
      const r1o = Animated.loop(
        Animated.sequence([
          Animated.timing(ring1Opacity, { toValue: 0.4, duration: 200, useNativeDriver: true }),
          Animated.timing(ring1Opacity, { toValue: 0, duration: 600, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        ])
      );
      const r2s = Animated.loop(
        Animated.sequence([
          Animated.timing(ring2Scale, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(ring2Scale, { toValue: 1.8, duration: 800, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(ring2Scale, { toValue: 1, duration: 0, useNativeDriver: true }),
        ])
      );
      const r2o = Animated.loop(
        Animated.sequence([
          Animated.timing(ring2Opacity, { toValue: 0, duration: 400, useNativeDriver: true }),
          Animated.timing(ring2Opacity, { toValue: 0.25, duration: 200, useNativeDriver: true }),
          Animated.timing(ring2Opacity, { toValue: 0, duration: 600, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        ])
      );
      animsRef.current.push(scaleAnim, r1s, r1o, r2s, r2o);
      [scaleAnim, r1s, r1o, r2s, r2o].forEach((a) => a.start());
    } else if (status === "processing") {
      ring1Opacity.setValue(0);
      ring2Opacity.setValue(0);
      const scaleAnim = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.05, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(scale, { toValue: 0.95, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ])
      );
      const opacityAnim = Animated.loop(
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.7, duration: 600, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      );
      animsRef.current.push(scaleAnim, opacityAnim);
      scaleAnim.start();
      opacityAnim.start();
    } else if (status === "speaking") {
      opacity.setValue(1);
      const scaleAnim = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.1, duration: 300, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(scale, { toValue: 0.98, duration: 300, easing: Easing.in(Easing.ease), useNativeDriver: true }),
        ])
      );
      const r1s = Animated.loop(
        Animated.sequence([
          Animated.timing(ring1Scale, { toValue: 1.6, duration: 600, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(ring1Scale, { toValue: 1, duration: 0, useNativeDriver: true }),
        ])
      );
      const r1o = Animated.loop(
        Animated.sequence([
          Animated.timing(ring1Opacity, { toValue: 0.3, duration: 100, useNativeDriver: true }),
          Animated.timing(ring1Opacity, { toValue: 0, duration: 500, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        ])
      );
      const r2s = Animated.loop(
        Animated.sequence([
          Animated.timing(ring2Scale, { toValue: 2.2, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          Animated.timing(ring2Scale, { toValue: 1, duration: 0, useNativeDriver: true }),
        ])
      );
      const r2o = Animated.loop(
        Animated.sequence([
          Animated.timing(ring2Opacity, { toValue: 0.15, duration: 150, useNativeDriver: true }),
          Animated.timing(ring2Opacity, { toValue: 0, duration: 750, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        ])
      );
      animsRef.current.push(scaleAnim, r1s, r1o, r2s, r2o);
      [scaleAnim, r1s, r1o, r2s, r2o].forEach((a) => a.start());
    }

    return () => {
      animsRef.current.forEach((a) => a.stop());
      animsRef.current = [];
    };
  }, [status]);

  const getOrbColor = () => {
    switch (status) {
      case "recording": return "#ef4444";
      case "processing": return "#f59e0b";
      case "speaking": return "#10b981";
      default: return colors.primary;
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
            transform: [{ scale: ring2Scale }],
            opacity: ring2Opacity,
          },
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
            transform: [{ scale: ring1Scale }],
            opacity: ring1Opacity,
          },
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
            transform: [{ scale }],
            opacity,
          },
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
