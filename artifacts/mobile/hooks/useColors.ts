import colors from "@/constants/colors";

/**
 * Returns the dark design tokens for the Voice AI Assistant.
 * This app uses a dark-first design (dark navy background, electric indigo accent).
 */
export function useColors() {
  return { ...colors.dark, radius: colors.radius };
}
