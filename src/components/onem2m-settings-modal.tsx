import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";

import { COLORS, MONO_FONT } from "@/constants/hydro-colors";
import type { OneM2MSettings } from "@/onem2m/client";

// Edit where the app finds the oneM2M CSE: the Pi's address changes between networks.
// Render it only while open, so each opening starts from the current settings.
export default function OneM2MSettingsModal({
  visible,
  settings,
  onSave,
  onClose,
}: {
  visible: boolean;
  settings: OneM2MSettings;
  onSave: (s: OneM2MSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);

  const field = (label: string, key: keyof OneM2MSettings, hint: string, secure = false) => (
    <View>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={draft[key]}
        onChangeText={(t) => setDraft((d) => ({ ...d, [key]: t.trim() }))}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        placeholder={hint}
        placeholderTextColor={COLORS.mutedForeground}
        style={styles.input}
      />
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>oneM2M settings</Text>
          <Text style={styles.subtitle}>Where to read sensor data from (the Pi&apos;s CSE)</Text>
          {field("CSE address", "cseUrl", "http://192.168.1.50:8080")}
          {field("CSEBase name", "cseRn", "cse-hydropi")}
          {field("Originator", "originator", "CHydroOS-app")}
          {field("Token", "token", "bearer token", true)}
          <View style={styles.row}>
            <TouchableOpacity onPress={onClose} style={[styles.button, styles.cancel]}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => onSave(draft)} style={[styles.button, styles.save]}>
              <Text style={styles.saveText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.6)" },
  sheet: { padding: 20, gap: 4, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderWidth: 1, backgroundColor: COLORS.card, borderColor: COLORS.border },
  title: { fontSize: 18, fontWeight: "300", color: COLORS.primary, fontFamily: MONO_FONT },
  subtitle: { fontSize: 11, color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginBottom: 6 },
  fieldLabel: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginTop: 10, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 10, fontSize: 14, fontFamily: MONO_FONT, color: COLORS.foreground, borderColor: COLORS.border },
  row: { flexDirection: "row", gap: 10, marginTop: 18 },
  button: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: 3 },
  cancel: { borderWidth: 1, borderColor: COLORS.border },
  cancelText: { fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  save: { backgroundColor: COLORS.primary },
  saveText: { fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: COLORS.primaryForeground, fontFamily: MONO_FONT },
});
