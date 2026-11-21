import { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { COLORS, MONO_FONT } from "@/constants/hydro-colors";

// Placeholder login. These credentials ship inside the app, so this is not real
// security. Swap for Supabase Auth when real accounts are needed.
// username → password. Add a line here to add another test user.
const DUMMY_USERS: Record<string, string> = {
  admin: "admin",
  username1: "password1",
};

// onLogin receives the username, which App uses to fetch that user's rows
export default function LoginScreen({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);

  function submit() {
    const user = username.trim();
    if (DUMMY_USERS[user] === password) {
      setError(null);
      onLogin(user);
    } else {
      setError("Incorrect username or password");
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.title}>HydroOS</Text>
        <Text style={styles.subtitle}>Sign in to continue</Text>

        <Text style={styles.fieldLabel}>Username</Text>
        <TextInput
          value={username}
          onChangeText={(t) => { setUsername(t); setError(null); }}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
          placeholder="username"
          placeholderTextColor={COLORS.mutedForeground}
          style={styles.input}
        />

        <Text style={styles.fieldLabel}>Password</Text>
        <TextInput
          ref={passwordRef}
          value={password}
          onChangeText={(t) => { setPassword(t); setError(null); }}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="password"
          returnKeyType="go"
          onSubmitEditing={submit}
          placeholder="password"
          placeholderTextColor={COLORS.mutedForeground}
          style={styles.input}
        />

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity onPress={submit} style={styles.button}>
          <Text style={styles.buttonText}>Sign in</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: COLORS.background },
  card: { borderRadius: 4, padding: 20, borderWidth: 1, backgroundColor: COLORS.card, borderColor: COLORS.border },
  title: { fontSize: 22, fontWeight: "300", letterSpacing: 2, color: COLORS.primary, fontFamily: MONO_FONT, marginBottom: 4 },
  subtitle: { fontSize: 11, color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  fieldLabel: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginTop: 10, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 10, fontSize: 14, fontFamily: MONO_FONT, color: COLORS.foreground, borderColor: COLORS.border },
  error: { fontSize: 11, color: COLORS.danger, fontFamily: MONO_FONT, marginTop: 10 },
  button: { alignItems: "center", justifyContent: "center", marginTop: 18, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 3, backgroundColor: COLORS.primary },
  buttonText: { fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: COLORS.primaryForeground, fontFamily: MONO_FONT },
});
