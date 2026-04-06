import { router, Stack } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";

/**
 * Any unmatched route (e.g. notification deep-link "mobile://") silently redirects
 * to the main screen so the user never sees a dead-end error page.
 */
export default function NotFoundScreen() {
  useEffect(() => {
    router.replace("/");
  }, []);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={{ flex: 1 }} />
    </>
  );
}
