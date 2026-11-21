/**
 * Where the app finds the oneM2M CSE. Defaults come from app.json → expo.extra.onem2m; the user
 * can override them in the app (the Pi's LAN address changes between networks), and overrides
 * are kept on the phone.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import { Platform } from "react-native";

import type { OneM2MSettings } from "./client";

const STORAGE_KEY = "onem2m.settings";
// Accepted only by the local test ACME; never valid on a real Pi
const LOCAL_TEST_TOKEN = "app-test-token";

export function defaultSettings(): OneM2MSettings {
  const extra = (Constants.expoConfig?.extra as any)?.onem2m ?? {};
  const settings: OneM2MSettings = {
    cseUrl: extra.cseUrl ?? "http://192.168.1.50:8080",
    cseRn: extra.cseRn ?? "cse-hydropi",
    originator: extra.originator ?? "CHydroOS-app",
    token: extra.token ?? "",
  };
  // Local testing without a Pi: the web dev build defaults to an ACME on the same machine, with
  // the local test token (see HydroponicPiLogic_onem2m/docs/onem2m.md). Kept in code rather than
  // app.json because Metro caches the app config. Release builds and phones keep the defaults above.
  if (__DEV__ && Platform.OS === "web" && typeof window !== "undefined") {
    settings.cseUrl = `http://${window.location.hostname}:8080`;
    settings.token = settings.token || LOCAL_TEST_TOKEN;
  }
  return settings;
}

export async function loadSettings(): Promise<OneM2MSettings> {
  const defaults = defaultSettings();
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
  } catch {
    return defaults;
  }
}

export async function saveSettings(settings: OneM2MSettings): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
