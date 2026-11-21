import { Platform } from "react-native";

// HydroOS dark-green palette, shared by the dashboard and the login screen
export const COLORS = {
  background: "#080d08",
  card: "#0f1a0f",
  border: "#1a2e1a",
  foreground: "#e2f0e2",
  mutedForeground: "#6b8f6b",
  secondary: "#132213",
  primary: "#4ade80",
  primaryForeground: "#08130a",
  danger: "#f87171",
  orange: "#fb923c",
  warning: "#facc15",
  blue: "#60a5fa",
  yellow: "#fbbf24",
  lightGreen: "#86efac",
};

export const MONO_FONT = Platform.select({ ios: "Courier", android: "monospace", default: "monospace" });
