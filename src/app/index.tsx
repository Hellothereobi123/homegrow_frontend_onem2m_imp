/**
 * HydroOS — React Native conversion
 * ----------------------------------
 * Converted from a web React/TSX dashboard (Tailwind + recharts) to
 * React Native. Notes on what changed:
 *
 * 1. Charts: recharts isn't available in RN. Replaced with a small
 *    self-contained SVG line chart (`SimpleLineChart`) built on
 *    `react-native-svg`. It supports the same "reference line" bands
 *    used for optimal-range indicators, but drops recharts' interactive
 *    hover tooltip (RN has no mouse hover; a tap-to-inspect tooltip
 *    could be added later with react-native-svg + gesture handling).
 *
 * 2. Layout: Tailwind `className` styling is replaced with
 *    `StyleSheet.create` + a plain color-constants object (RN has no
 *    CSS variables). The desktop-only sidebar layout was dropped —
 *    this version is mobile-first and always uses the bottom tab bar
 *    (matches the original's `sm:hidden` mobile experience).
 *
 * 3. Inputs: `<input type="range">` → `@react-native-community/slider`.
 *    `<select>` → `@react-native-picker/picker`. `<input type="number">`
 *    → `TextInput` with `keyboardType="numeric"`.
 *
 * 4. Modals: the bottom-sheet `<div>` overlays became RN `<Modal>`
 *    with `animationType="slide"` and a semi-transparent backdrop.
 *
 * 5. Images: `<img>` → RN `<Image source={{ uri }} />`.
 *
 * Required dependencies (install in your RN project):
 *   npm install react-native-svg @react-native-community/slider @react-native-picker/picker
 *
 * This file assumes React Native >= 0.71 (uses the flexbox `gap`
 * style property). If you're on an older RN version, replace `gap`
 * usages in the StyleSheet with explicit margins.
 *
 * For real device deployment you may also want `react-native-safe-area-context`
 * to handle notches/status bars — omitted here to keep the file dependency-light.
 */

import Slider from "@react-native-community/slider";
import { Picker } from "@react-native-picker/picker";
import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Button,
  Image,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import Svg, { Path, Line as SvgLine } from "react-native-svg";

import { bleAvailable, ensureBleReady, fetchRowsOverBle, scanForPis, type BleTransfer, type PiDevice } from "@/ble/pi-ble";
import LoginScreen from "@/components/login-screen";
import OneM2MSettingsModal from "@/components/onem2m-settings-modal";
import { fetchAllRecentRecords, fetchLatestVision, findSystemAE, requestFromPi, type OneM2MSettings } from "@/onem2m/client";
import { defaultSettings, loadSettings, saveSettings } from "@/onem2m/settings";
import { COLORS, MONO_FONT } from "@/constants/hydro-colors";

// ─── Types ───────────────────────────────────────────────────────────────────

// One sensor reading. Missing values are NaN and display as "—".
interface SensorReading {
  timestamp: number; // time of recording (ms since epoch)
  ph: number;
  temperature: number; // air temperature, °C
  lightLux: number; // light intensity, lux
  ec: number; // mS/cm
  humidity: number; // % RH
  co2: number; // CO₂ concentration, ppm
  waterTemp: number; // water temperature, °C
  waterPresent: boolean | null; // water at the low-level sensor; false = level too low, null = no reading
  system: string | null; // which growing system the row belongs to; null = not tagged
}

interface PlantImage {
  id: string;
  timestamp: number;
  url: string;
  analysis: string;
}

interface SystemState {
  phTarget: number;
  lightIntensity: number;
  lightOn: boolean;
  connected: boolean;
  lastSync: number;
  syncSource?: "cloud" | "ble";
  bleStale?: boolean; // Pi said its sensor loop has stalled (sensors_ok: false)
}

type CropType = "Lettuce" | "Basil" | "Spinach" | "Tomato" | "Strawberry" | "Kale" | "Arugula" | "Mint";

// Systems are built from the data: one per distinct sensor_readings.system_name. Crop, location
// and tiers are only known when the user adds them with "Add System".
interface HydroSystem {
  id: string;
  name: string; // matches sensor_readings.system_name
  crop?: CropType;
  location?: string;
  tiers?: number;
  addedAt: number; // first reading, or when the user added it
  manual?: boolean; // added or labelled by the user rather than only found in the data
  readings: SensorReading[];
  system: SystemState;
}

// ─── Mock data generators ─────────────────────────────────────────────────────
// This build reads from the Pi's oneM2M CSE (see src/onem2m), not Supabase.

const MAX_READINGS = 120; // readings kept per system
// Window fetched from each system's timeSeries: a little over MAX_READINGS 30 s cycles
const FETCH_WINDOW_MS = 70 * 60 * 1000;
const REFRESH_INTERVAL_MS = 60 * 1000; // the CSE is on the LAN, so refresh every minute

function parseTimestamp(value: string): number {
  const trimmed = value.replace(/(\.\d{3})\d+/, "$1"); // e.g. .250000 → .250
  const hasZone = /[zZ]$|[+-]\d\d:?\d\d$/.test(trimmed);
  return new Date(hasZone ? trimmed : trimmed + "Z").getTime();
}

// null/undefined means "no reading", shown as "—", rather than 0
function toNum(value: unknown): number {
  return value === null || value === undefined ? NaN : Number(value);
}

// Booleans arrive as true/false; accept 1/0 too in case a row was written as a number.
// undefined (column not created yet) counts as "no reading", like null.
function toBool(value: unknown): boolean | null {
  return value === null || value === undefined ? null : value === true || Number(value) === 1;
}

// Convert a database row into the shape the screens use.
// Property (app) ← column (Supabase sensor_readings)
function rowToReading(row: any): SensorReading {
  return {
    timestamp: parseTimestamp(row.recorded_at), // time of recording ← recorded_at
    humidity: toNum(row.humidity), // humidity ← humidity
    temperature: toNum(row.temperature_c), // air temperature ← temperature_c
    lightLux: toNum(row.light_intensity), // light intensity ← light_intensity
    ec: toNum(row.ec), // ec ← ec
    ph: toNum(row.ph), // ph ← ph
    co2: toNum(row.co2), // CO₂ concentration in ppm ← co2
    waterTemp: toNum(row.water_temp), // water temperature in °C ← water_temp
    waterPresent: toBool(row.water_level), // water at the low-level sensor ← water_level (false = level too low)
    system: typeof row.system_name === "string" && row.system_name.trim() ? row.system_name.trim() : null, // system ← system_name
  };
}

// BLE rows are positional (see ble-protocol.md); zip them with the column names so
// they go through the same rowToReading as Supabase rows. Returned oldest first.
function bleTransferToReadings(transfer: BleTransfer): SensorReading[] {
  return transfer.rows
    .map((values) => rowToReading(Object.fromEntries(transfer.cols.map((c, i) => [c, values[i]]))))
    .filter((r) => Number.isFinite(r.timestamp))
    .reverse();
}

// Add new readings to existing ones, dropping duplicates and keeping time order
function mergeReadings(existing: SensorReading[], incoming: SensorReading[]): SensorReading[] {
  const byTime = new Map(existing.map((r) => [r.timestamp, r]));
  incoming.forEach((r) => byTime.set(r.timestamp, r));
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_READINGS);
}

// ─── Systems from data ───────────────────────────────────────────────────────

// Rows with no system_name (e.g. from a Pi that doesn't tag its rows yet) are grouped here
const UNASSIGNED_SYSTEM = "Unassigned";

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Split readings (oldest first) by system, keeping the newest MAX_READINGS of each
function groupBySystem(readings: SensorReading[]): Map<string, SensorReading[]> {
  const groups = new Map<string, SensorReading[]>();
  for (const r of readings) {
    const name = r.system ?? UNASSIGNED_SYSTEM;
    const key = [...groups.keys()].find((k) => sameName(k, name)) ?? name;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  groups.forEach((rs, key) => groups.set(key, rs.slice(-MAX_READINGS)));
  return groups;
}

const DEFAULT_SYSTEM_STATE: SystemState = { phTarget: 6.2, lightIntensity: 60, lightOn: true, connected: true, lastSync: Date.now() };

// Put each group's readings into the system with that name, creating systems for names not seen
// before. "replace" is for a full cloud fetch; "merge" adds to what a system already has (Bluetooth).
// Names the user removed stay hidden. Systems with no matching group are left as they are.
function applyGroups(
  prev: HydroSystem[],
  groups: Map<string, SensorReading[]>,
  hidden: Set<string>,
  mode: "replace" | "merge",
  state: Partial<SystemState>
): HydroSystem[] {
  const groupFor = (name: string) => [...groups.entries()].find(([k]) => sameName(k, name))?.[1];
  const next = prev.map((s) => {
    const rs = groupFor(s.name);
    if (!rs) return s;
    return { ...s, readings: mode === "replace" ? rs : mergeReadings(s.readings, rs), system: { ...s.system, ...state } };
  });
  const newNames = [...groups.keys()]
    .filter((name) => !hidden.has(name.toLowerCase()) && !next.some((s) => sameName(s.name, name)))
    .sort((a, b) => a.localeCompare(b));
  for (const name of newNames) {
    const rs = groups.get(name)!;
    next.push({
      id: `sys-${name.toLowerCase()}`,
      name,
      addedAt: rs[0]?.timestamp ?? Date.now(),
      readings: rs,
      system: { ...DEFAULT_SYSTEM_STATE, ...state },
    });
  }
  return next;
}

const cropIcon = (hs: HydroSystem) => (hs.crop ? CROP_ICONS[hs.crop] : "🪴");


// Every system the CSE's access policy lets this app see (AEs labelled type:hydropi). Access is
// decided by the Pi's ACP and the token, not the login, so there is no per-user filter here.

// Recent readings across every system, oldest first; split per system by groupBySystem.
// The CSE returns instances in no useful order, so sort by time here.
async function fetchReadings(settings: OneM2MSettings): Promise<SensorReading[]> {
  const records = await fetchAllRecentRecords(settings, FETCH_WINDOW_MS);
  return records
    .map(rowToReading)
    .filter((r) => Number.isFinite(r.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ─── Insights ─────────────────────────────────────────────────────────────────

const INSIGHTS_REFRESH_MS = 10 * 60 * 1000; // camera.py captures every 30 min, so check every 10

interface Insight {
  text: string;
  timestamp: number; // recorded_at of the capture the insight came from
}

// Turns camera.py's metrics (the vision container's latest instance) into a sentence
function visionToInsight(con: any, ct: string): Insight {
  const parts: string[] = [];
  if (Number.isFinite(Number(con?.canopy_cm2))) parts.push(`Canopy ${Number(con.canopy_cm2).toFixed(1)} cm²`);
  if (Number.isFinite(Number(con?.green_percent))) parts.push(`${Number(con.green_percent).toFixed(1)}% green`);
  const status = con?.is_wilting === true ? "Possible wilting detected: check water and nutrients." : "No wilting detected.";
  const fromCt = parseTimestamp(`${ct.slice(0, 4)}-${ct.slice(4, 6)}-${ct.slice(6, 8)}T${ct.slice(9, 11)}:${ct.slice(11, 13)}:${ct.slice(13, 15)}Z`);
  const recorded = con?.recorded_at ? parseTimestamp(con.recorded_at) : NaN;
  return {
    text: `${parts.length ? parts.join(" · ") + ". " : ""}${status}`,
    timestamp: Number.isFinite(recorded) ? recorded : fromCt,
  };
}

// Most recent camera metrics across systems
async function fetchLatestInsight(): Promise<Insight | null> {
  const latest = await fetchLatestVision(await loadSettings());
  return latest ? visionToInsight(latest.con, latest.ct) : null;
}

// Fetches the latest insight on mount, then every INSIGHTS_REFRESH_MS
function useLatestInsight(username: string) {
  const [insight, setInsight] = useState<Insight | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const latest = await fetchLatestInsight();
        if (cancelled) return;
        setInsight(latest);
        setError(null);
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? "Could not load insights");
      }
    }
    load();
    const interval = setInterval(load, INSIGHTS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [username]);

  return { insight, error };
}

const plantImages: PlantImage[] = [
  { id: "1", timestamp: Date.now() - 30 * 60 * 1000, url: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&h=300&fit=crop&auto=format", analysis: "Healthy — no chlorosis detected. Leaf area index: 2.31" },
  { id: "2", timestamp: Date.now() - 60 * 60 * 1000, url: "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=400&h=300&fit=crop&auto=format", analysis: "Normal growth rate. Stem elongation +2.1mm vs prior frame." },
  { id: "3", timestamp: Date.now() - 90 * 60 * 1000, url: "https://images.unsplash.com/photo-1466692476868-aef1dfb1e735?w=400&h=300&fit=crop&auto=format", analysis: "Tip curl detected on lower leaves — monitor pH." },
  { id: "4", timestamp: Date.now() - 120 * 60 * 1000, url: "https://images.unsplash.com/photo-1523348837708-15d4a09cfac2?w=400&h=300&fit=crop&auto=format", analysis: "Root zone temperature nominal. Lateral branching active." },
  { id: "5", timestamp: Date.now() - 150 * 60 * 1000, url: "https://images.unsplash.com/photo-1530836369250-ef72a3f5cda8?w=400&h=300&fit=crop&auto=format", analysis: "Healthy — no deficiency markers. Canopy density stable." },
  { id: "6", timestamp: Date.now() - 180 * 60 * 1000, url: "https://images.unsplash.com/photo-1585336261022-680e295ce3fe?w=400&h=300&fit=crop&auto=format", analysis: "Growth on track. Estimated harvest window: 8 days." },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(val: number, decimals = 2) {
  return Number.isFinite(val) ? val.toFixed(decimals) : "—";
}
function fmtInt(val: number) {
  return Number.isFinite(val) ? Math.round(val).toLocaleString() : "—";
}
function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
// Day and time, for chart axes that span more than a day (e.g. "Nov 16, 09:36 PM")
function fmtDayTime(ts: number) {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtTimeAgo(ts: number) {
  const diff = Math.floor((Date.now() - ts) / 60000);
  if (diff < 1) return "just now";
  if (diff === 1) return "1 min ago";
  return `${diff} min ago`;
}
function phStatus(ph: number): { label: string; color: string } {
  if (!Number.isFinite(ph)) return { label: "NO DATA", color: COLORS.mutedForeground };
  if (ph < 5.5) return { label: "TOO ACIDIC", color: COLORS.danger };
  if (ph > 7.0) return { label: "TOO BASIC", color: COLORS.orange };
  if (ph >= 5.8 && ph <= 6.5) return { label: "OPTIMAL", color: COLORS.primary };
  return { label: "ACCEPTABLE", color: COLORS.warning };
}
// The level sensor sits at the low-water mark: water present there is normal, no water is low.
function waterLevelStatus(waterPresent: boolean | null): { label: string; color: string; value: string } {
  if (waterPresent === null) return { label: "NO DATA", color: COLORS.mutedForeground, value: "—" };
  if (waterPresent) return { label: "OK", color: COLORS.primary, value: "Normal" };
  return { label: "LOW", color: COLORS.danger, value: "Low" };
}
const isLowWater = (r: SensorReading | undefined) => r?.waterPresent === false;
// When the current low-water period began: the earliest reading in the unbroken run of low
// readings that ends at the latest one. null if the latest reading isn't low.
// `readings` is oldest first.
function lowWaterSince(readings: SensorReading[]): number | null {
  let since: number | null = null;
  for (let i = readings.length - 1; i >= 0 && isLowWater(readings[i]); i--) {
    since = readings[i].timestamp;
  }
  return since;
}
function ecStatus(ec: number): { label: string; color: string } {
  if (!Number.isFinite(ec)) return { label: "NO DATA", color: COLORS.mutedForeground };
  if (ec < 0.8) return { label: "TOO LOW", color: COLORS.danger };
  if (ec > 3.0) return { label: "TOO HIGH", color: COLORS.danger };
  if (ec >= 1.2 && ec <= 2.4) return { label: "OPTIMAL", color: COLORS.primary };
  return { label: "ACCEPTABLE", color: COLORS.warning };
}

// ─── SimpleLineChart (SVG-based recharts replacement) ────────────────────────

function SimpleLineChart({
  data,
  color = COLORS.primary,
  refMin,
  refMax,
  height = 60,
  min,
  max,
}: {
  data: number[];
  color?: string;
  refMin?: number;
  refMax?: number;
  height?: number;
  min?: number;
  max?: number;
}) {
  const [width, setWidth] = useState(0);
  const points = data.filter(Number.isFinite); // skip missing readings

  if (points.length < 2) {
    return <View style={{ height }} />;
  }

  const lo = min ?? Math.min(...points, refMin ?? Infinity);
  const hi = max ?? Math.max(...points, refMax ?? -Infinity);
  const range = hi - lo || 1;
  const toY = (v: number) => height - ((v - lo) / range) * height;

  const path =
    width > 0
      ? points
          .map((v, i) => `${i === 0 ? "M" : "L"} ${(i * width) / (points.length - 1)} ${toY(v)}`)
          .join(" ")
      : "";

  return (
    <View style={{ height, width: "100%" }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {width > 0 && (
        <Svg width={width} height={height}>
          {refMin !== undefined && (
            <SvgLine x1={0} y1={toY(refMin)} x2={width} y2={toY(refMin)} stroke={COLORS.danger} strokeDasharray="3,3" strokeWidth={0.8} />
          )}
          {refMax !== undefined && (
            <SvgLine x1={0} y1={toY(refMax)} x2={width} y2={toY(refMax)} stroke={COLORS.danger} strokeDasharray="3,3" strokeWidth={0.8} />
          )}
          <Path d={path} stroke={color} strokeWidth={1.5} fill="none" />
        </Svg>
      )}
    </View>
  );
}

// ─── StatusDot ────────────────────────────────────────────────────────────────

function StatusDot({ connected }: { connected: boolean }) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(0.75)).current;

  useEffect(() => {
    if (!connected) return;
    scale.setValue(1);
    opacity.setValue(0.75);
    const loop = Animated.loop(
      Animated.parallel([
        Animated.timing(scale, { toValue: 2.2, duration: 1000, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0, duration: 1000, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [connected]);

  return (
    <View style={{ width: 8, height: 8, alignItems: "center", justifyContent: "center" }}>
      {connected && (
        <Animated.View
          style={{
            position: "absolute",
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: COLORS.primary,
            opacity,
            transform: [{ scale }],
          }}
        />
      )}
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: connected ? COLORS.primary : COLORS.danger }} />
    </View>
  );
}

// ─── RefreshCountdown ─────────────────────────────────────────────────────────

// Ticks once a second on its own so the rest of the screen doesn't re-render
function RefreshCountdown({ nextFetchAt, style }: { nextFetchAt: number; style?: any }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const remaining = Math.max(0, Math.ceil((nextFetchAt - now) / 1000));
  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, "0");
  return <Text style={style}>{remaining === 0 ? "Refreshing…" : `Next refresh\n${mm}:${ss}`}</Text>;
}

// ─── RangeBar ─────────────────────────────────────────────────────────────────

// A thin line across the display scale, with the recommended min–max band highlighted and a
// dot at the current value (green inside the band, red outside, hidden when there's no reading).
interface Gauge {
  value: number;
  min: number; // recommended minimum
  max: number; // recommended maximum
  scaleMin: number; // left end of the line
  scaleMax: number; // right end of the line
  format?: (n: number) => string;
}

// One place for each measurement's recommended range and display scale, used by the card lines
// and the at-a-glance bars. Scales match the History charts' axis limits.
type MetricKey = "ph" | "ec" | "waterTemp" | "temperature" | "humidity" | "lightLux" | "co2";
const RANGES: Record<MetricKey, { short: string; min: number; max: number; scaleMin: number; scaleMax: number; format?: (n: number) => string }> = {
  ph: { short: "pH", min: 5.8, max: 6.5, scaleMin: 4.5, scaleMax: 8.5 },
  ec: { short: "EC", min: 1.2, max: 2.4, scaleMin: 0, scaleMax: 4 },
  waterTemp: { short: "H₂O °C", min: 18, max: 22, scaleMin: 10, scaleMax: 30 },
  temperature: { short: "Air °C", min: 20, max: 26, scaleMin: 15, scaleMax: 32 },
  humidity: { short: "RH", min: 50, max: 70, scaleMin: 0, scaleMax: 100 },
  lightLux: { short: "Light", min: 15000, max: 25000, scaleMin: 0, scaleMax: 35000, format: fmtInt },
  co2: { short: "CO₂", min: 800, max: 1200, scaleMin: 300, scaleMax: 2000, format: fmtInt },
};

function gaugeFor(key: MetricKey, value: number): Gauge {
  const { min, max, scaleMin, scaleMax, format } = RANGES[key];
  return { value, min, max, scaleMin, scaleMax, format };
}

// OK inside the recommended range, LOW / HIGH outside it, NO DATA when there's no reading
function rangeStatus(value: number, min: number, max: number): { label: string; color: string; ok: boolean | null } {
  if (!Number.isFinite(value)) return { label: "—", color: COLORS.mutedForeground, ok: null };
  if (value < min) return { label: "LOW", color: COLORS.danger, ok: false };
  if (value > max) return { label: "HIGH", color: COLORS.danger, ok: false };
  return { label: "OK", color: COLORS.primary, ok: true };
}

// ─── GlanceBars ───────────────────────────────────────────────────────────────

// Every sensor side by side as a vertical bar, for an instant OK / not OK view. Each bar has the
// recommended band highlighted and a dot at the current value; water level is a solid bar.
function GlanceBars({ current }: { current: SensorReading }) {
  const metrics = (Object.keys(RANGES) as MetricKey[]).map((key) => {
    const r = RANGES[key];
    const value = current[key];
    return { key, short: r.short, value, range: r, status: rangeStatus(value, r.min, r.max) };
  });
  const level = waterLevelStatus(current.waterPresent);
  const levelOk = current.waterPresent === null ? null : current.waterPresent;
  const results = [...metrics.map((m) => m.status.ok), levelOk];
  const okCount = results.filter((ok) => ok === true).length;
  const known = results.filter((ok) => ok !== null).length;
  const pct = (n: number, lo: number, hi: number) => `${Math.min(100, Math.max(0, ((n - lo) / (hi - lo)) * 100))}%` as const;

  return (
    <View style={styles.glancePanel}>
      <View style={styles.rowBetween}>
        <Text style={styles.labelText}>At a glance</Text>
        <Text style={[styles.glanceSummary, { color: known > 0 && okCount === known ? COLORS.primary : COLORS.danger }]}>
          {known === 0 ? "NO DATA" : `${okCount}/${known} OK`}
        </Text>
      </View>
      <View style={styles.glanceRow}>
        {metrics.map(({ key, short, value, range, status }) => (
          <View key={key} style={styles.glanceCol}>
            <View style={styles.glanceTrack}>
              <View style={[styles.glanceBand, { bottom: pct(range.min, range.scaleMin, range.scaleMax), top: pct(range.scaleMax - range.max + range.scaleMin, range.scaleMin, range.scaleMax) }]} />
              {status.ok !== null && <View style={[styles.glanceDot, { bottom: pct(value, range.scaleMin, range.scaleMax), backgroundColor: status.color }]} />}
            </View>
            <Text style={[styles.glanceStatus, { color: status.color }]}>{status.label}</Text>
            <Text style={styles.glanceLabel} numberOfLines={1}>{short}</Text>
          </View>
        ))}
        <View style={styles.glanceCol}>
          <View style={styles.glanceTrack}>
            {levelOk !== null && <View style={[styles.glanceFill, { backgroundColor: level.color + (levelOk ? "66" : "cc") }]} />}
          </View>
          <Text style={[styles.glanceStatus, { color: level.color }]}>{levelOk === null ? "—" : level.label}</Text>
          <Text style={styles.glanceLabel} numberOfLines={1}>Level</Text>
        </View>
      </View>
    </View>
  );
}

function RangeBar({ value, min, max, scaleMin, scaleMax, format = (n) => String(n) }: Gauge) {
  const pct = (n: number) => `${Math.min(100, Math.max(0, ((n - scaleMin) / (scaleMax - scaleMin)) * 100))}%` as const;
  const hasValue = Number.isFinite(value);
  const inRange = hasValue && value >= min && value <= max;
  return (
    <View style={styles.rangeBarWrap}>
      <View style={styles.rangeBarTrack}>
        <View style={[styles.rangeBarBand, { left: pct(min), right: pct(scaleMax - max + scaleMin) }]} />
        {hasValue && (
          <View style={[styles.rangeBarDot, { left: pct(value), backgroundColor: inRange ? COLORS.primary : COLORS.danger }]} />
        )}
      </View>
      <View style={styles.rowBetween}>
        <Text style={styles.rangeBarLabel}>MIN {format(min)}</Text>
        <Text style={styles.rangeBarLabel}>MAX {format(max)}</Text>
      </View>
    </View>
  );
}

// ─── MetricCard ───────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  unit,
  status,
  range,
  chartData,
  chartColor = COLORS.primary,
  refMin,
  refMax,
  gauge,
}: {
  label: string;
  value: string;
  unit: string;
  status?: { label: string; color: string };
  range?: string;
  chartData?: number[];
  chartColor?: string;
  refMin?: number;
  refMax?: number;
  gauge?: Gauge;
}) {
  return (
    <View style={styles.card}>
      <View style={styles.rowBetween}>
        <Text style={styles.labelText}>{label}</Text>
        {status && (
          <View style={[styles.badge, { backgroundColor: status.color + "18" }]}>
            <Text style={[styles.badgeText, { color: status.color }]}>{status.label}</Text>
          </View>
        )}
      </View>
      <View style={styles.rowEnd}>
        <Text style={styles.valueText}>{value}</Text>
        <Text style={styles.unitText}>{unit}</Text>
      </View>
      {range && <Text style={styles.rangeText}>OPTIMAL {range}</Text>}
      {gauge && <RangeBar {...gauge} />}
      {chartData && (
        <SimpleLineChart data={chartData.slice(-30)} color={chartColor} refMin={refMin} refMax={refMax} />
      )}
    </View>
  );
}

function SectionHeader({ children }: { children: string }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionHeaderText}>{children}</Text>
      <View style={styles.sectionHeaderLine} />
    </View>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = "dashboard" | "controls" | "vision" | "history" | "sensors";

const TAB_ITEMS: { id: Tab; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "⬡" },
  { id: "vision", label: "Plant Vision", icon: "◉" },
  { id: "history", label: "History", icon: "▨" },
  { id: "sensors", label: "Sensors", icon: "ⓘ" },
];

function BottomNav({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <View style={styles.bottomNav}>
      {TAB_ITEMS.map((item) => {
        const active = tab === item.id;
        return (
          <TouchableOpacity key={item.id} onPress={() => setTab(item.id)} style={styles.bottomNavItem}>
            {active && <View style={styles.bottomNavIndicator} />}
            <Text style={[styles.bottomNavIcon, { color: active ? COLORS.primary : COLORS.mutedForeground }]}>{item.icon}</Text>
            <Text style={[styles.bottomNavLabel, { color: active ? COLORS.primary : COLORS.mutedForeground }]}>{item.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function TopBar({
  current,
  system,
  onBack,
  systemName,
  nextFetchAt,
  btConnected,
  onBluetoothPress,
}: {
  current: SensorReading;
  system: SystemState;
  onBack?: () => void;
  systemName?: string;
  nextFetchAt: number;
  btConnected?: boolean;
  onBluetoothPress?: () => void;
}) {
  const ph = phStatus(current.ph);
  return (
    <View style={styles.topBar}>
      {onBack && (
        <TouchableOpacity onPress={onBack} style={styles.backBtn}>
          <Text style={styles.backBtnText}>←</Text>
        </TouchableOpacity>
      )}
      {systemName && (
        <Text style={styles.systemNameText} numberOfLines={1}>
          {systemName}
        </Text>
      )}
      <StatusDot connected={system.connected} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[styles.pillPh, { color: ph.color }]}>pH {fmt(current.ph)}</Text>
        <Text style={styles.pillTemp}>{fmt(current.temperature, 1)}°C</Text>
      </View>
      {!system.connected && onBluetoothPress ? (
        <Text style={[styles.topBarClock, { color: COLORS.warning }]}>Offline{"\n"}tap ᛒ</Text>
      ) : (
        <RefreshCountdown nextFetchAt={nextFetchAt} style={styles.topBarClock} />
      )}
      {onBluetoothPress && (
        <TouchableOpacity onPress={onBluetoothPress} style={[styles.btTopBtn, btConnected && { borderColor: COLORS.blue }]}>
          <Text style={[styles.btIcon, { color: btConnected ? COLORS.blue : COLORS.mutedForeground }]}>ᛒ</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Dashboard Tab ────────────────────────────────────────────────────────────

function DashboardTab({ readings, current, system }: { readings: SensorReading[]; current: SensorReading; system: SystemState }) {
  const ph = phStatus(current.ph);
  const ec = ecStatus(current.ec);
  const waterLevel = waterLevelStatus(current.waterPresent);
  const lowWaterStart = lowWaterSince(readings);
  return (
    <ScrollView style={styles.tabScroll} contentContainerStyle={styles.tabContent}>
      {lowWaterStart !== null && (
        <View style={styles.alertBanner}>
          <Text style={styles.alertTitle}>⚠ Low water level</Text>
          <Text style={styles.alertBody}>
            The water dropped below the low-level sensor at {fmtTime(lowWaterStart)} ({fmtTimeAgo(lowWaterStart)}). Refill the reservoir.
          </Text>
        </View>
      )}
      <View style={styles.rowBetween}>
        <View>
          <Text style={styles.h1}>System Overview</Text>
          <Text style={styles.subtleMono}>Last sync {fmtTime(system.lastSync)} · {system.syncSource === "ble" ? (system.bleStale ? "via Bluetooth · stale" : "via Bluetooth") : "5m"}
          </Text>
        </View>
        <View style={styles.connectedPill}>
          <StatusDot connected={system.connected} />
          <Text style={[styles.connectedPillText, { color: system.connected ? COLORS.primary : COLORS.danger }]}>
            {system.connected ? "Connected" : "Offline"}
          </Text>
        </View>
      </View>

      <Text style={[styles.subtleMono, { marginTop: 8 }]}>Reading recorded {fmtTime(current.timestamp)}</Text>

      <GlanceBars current={current} />

      <SectionHeader>Water Chemistry</SectionHeader>
      <View style={styles.grid2}>
        <View style={styles.gridItem}>
          <MetricCard label="pH" value={fmt(current.ph)} unit="pH" status={ph} range="5.8 – 6.5" chartData={readings.map((r) => r.ph)} chartColor={COLORS.primary} refMin={5.8} refMax={6.5} gauge={gaugeFor("ph", current.ph)} />
        </View>
        <View style={styles.gridItem}>
          <MetricCard label="EC / Nutrients" value={fmt(current.ec)} unit="mS/cm" status={ec} range="1.2 – 2.4 mS/cm" chartData={readings.map((r) => r.ec)} chartColor={COLORS.lightGreen} refMin={1.2} refMax={2.4} gauge={gaugeFor("ec", current.ec)} />
        </View>
        <View style={styles.gridItem}>
          <MetricCard label="Water Temperature" value={fmt(current.waterTemp, 1)} unit="°C" range="18 – 22 °C" chartData={readings.map((r) => r.waterTemp)} chartColor={COLORS.blue} refMin={18} refMax={22} gauge={gaugeFor("waterTemp", current.waterTemp)} />
        </View>
        <View style={styles.gridItem}>
          <MetricCard label="Water Level" value={waterLevel.value} unit="" status={waterLevel} />
        </View>
      </View>

      <SectionHeader>Environment</SectionHeader>
      <View style={styles.grid2}>
        <View style={styles.gridItem}>
          <MetricCard label="Air Temperature" value={fmt(current.temperature, 1)} unit="°C" range="20 – 26 °C" chartData={readings.map((r) => r.temperature)} chartColor={COLORS.blue} gauge={gaugeFor("temperature", current.temperature)} />
        </View>
        <View style={styles.gridItem}>
          <MetricCard label="Humidity" value={fmt(current.humidity, 0)} unit="% RH" range="50 – 70 %" chartData={readings.map((r) => r.humidity)} chartColor={COLORS.lightGreen} refMin={50} refMax={70} gauge={gaugeFor("humidity", current.humidity)} />
        </View>
        <View style={styles.gridItem}>
          <MetricCard label="Light Intensity" value={fmtInt(current.lightLux)} unit="lux" range="15,000 – 25,000 lux" chartData={readings.map((r) => r.lightLux)} chartColor={COLORS.yellow} gauge={gaugeFor("lightLux", current.lightLux)} />
        </View>
        <View style={styles.gridItem}>
          <MetricCard label="CO₂" value={fmtInt(current.co2)} unit="ppm" range="800 – 1,200 ppm" chartData={readings.map((r) => r.co2)} chartColor={COLORS.orange} refMin={800} refMax={1200} gauge={gaugeFor("co2", current.co2)} />
        </View>
      </View>

      <SectionHeader>Active Settings</SectionHeader>
      <View style={styles.grid3}>
        {[
          { label: "pH Target", value: fmt(system.phTarget), unit: "pH" },
          { label: "Light Output", value: `${system.lightIntensity}`, unit: "%" },
          { label: "Light State", value: system.lightOn ? "ON" : "OFF", unit: "" },
        ].map((item) => (
          <View key={item.label} style={styles.settingBox}>
            <Text style={styles.settingLabel}>{item.label}</Text>
            <Text style={styles.settingValue}>
              {item.value}
              <Text style={styles.settingUnit}> {item.unit}</Text>
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// ─── Controls Tab ─────────────────────────────────────────────────────────────

function ControlsTab({
  system,
  setSystem,
  current,
}: {
  system: SystemState;
  setSystem: React.Dispatch<React.SetStateAction<SystemState>>;
  current: SensorReading;
}) {
  const [dosingAmount, setDosingAmount] = useState(5);
  const [dosingLog, setDosingLog] = useState<{ time: number; type: string; amount: number }[]>([]);
  const ph = phStatus(current.ph);

  function dose(type: "acid" | "base") {
    setDosingLog((prev) => [{ time: Date.now(), type: type === "acid" ? "H₃PO₄ (Acid)" : "KOH (Base)", amount: dosingAmount }, ...prev.slice(0, 9)]);
  }

  return (
    <ScrollView style={styles.tabScroll} contentContainerStyle={styles.tabContent}>
      <Text style={styles.h1}>System Controls</Text>
      <Text style={[styles.subtleMono, { marginBottom: 20 }]}>Commands queued and executed on next polling cycle</Text>

      <View style={styles.panel}>
        <SectionHeader>pH Adjustment</SectionHeader>
        <View style={styles.phRow}>
          <View>
            <Text style={styles.miniLabel}>Current pH</Text>
            <Text style={styles.bigValue}>{fmt(current.ph)}</Text>
          </View>
          <View>
            <Text style={styles.miniLabel}>Target pH</Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <TextInput
                keyboardType="numeric"
                value={String(system.phTarget)}
                onChangeText={(t) => {
                  const v = parseFloat(t);
                  if (!isNaN(v)) setSystem((s) => ({ ...s, phTarget: v }));
                }}
                style={styles.numInput}
              />
              <Text style={styles.miniUnit}>pH</Text>
            </View>
          </View>
          <View style={[styles.badge, { backgroundColor: ph.color + "18" }]}>
            <Text style={[styles.badgeText, { color: ph.color }]}>{ph.label}</Text>
          </View>
        </View>

        <Text style={styles.miniLabel}>Dose Volume (mL)</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Slider
            style={{ flex: 1 }}
            minimumValue={1}
            maximumValue={50}
            step={1}
            value={dosingAmount}
            minimumTrackTintColor={COLORS.primary}
            maximumTrackTintColor={COLORS.border}
            onValueChange={setDosingAmount}
          />
          <Text style={styles.sliderValue}>{dosingAmount} mL</Text>
        </View>

        <View style={styles.doseRow}>
          <TouchableOpacity onPress={() => dose("acid")} style={[styles.doseBtn, { backgroundColor: COLORS.danger + "18", borderColor: COLORS.danger }]}>
            <Text style={[styles.doseBtnText, { color: COLORS.danger }]}>↓ Add Acid</Text>
            <Text style={styles.doseBtnSub}>H₃PO₄ — Lower pH</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => dose("base")} style={[styles.doseBtn, { backgroundColor: COLORS.blue + "18", borderColor: COLORS.blue }]}>
            <Text style={[styles.doseBtnText, { color: COLORS.blue }]}>↑ Add Base</Text>
            <Text style={styles.doseBtnSub}>KOH — Raise pH</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.panel}>
        <SectionHeader>Light Control</SectionHeader>
        <View style={styles.rowBetween}>
          <View>
            <Text style={styles.miniLabel}>Light State</Text>
            <Text style={[styles.lightStateText, { color: system.lightOn ? COLORS.primary : COLORS.mutedForeground }]}>
              {system.lightOn ? "● ACTIVE" : "○ OFF"}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setSystem((s) => ({ ...s, lightOn: !s.lightOn }))}
            style={[styles.toggleBtn, { backgroundColor: system.lightOn ? COLORS.primary : COLORS.secondary }]}
          >
            <Text style={[styles.toggleBtnText, { color: system.lightOn ? COLORS.primaryForeground : COLORS.mutedForeground }]}>
              {system.lightOn ? "Turn Off" : "Turn On"}
            </Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.miniLabel}>Intensity — {system.lightIntensity}%</Text>
        <Slider
          minimumValue={0}
          maximumValue={100}
          step={1}
          value={system.lightIntensity}
          disabled={!system.lightOn}
          minimumTrackTintColor={COLORS.yellow}
          maximumTrackTintColor={COLORS.border}
          onValueChange={(v) => setSystem((s) => ({ ...s, lightIntensity: v }))}
        />

        <View style={styles.presetRow}>
          {[
            { label: "Seedling", pct: 30 },
            { label: "Vegetative", pct: 65 },
            { label: "Flowering", pct: 90 },
          ].map((preset) => (
            <TouchableOpacity
              key={preset.label}
              onPress={() => setSystem((s) => ({ ...s, lightIntensity: preset.pct, lightOn: true }))}
              style={styles.presetBtn}
            >
              <Text style={styles.presetLabel}>{preset.label}</Text>
              <Text style={styles.presetValue}>{preset.pct}%</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {dosingLog.length > 0 && (
        <View style={styles.panel}>
          <SectionHeader>Dosing Log</SectionHeader>
          {dosingLog.map((entry, i) => (
            <View key={i} style={styles.logRow}>
              <Text style={styles.logTime}>{fmtTime(entry.time)}</Text>
              <Text style={styles.logType}>{entry.type}</Text>
              <Text style={styles.logAmount}>{entry.amount} mL</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

// ─── Vision Tab ───────────────────────────────────────────────────────────────

function VisionTab({ username }: { username: string }) {
  const [selected, setSelected] = useState<PlantImage>(plantImages[0]);
  const { insight, error: insightError } = useLatestInsight(username);

  return (
    <ScrollView style={styles.tabScroll} contentContainerStyle={styles.tabContent}>
      <Text style={styles.h1}>Plant Vision</Text>
      <Text style={[styles.subtleMono, { marginBottom: 16 }]}>Images every 30 min · CV analysis by on-device model</Text>

      <View style={styles.visionPreview}>
        <Image source={{ uri: selected.url }} style={styles.visionImage} />
        <View style={styles.visionOverlay}>
          <Text style={styles.visionTime}>
            {fmtTime(selected.timestamp)} · {fmtTimeAgo(selected.timestamp)}
          </Text>
          <Text style={styles.visionAnalysis}>{selected.analysis}</Text>
        </View>
        <View style={styles.liveBadge}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE CV</Text>
        </View>
      </View>

      <Text style={styles.miniLabel}>Recent</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {plantImages.map((img) => {
          const active = selected.id === img.id;
          return (
            <TouchableOpacity
              key={img.id}
              onPress={() => setSelected(img)}
              style={[styles.thumb, { borderColor: active ? COLORS.primary : COLORS.border, opacity: active ? 1 : 0.6 }]}
            >
              <Image source={{ uri: img.url }} style={styles.thumbImage} />
              <View style={styles.thumbCaption}>
                <Text style={styles.thumbCaptionText}>{fmtTimeAgo(img.timestamp)}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <Text style={[styles.miniLabel, { marginTop: 20 }]}>Current Insights</Text>
      <View style={styles.panel}>
        {insight ? (
          <>
            <Text style={styles.insightText}>{insight.text}</Text>
            <Text style={styles.axisText}>
              {fmtTime(insight.timestamp)} · {fmtTimeAgo(insight.timestamp)} · checked every 10 min
            </Text>
          </>
        ) : (
          <Text style={styles.subtleMono}>{insightError ?? "No insights yet."}</Text>
        )}
      </View>
    </ScrollView>
  );
}

// ─── History Tab ──────────────────────────────────────────────────────────────

// ─── Sensors Tab ─────────────────────────────────────────────────────────────
// Plain-language explanation of how each reading is measured. Keep in step with the Pi's
// drivers (HydroponicPiLogic/pi/sensors) and the dashboard's target ranges.

const SENSOR_INFO: { group: string; items: { name: string; part: string; location: string; how: string; unit: string; target: string }[] }[] = [
  {
    group: "Water Chemistry",
    items: [
      {
        name: "pH",
        part: "DFRobot analog pH probe (SEN0161)",
        location: "In the nutrient reservoir",
        how: "A glass electrode produces a small voltage that changes with how acidic the solution is. The Pi reads that voltage through an analog-to-digital converter (ADS1115), takes the middle value of 5 quick readings to smooth out noise, and converts it to pH using a calibration made with two standard buffer solutions.",
        unit: "pH",
        target: "5.8 – 6.5",
      },
      {
        name: "EC / Nutrients",
        part: "SenseCAP S-EC-01 conductivity sensor",
        location: "In the nutrient reservoir",
        how: "Electrical conductivity measures how easily a small current passes through the solution. Dissolved nutrient salts make it conduct better, so a higher EC means a stronger nutrient mix. The sensor corrects for water temperature itself and outputs a voltage that the Pi converts to mS/cm.",
        unit: "mS/cm",
        target: "1.2 – 2.4 mS/cm",
      },
      {
        name: "Water Temperature",
        part: "DS18B20 waterproof temperature probe",
        location: "In the nutrient reservoir",
        how: "A sealed digital thermometer. It sends the temperature straight to the Pi as a digital value over a single data wire (1-Wire), so no conversion is needed.",
        unit: "°C",
        target: "18 – 22 °C",
      },
      {
        name: "Water Level",
        part: "DFRobot SEN0204 non-contact level sensor",
        location: "On the outside of the reservoir wall, at the low-water mark",
        how: "The sensor detects through the plastic whether there is liquid at its height. It reports only yes or no, not a percentage. When it no longer detects water, the level has dropped below the mark: the app shows the level as Low and raises a low-water alert so the reservoir can be refilled.",
        unit: "Normal / Low",
        target: "Water at the sensor",
      },
    ],
  },
  {
    group: "Environment",
    items: [
      {
        name: "Air Temperature & Humidity",
        part: "Sensirion SCD41 (temperature and humidity sensors on board)",
        location: "In the growing area",
        how: "Measured by small temperature and relative-humidity sensors built into the SCD41. They come from the same sample as the CO₂ reading. Air temperature also drives the fan: on above 72 °F (22 °C), off below 58 °F (14 °C).",
        unit: "°C, % RH",
        target: "20 – 26 °C, 50 – 70 % RH",
      },
      {
        name: "CO₂",
        part: "Sensirion SCD41",
        location: "In the growing area",
        how: "Measured photoacoustically: the sensor pulses infrared light at a wavelength CO₂ absorbs, and a tiny microphone picks up the pressure change this causes. A stronger signal means more CO₂. The sensor takes a new sample every 5 seconds.",
        unit: "ppm",
        target: "800 – 1,200 ppm",
      },
      {
        name: "Light Intensity",
        part: "Vishay VEML7700 light sensor",
        location: "On the growing shelf, facing the grow lights",
        how: "A light sensor filtered to respond to brightness the way the human eye does, reporting illuminance in lux. Readings beyond what the sensor can measure accurately are rejected rather than shown as a false maximum.",
        unit: "lux",
        target: "15,000 – 25,000 lux",
      },
    ],
  },
];

function SensorsTab() {
  return (
    <ScrollView style={styles.tabScroll} contentContainerStyle={styles.tabContent}>
      <Text style={styles.h1}>How Sensors Work</Text>
      <Text style={[styles.subtleMono, { marginBottom: 16 }]}>What each reading means and how it is measured</Text>

      <View style={styles.panel}>
        <Text style={styles.miniLabel}>How readings reach this app</Text>
        <Text style={styles.sensorBody}>
          The Raspberry Pi reads every sensor every 30 seconds and saves each reading on the Pi first, so nothing is lost if Wi-Fi drops. Readings that
          are physically impossible, change faster than a real probe can, or repeat the exact same value too many times are treated as a faulty sensor and
          shown as “—” instead. The Pi uploads readings to the cloud every 5 minutes, and this app refreshes on the same schedule. Without Wi-Fi, the app can
          fetch recent readings straight from the Pi over Bluetooth.
        </Text>
      </View>

      {SENSOR_INFO.map(({ group, items }) => (
        <View key={group}>
          <SectionHeader>{group}</SectionHeader>
          {items.map((s) => (
            <View key={s.name} style={styles.panel}>
              <Text style={styles.sensorName}>{s.name}</Text>
              <Text style={styles.sensorPart}>{s.part}</Text>
              <Text style={styles.sensorLocation}>{s.location}</Text>
              <Text style={styles.sensorBody}>{s.how}</Text>
              <View style={styles.sensorFacts}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.miniLabel}>Unit</Text>
                  <Text style={styles.sensorFact}>{s.unit}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.miniLabel}>Target</Text>
                  <Text style={styles.sensorFact}>{s.target}</Text>
                </View>
              </View>
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

// History ranges. "live" is what the app already has (the CSE's recent readings); the others
// are asked from the Pi through the CSE (requestFromPi), thinned to one reading per step so a
// week still fits a chart.
type HistoryRange = "live" | "24h" | "7d";
const HISTORY_RANGES: Record<HistoryRange, { label: string; seconds: number; step_s: number; caption: string }> = {
  live: { label: "Live", seconds: 0, step_s: 0, caption: "Last 60 minutes · 1-minute intervals" },
  "24h": { label: "24 h", seconds: 24 * 3600, step_s: 600, caption: "Last 24 hours · 10-minute intervals · from the Pi" },
  "7d": { label: "7 days", seconds: 7 * 24 * 3600, step_s: 3600, caption: "Last 7 days · hourly · from the Pi" },
};

// Fetches older history from the Pi when a longer range is chosen
function usePiHistory(systemName: string, range: HistoryRange) {
  const [attempt, setAttempt] = useState(0); // bump to retry
  // The answer for one request, tagged with that request's key. While the latest answer's key
  // differs from the current request's, the request is still in flight.
  const key = `${systemName}|${range}|${attempt}`;
  const [state, setState] = useState<{ key: string; readings: SensorReading[] | null; error: string | null; truncated: boolean }>(
    { key: "", readings: null, error: null, truncated: false }
  );

  useEffect(() => {
    if (range === "live") return;
    let cancelled = false;
    const { seconds, step_s } = HISTORY_RANGES[range];
    (async () => {
      try {
        const settings = await loadSettings();
        const ae = await findSystemAE(settings, systemName);
        if (!ae) throw new Error("No Pi on the CSE has this system's name.");
        const reply = await requestFromPi(settings, ae, {
          op: "history",
          since: new Date(Date.now() - seconds * 1000).toISOString(),
          step_s,
        });
        if (reply.status !== 200) throw new Error(reply.error ?? `The Pi answered ${reply.status}.`);
        const readings = reply.records
          .map(rowToReading)
          .filter((r) => Number.isFinite(r.timestamp))
          .sort((a, b) => a.timestamp - b.timestamp);
        if (!cancelled) setState({ key, readings, error: null, truncated: reply.truncated });
      } catch (err: any) {
        if (!cancelled) setState({ key, readings: null, error: err?.message ?? "Could not reach the Pi.", truncated: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [systemName, range, key]);

  const current = state.key === key;
  return {
    loading: range !== "live" && !current,
    readings: current ? state.readings : null,
    error: current ? state.error : null,
    truncated: current && state.truncated,
    retry: () => setAttempt((n) => n + 1),
  };
}

function HistoryTab({ readings: liveReadings, systemName }: { readings: SensorReading[]; systemName: string }) {
  const [range, setRange] = useState<HistoryRange>("live");
  const pi = usePiHistory(systemName, range);
  const readings = range === "live" ? liveReadings : pi.readings ?? [];
  const axisTime = range === "live" ? fmtTime : fmtDayTime; // longer ranges cross midnight

  const series: {
    label: string;
    key: "ph" | "ec" | "waterTemp" | "temperature" | "humidity" | "lightLux" | "co2";
    color: string;
    refMin?: number;
    refMax?: number;
    min?: number;
    max?: number;
  }[] = [
    { label: "pH", key: "ph", color: COLORS.primary, refMin: 5.8, refMax: 6.5, min: 4.5, max: 8.5 },
    { label: "EC (mS/cm)", key: "ec", color: COLORS.lightGreen, refMin: 1.2, refMax: 2.4, min: 0, max: 4 },
    { label: "Water Temperature (°C)", key: "waterTemp", color: COLORS.blue, refMin: 18, refMax: 22, min: 10, max: 30 },
    { label: "Air Temperature (°C)", key: "temperature", color: COLORS.blue, refMin: 20, refMax: 26, min: 15, max: 32 },
    { label: "Humidity (% RH)", key: "humidity", color: COLORS.lightGreen, refMin: 50, refMax: 70, min: 0, max: 100 },
    { label: "Light (lux)", key: "lightLux", color: COLORS.yellow, min: 0, max: 35000 },
    { label: "CO₂ (ppm)", key: "co2", color: COLORS.orange, refMin: 800, refMax: 1200, min: 300, max: 2000 },
  ];

  return (
    <ScrollView style={styles.tabScroll} contentContainerStyle={styles.tabContent}>
      <Text style={styles.h1}>Sensor History</Text>
      <View style={styles.historyRangeRow}>
        {(Object.keys(HISTORY_RANGES) as HistoryRange[]).map((r) => (
          <TouchableOpacity key={r} onPress={() => setRange(r)} disabled={pi.loading}
            style={[styles.historyRangeBtn, range === r && styles.historyRangeBtnActive]}>
            <Text style={[styles.historyRangeText, range === r && styles.historyRangeTextActive]}>{HISTORY_RANGES[r].label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={[styles.subtleMono, { marginBottom: 20 }]}>
        {HISTORY_RANGES[range].caption}
        {range !== "live" && pi.readings ? ` · ${pi.readings.length} readings${pi.truncated ? " (newest shown)" : ""}` : ""}
      </Text>

      {range !== "live" && pi.loading && (
        <View style={styles.panel}>
          <Text style={styles.subtleMono}>Asking the Pi through the CSE… (it checks every few seconds)</Text>
        </View>
      )}
      {range !== "live" && pi.error && (
        <View style={styles.panel}>
          <Text style={[styles.subtleMono, { color: COLORS.danger }]}>{pi.error}</Text>
          <TouchableOpacity onPress={pi.retry} style={[styles.primaryBtn, { alignSelf: "flex-start", marginTop: 8 }]}>
            <Text style={styles.primaryBtnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      )}

      {(range === "live" || pi.readings) && series.map(({ label, key, color, refMin, refMax, min, max }) => (
        <View key={key} style={styles.panel}>
          <Text style={styles.miniLabel}>{label}</Text>
          <SimpleLineChart data={readings.map((r) => r[key])} color={color} refMin={refMin} refMax={refMax} min={min} max={max} height={110} />
          <View style={styles.rowBetween}>
            <Text style={styles.axisText}>{readings[0] ? axisTime(readings[0].timestamp) : ""}</Text>
            <Text style={styles.axisText}>{readings[readings.length - 1] ? axisTime(readings[readings.length - 1].timestamp) : ""}</Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

// ─── Home screen helpers ──────────────────────────────────────────────────────

const CROP_ICONS: Record<CropType, string> = {
  Lettuce: "🥬",
  Basil: "🌿",
  Spinach: "🍃",
  Tomato: "🍅",
  Strawberry: "🍓",
  Kale: "🥦",
  Arugula: "🌱",
  Mint: "🌾",
};
const CROP_TYPES: CropType[] = ["Lettuce", "Basil", "Spinach", "Tomato", "Strawberry", "Kale", "Arugula", "Mint"];
const DEFAULT_LOCATIONS = ["Greenhouse A", "Greenhouse B", "Indoor Lab", "Rooftop", "Basement Unit", "Growth Chamber"];


// ─── Add System Modal ─────────────────────────────────────────────────────────

// ─── Bluetooth Modal ──────────────────────────────────────────────────────────
// Offline fallback: find a HydroPi over BLE and pull its latest readings (src/ble/pi-ble.ts).

const BLE_SCAN_MS = 8000;
const BLE_ROW_COUNT = 50; // the most the Pi sends per request (ble-protocol.md); enough for the 30-point charts

type BtPhase = "idle" | "scanning" | "fetching";

function BluetoothModal({
  visible,
  onClose,
  lastDevice,
  onData,
}: {
  visible: boolean;
  onClose: () => void;
  lastDevice: PiDevice | null;
  onData: (device: PiDevice, transfer: BleTransfer) => void;
}) {
  const [phase, setPhase] = useState<BtPhase>("idle");
  const [found, setFound] = useState<PiDevice[]>([]);
  const [fetchingId, setFetchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; count: number; sensorsOk: boolean } | null>(null);
  const stopScanRef = useRef<(() => void) | null>(null);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function stopScan() {
    stopScanRef.current?.();
    stopScanRef.current = null;
    if (scanTimer.current) clearTimeout(scanTimer.current);
    scanTimer.current = null;
  }

  async function scan() {
    stopScan();
    setFound([]);
    setError(null);
    setResult(null);
    setPhase("scanning");
    try {
      await ensureBleReady();
      stopScanRef.current = scanForPis(
        (d) => setFound((prev) => [...prev, d]),
        (e) => {
          stopScan();
          setError(e.message);
          setPhase("idle");
        }
      );
      scanTimer.current = setTimeout(() => {
        stopScan();
        setPhase((p) => (p === "scanning" ? "idle" : p));
      }, BLE_SCAN_MS);
    } catch (e: any) {
      setError(e.message);
      setPhase("idle");
    }
  }

  async function fetchFrom(d: PiDevice) {
    stopScan();
    setError(null);
    setResult(null);
    setPhase("fetching");
    setFetchingId(d.id);
    try {
      await ensureBleReady();
      const transfer = await fetchRowsOverBle(d.id, BLE_ROW_COUNT);
      onData(d, transfer);
      setResult({ name: d.name, count: transfer.rows.length, sensorsOk: transfer.sensorsOk });
    } catch (e: any) {
      setError(e.message ?? "Bluetooth transfer failed.");
    } finally {
      setPhase("idle");
      setFetchingId(null);
    }
  }

  // Scan as soon as the sheet opens, unless there's a Pi to re-sync from
  useEffect(() => {
    if (visible && bleAvailable() && !lastDevice) scan();
    if (!visible) {
      stopScan();
      setPhase("idle");
      setFetchingId(null);
      setError(null);
      setResult(null);
    }
    return stopScan;
  }, [visible]);

  const busy = phase !== "idle";
  const status =
    phase === "scanning"
      ? "Scanning for HydroPi devices…"
      : phase === "fetching"
      ? "Fetching readings…"
      : found.length
      ? `${found.length} Pi${found.length === 1 ? "" : "s"} found. Tap one to sync.`
      : "No Pis found yet. Check the Pi is on and nearby, then scan again.";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <View style={styles.dragHandle} />
          <View style={styles.rowBetween}>
            <Text style={styles.modalTitle}>Bluetooth Sync</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.closeX}>✕</Text>
            </TouchableOpacity>
          </View>

          {!bleAvailable() ? (
            <Text style={styles.btDeviceMeta}>Bluetooth sync works in the Android app only (a development build, not Expo Go or web).</Text>
          ) : (
            <>
              <Text style={styles.btDeviceMeta}>Pulls the latest readings straight from the Pi when Wi-Fi is down.</Text>

              {lastDevice && (
                <View style={styles.btConnectedBox}>
                  <Text style={styles.btIcon}>ᛒ</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.btDeviceName}>{lastDevice.name}</Text>
                    <Text style={styles.btDeviceMeta}>Last synced from this Pi</Text>
                  </View>
                  <TouchableOpacity onPress={() => fetchFrom(lastDevice)} disabled={busy} style={[styles.btSmallBtn, busy && { opacity: 0.5 }]}>
                    <Text style={[styles.btSmallBtnText, { color: COLORS.primary }]}>{fetchingId === lastDevice.id ? "Syncing…" : "Sync again"}</Text>
                  </TouchableOpacity>
                </View>
              )}

              {result && (
                <Text style={[styles.btDeviceMeta, { color: COLORS.primary }]}>
                  {result.count === 0 ? `${result.name} has no readings yet.` : `✓ Received ${result.count} reading${result.count === 1 ? "" : "s"} from ${result.name}.`}
                </Text>
              )}
              {result && !result.sensorsOk && (
                <Text style={[styles.btDeviceMeta, { color: COLORS.warning }]}>The Pi's sensors haven't reported in over 3 minutes, so this data may be stale.</Text>
              )}
              {error && <Text style={[styles.btDeviceMeta, { color: COLORS.danger }]}>{error}</Text>}

              <Text style={styles.btDeviceMeta}>{status}</Text>
              {found.map((d) => (
                <TouchableOpacity
                  key={d.id}
                  disabled={busy}
                  onPress={() => fetchFrom(d)}
                  style={[styles.btDeviceRow, busy && fetchingId !== d.id && { opacity: 0.5 }]}
                >
                  <Text style={styles.btIcon}>ᛒ</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.btDeviceName}>{d.name}</Text>
                    {d.rssi !== null && <Text style={styles.btDeviceMeta}>{d.rssi} dBm</Text>}
                  </View>
                  <Text style={[styles.btSmallBtnText, { color: COLORS.primary }]}>{fetchingId === d.id ? "Syncing…" : "Sync"}</Text>
                </TouchableOpacity>
              ))}
            </>
          )}

          <View style={styles.modalBtnRow}>
            <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelBtnText}>Close</Text>
            </TouchableOpacity>
            {bleAvailable() && (
              <TouchableOpacity onPress={scan} disabled={busy} style={[styles.submitBtn, busy && { opacity: 0.5 }]}>
                <Text style={styles.submitBtnText}>{phase === "scanning" ? "Scanning…" : "Scan"}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function AddSystemModal({
  visible,
  onAdd,
  onClose,
  locations,
}: {
  visible: boolean;
  onAdd: (s: HydroSystem) => void;
  onClose: () => void;
  locations: string[];
}) {
  const [name, setName] = useState("");
  const [crop, setCrop] = useState<CropType>("Lettuce");
  const [location, setLocation] = useState(locations[0] ?? "");
  const [tiers, setTiers] = useState(4);

  function submit() {
    if (!name.trim()) return;
    onAdd({
      id: `sys-${Date.now()}`,
      name: name.trim(),
      crop,
      location,
      tiers,
      addedAt: Date.now(),
      readings: [],
      system: { phTarget: 6.2, lightIntensity: 60, lightOn: true, connected: true, lastSync: Date.now() },
    });
    setName("");
    setCrop("Lettuce");
    setTiers(4);
    onClose();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalSheet}>
          <View style={styles.dragHandle} />
          <View style={styles.rowBetween}>
            <Text style={styles.modalTitle}>New Hydroponic System</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.closeX}>✕</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.fieldLabel}>System Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Tower D"
            placeholderTextColor={COLORS.mutedForeground}
            style={styles.textInput}
          />

          <Text style={styles.fieldLabel}>Crop Type</Text>
          <View style={styles.pickerWrap}>
            <Picker selectedValue={crop} onValueChange={(v) => setCrop(v as CropType)} dropdownIconColor={COLORS.foreground} style={{ color: COLORS.foreground }}>
              {CROP_TYPES.map((c) => (
                <Picker.Item key={c} label={`${CROP_ICONS[c]} ${c}`} value={c} />
              ))}
            </Picker>
          </View>

          <Text style={styles.fieldLabel}>Location</Text>
          <View style={styles.pickerWrap}>
            <Picker selectedValue={location} onValueChange={setLocation} dropdownIconColor={COLORS.foreground} style={{ color: COLORS.foreground }}>
              {locations.map((l) => (
                <Picker.Item key={l} label={l} value={l} />
              ))}
            </Picker>
          </View>

          <Text style={styles.fieldLabel}>Tiers — {tiers}</Text>
          <Slider minimumValue={1} maximumValue={12} step={1} value={tiers} onValueChange={setTiers} minimumTrackTintColor={COLORS.primary} maximumTrackTintColor={COLORS.border} />

          <View style={styles.modalBtnRow}>
            <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={submit} style={styles.submitBtn}>
              <Text style={styles.submitBtnText}>Add System</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ─── Manage Locations Modal ───────────────────────────────────────────────────

function ManageLocationsModal({
  visible,
  locations,
  setLocations,
  onClose,
}: {
  visible: boolean;
  locations: string[];
  setLocations: React.Dispatch<React.SetStateAction<string[]>>;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState("");

  function add() {
    const val = input.trim();
    if (!val) return;
    if (locations.some((l) => l.toLowerCase() === val.toLowerCase())) {
      setError("Location already exists.");
      return;
    }
    setLocations((prev) => [...prev, val]);
    setInput("");
    setError("");
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalSheet, { maxHeight: "80%" }]}>
          <View style={styles.dragHandle} />
          <View style={styles.rowBetween}>
            <Text style={styles.modalTitle}>Manage Locations</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.closeX}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={{ maxHeight: 260 }}>
            {locations.length === 0 && <Text style={styles.emptyText}>No locations defined</Text>}
            {locations.map((loc) => (
              <View key={loc} style={styles.locationRow}>
                <Text style={styles.locationText}>{loc}</Text>
                <TouchableOpacity onPress={() => setLocations((prev) => prev.filter((l) => l !== loc))} style={styles.removeBtn}>
                  <Text style={styles.removeBtnText}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
          <Text style={styles.fieldLabel}>New Location</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput
              value={input}
              onChangeText={(t) => {
                setInput(t);
                setError("");
              }}
              placeholder="e.g. Vertical Farm 2"
              placeholderTextColor={COLORS.mutedForeground}
              style={[styles.textInput, { flex: 1, borderColor: error ? COLORS.danger : COLORS.border }]}
            />
            <TouchableOpacity onPress={add} style={styles.addBtn}>
              <Text style={styles.addBtnText}>+ Add</Text>
            </TouchableOpacity>
          </View>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

// ─── System Card ──────────────────────────────────────────────────────────────

function SystemCard({ hs, onOpen, onRemove }: { hs: HydroSystem; onOpen: () => void; onRemove: () => void }) {
  const current = hs.readings[hs.readings.length - 1];
  const daysSince = Math.floor((Date.now() - hs.addedAt) / 86400000);
  // Crop, location and tiers only exist for systems the user labelled; otherwise describe the data
  const details = [hs.crop, hs.location, hs.tiers ? `${hs.tiers} tiers` : undefined].filter(Boolean).join(" · ");
  const meta = details || `${hs.readings.length} reading${hs.readings.length === 1 ? "" : "s"}`;

  const header = (
    <View style={styles.sysCardHeader}>
      <View style={{ flexShrink: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ fontSize: 16 }}>{cropIcon(hs)}</Text>
          <Text style={styles.sysCardName}>{hs.name}</Text>
        </View>
        <Text style={styles.sysCardMeta}>{meta}</Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {current && <StatusDot connected={hs.system.connected} />}
        <TouchableOpacity onPress={onRemove} style={styles.removeXBtn}>
          <Text style={styles.removeXText}>✕</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // A system the user added before any data is tagged with its name: nothing to open yet
  if (!current) {
    return (
      <View style={styles.sysCard}>
        {header}
        <View style={styles.sysCardFooter}>
          <Text style={styles.sysCardMeta}>No readings yet. Rows with system_name “{hs.name}” will appear here.</Text>
        </View>
      </View>
    );
  }

  const ph = phStatus(current.ph);
  const ec = ecStatus(current.ec);

  return (
    <TouchableOpacity onPress={onOpen} style={styles.sysCard} activeOpacity={0.8}>
      {header}

      <View style={styles.sysCardMetrics}>
        {[
          { label: "pH", value: fmt(current.ph), color: ph.color },
          { label: "EC", value: fmt(current.ec) },
          { label: "T°", value: `${fmt(current.temperature, 1)}°` },
          { label: "LUX", value: Number.isFinite(current.lightLux) ? (current.lightLux / 1000).toFixed(1) + "k" : "—" },
        ].map((m) => (
          <View key={m.label} style={styles.sysCardMetric}>
            <Text style={styles.sysCardMetricLabel}>{m.label}</Text>
            <Text style={[styles.sysCardMetricValue, { color: m.color ?? COLORS.foreground }]}>{m.value}</Text>
          </View>
        ))}
      </View>

      <View style={styles.sysCardFooter}>
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          <View style={[styles.tag, { backgroundColor: ph.color + "15" }]}>
            <Text style={[styles.tagText, { color: ph.color }]}>pH {ph.label}</Text>
          </View>
          <View style={[styles.tag, { backgroundColor: ec.color + "15" }]}>
            <Text style={[styles.tagText, { color: ec.color }]}>EC {ec.label}</Text>
          </View>
          {isLowWater(current) && (
            <View style={[styles.tag, { backgroundColor: COLORS.danger + "15" }]}>
              <Text style={[styles.tagText, { color: COLORS.danger }]}>⚠ LOW WATER</Text>
            </View>
          )}
        </View>
        <Text style={styles.sysCardDays}>{daysSince === 0 ? "today" : `${daysSince}d`}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ─── Home Screen ──────────────────────────────────────────────────────────────

function HomeScreen({
  systems,
  onAdd,
  onRemove,
  onLogout,
  locations,
  setLocations,
  onOpen,
  nextFetchAt,
}: {
  systems: HydroSystem[];
  onAdd: (s: HydroSystem) => void;
  onRemove: (id: string) => void;
  onLogout: () => void;
  locations: string[];
  setLocations: React.Dispatch<React.SetStateAction<string[]>>;
  onOpen: (id: string) => void;
  nextFetchAt: number;
}) {
  const [showModal, setShowModal] = useState(false);
  const [showLocations, setShowLocations] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const onlineCount = systems.filter((s) => s.system.connected).length;

  return (
    <View style={styles.screen}>
      <View style={styles.homeTopBar}>
        <Text style={{ fontSize: 18, color: COLORS.primary }}>◈</Text>
        <Text style={styles.homeTopBarTitle}>HydroOS</Text>
        <View style={{ marginLeft: "auto" }}>
          <Text style={styles.homeTopBarStatus}>
            {onlineCount}/{systems.length} online
          </Text>
          <RefreshCountdown nextFetchAt={nextFetchAt} style={styles.topBarClock} />
        </View>
        <Button title="Logout" onPress={onLogout} color={COLORS.danger} />
      </View>

      <ScrollView style={styles.tabScroll} contentContainerStyle={styles.tabContent}>
        <View style={{ marginBottom: 8 }}>
          <Text style={styles.eyebrow}>Facility Overview</Text>
          <Text style={styles.h1Large}>Hydroponic Systems</Text>
        </View>
        <View style={styles.homeActionsRow}>
          <TouchableOpacity onPress={() => setShowLocations(true)} style={styles.secondaryBtn}>
            <Text style={styles.secondaryBtnText}>⌖ Locations</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowModal(true)} style={styles.primaryBtn}>
            <Text style={styles.primaryBtnText}>+ Add System</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.statGrid}>
          {[
            { label: "Total Systems", value: systems.length },
            { label: "Online", value: onlineCount },
            { label: "Offline", value: systems.length - onlineCount },
            { label: "Crop Types", value: new Set(systems.map((s) => s.crop).filter(Boolean)).size },
          ].map((stat) => (
            <View key={stat.label} style={styles.statBox}>
              <Text style={styles.statLabel}>{stat.label}</Text>
              <Text style={styles.statValue}>{stat.value}</Text>
            </View>
          ))}
        </View>

        {systems.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={{ fontSize: 32, opacity: 0.3, marginBottom: 12 }}>◈</Text>
            <Text style={styles.emptyStateText}>No systems yet</Text>
            <TouchableOpacity onPress={() => setShowModal(true)}>
              <Text style={styles.emptyStateLink}>Add your first system →</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            {systems.map((hs) => (
              <SystemCard key={hs.id} hs={hs} onOpen={() => onOpen(hs.id)} onRemove={() => setConfirmRemove(hs.id)} />
            ))}
          </View>
        )}
      </ScrollView>

      <AddSystemModal visible={showModal} onAdd={onAdd} onClose={() => setShowModal(false)} locations={locations} />
      <ManageLocationsModal visible={showLocations} locations={locations} setLocations={setLocations} onClose={() => setShowLocations(false)} />

      <Modal visible={!!confirmRemove} transparent animationType="fade" onRequestClose={() => setConfirmRemove(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.confirmSheet}>
            <View style={styles.dragHandle} />
            <Text style={styles.confirmTitle}>Remove system?</Text>
            <Text style={styles.confirmSub}>{systems.find((s) => s.id === confirmRemove)?.name} · This cannot be undone.</Text>
            <View style={styles.modalBtnRow}>
              <TouchableOpacity onPress={() => setConfirmRemove(null)} style={styles.cancelBtn}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  if (confirmRemove) onRemove(confirmRemove);
                  setConfirmRemove(null);
                }}
                style={styles.dangerBtn}
              >
                <Text style={styles.dangerBtnText}>Remove</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── System Detail ────────────────────────────────────────────────────────────

function SystemDetail({
  hs,
  onBack,
  updateSystem,
  nextFetchAt,
  btDevice,
  setBtDevice,
  onBleData,
  username,
}: {
  hs: HydroSystem;
  username: string;
  onBack: () => void;
  updateSystem: (id: string, patch: Partial<Pick<HydroSystem, "readings" | "system">>) => void;
  nextFetchAt: number;
  btDevice: PiDevice | null;
  setBtDevice: (d: PiDevice | null) => void;
  onBleData: (transfer: BleTransfer) => void;
}) {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [showBluetooth, setShowBluetooth] = useState(false);

  const current = hs.readings[hs.readings.length - 1];

  function setSystemState(updater: React.SetStateAction<SystemState>) {
    const next = typeof updater === "function" ? (updater as (s: SystemState) => SystemState)(hs.system) : updater;
    updateSystem(hs.id, { system: next });
  }

  return (
    <View style={styles.screen}>
      <TopBar current={current} system={hs.system} onBack={onBack} systemName={`${cropIcon(hs)} ${hs.name}`} nextFetchAt={nextFetchAt}
        btConnected={!!btDevice}
        onBluetoothPress={bleAvailable() ? () => setShowBluetooth(true) : undefined}
      />
      <View style={{ flex: 1 }}>
        {tab === "dashboard" && <DashboardTab readings={hs.readings} current={current} system={hs.system} />}
        {tab === "controls" && <ControlsTab system={hs.system} setSystem={setSystemState} current={current} />}
        {tab === "vision" && <VisionTab username={username} />}
        {tab === "history" && <HistoryTab readings={hs.readings} systemName={hs.name} />}
        {tab === "sensors" && <SensorsTab />}
      </View>
      <BottomNav tab={tab} setTab={setTab} />
      <BluetoothModal
        visible={showBluetooth}
        onClose={() => setShowBluetooth(false)}
        lastDevice={btDevice}
        onData={(device, transfer) => {
          setBtDevice(device);
          onBleData(transfer);
        }}
      />
    </View>
  );
}



// ─── Root App ─────────────────────────────────────────────────────────────────

export default function App() {
  // Logged-in username; null means logged out. Not persisted, so the app asks again after every restart.
  const [username, setUsername] = useState<string | null>(null);
  // Built from the data (one per system_name) plus any the user adds; no defaults
  const [systems, setSystems] = useState<HydroSystem[]>([]);
  // Lower-cased names the user removed, so the next refresh doesn't bring them back
  const hiddenRef = useRef(new Set<string>());
  const [locations, setLocations] = useState<string[]>(DEFAULT_LOCATIONS);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nextFetchAt, setNextFetchAt] = useState(Date.now() + REFRESH_INTERVAL_MS);
  // Simulated Bluetooth connection per system id
  const [btDevices, setBtDevices] = useState<Record<string, PiDevice | null>>({});
  // True once readings have arrived from Supabase or Bluetooth
  const hasDataRef = useRef(false);
  // Bluetooth sync offered on the error screen when the first Supabase load fails
  const [showStartupBluetooth, setShowStartupBluetooth] = useState(false);
  const [startupBtDevice, setStartupBtDevice] = useState<PiDevice | null>(null);
  // Where the CSE is; null until the saved settings have been read from the phone
  const [cseSettings, setCseSettings] = useState<OneM2MSettings | null>(null);
  const [showCseSettings, setShowCseSettings] = useState(false);

  useEffect(() => {
    loadSettings().then(setCseSettings, () => setCseSettings(defaultSettings()));
  }, []);

  async function applyCseSettings(next: OneM2MSettings) {
    setShowCseSettings(false);
    try {
      await saveSettings(next);
    } catch (err) {
      console.error("Could not save oneM2M settings:", err);
    }
    setCseSettings(next); // restarts the fetch loop below with the new CSE
  }

  // Fetch readings from the CSE on login, then every REFRESH_INTERVAL_MS
  useEffect(() => {
    // New user (or logged out): drop the previous user's readings so they never show
    hasDataRef.current = false;
    setLoadError(null);
    setLoading(true);
    // Keep only systems the user added (without data); the rest are rebuilt from the new user's rows
    setSystems((prev) => prev.filter((s) => s.manual).map((s) => ({ ...s, readings: [] })));
    hiddenRef.current = new Set();
    if (username === null || cseSettings === null) return;
    const settings = cseSettings;

    let cancelled = false;

    async function load() {
      setNextFetchAt(Date.now() + REFRESH_INTERVAL_MS);
      try {
        const readings = await fetchReadings(settings);
        if (cancelled) return;
        hasDataRef.current = true;
        setLoadError(null);
        // Each system shows only its own rows (the record's system_name)
        const groups = groupBySystem(readings);
        setSystems((prev) =>
          applyGroups(prev, groups, hiddenRef.current, "replace", { connected: true, lastSync: Date.now(), syncSource: "cloud", bleStale: false })
        );
      } catch (err: any) {
        if (cancelled) return;
        console.error("Failed to fetch readings:", err);
        if (hasDataRef.current) {
          // Keep showing the last good data, just flag the systems as offline
          setSystems((prev) => prev.map((s) => ({ ...s, system: { ...s.system, connected: false } })));
        } else {
          setLoadError(err.message ?? "Could not load sensor data");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [username, cseSettings]);

  // Startup fallback: Pi rows are grouped by system the same way as Supabase rows. The Pi doesn't
  // send system_name, so they land under "Unassigned".
  function applyStartupBle(device: PiDevice, transfer: BleTransfer) {
    const readings = bleTransferToReadings(transfer);
    if (readings.length === 0) return;
    hasDataRef.current = true;
    setStartupBtDevice(device);
    setSystems((prev) =>
      applyGroups(prev, groupBySystem(readings), hiddenRef.current, "merge", {
        connected: true, lastSync: Date.now(), syncSource: "ble", bleStale: !transfer.sensorsOk,
      })
    );
    setLoadError(null);
  }

  // Sync from a system's page: rows are split by system_name like a cloud fetch, so each system
  // gets only its own rows. Untagged rows (a Pi that doesn't send system_name) go to the system
  // the sync was started from.
  function applySystemBle(hs: HydroSystem, transfer: BleTransfer) {
    const readings = bleTransferToReadings(transfer).map((r) => (r.system === null ? { ...r, system: hs.name } : r));
    if (readings.length === 0) return;
    setSystems((prev) =>
      applyGroups(prev, groupBySystem(readings), hiddenRef.current, "merge", {
        connected: true, lastSync: Date.now(), syncSource: "ble", bleStale: !transfer.sensorsOk,
      })
    );
  }

  function updateSystem(id: string, patch: Partial<Pick<HydroSystem, "readings" | "system">>) {
    setSystems((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  // "Add System" with the name of a system already in the data labels it (crop, location, tiers)
  // instead of creating a duplicate. A new name waits for rows tagged with it.
  function addSystem(added: HydroSystem) {
    hiddenRef.current.delete(added.name.toLowerCase());
    setSystems((prev) => {
      const existing = prev.find((s) => sameName(s.name, added.name));
      if (existing) {
        return prev.map((s) => (s === existing ? { ...s, crop: added.crop, location: added.location, tiers: added.tiers, manual: true } : s));
      }
      return [...prev, { ...added, manual: true }];
    });
  }

  function removeSystem(id: string) {
    const removed = systems.find((s) => s.id === id);
    if (removed) hiddenRef.current.add(removed.name.toLowerCase());
    setSystems((prev) => prev.filter((s) => s.id !== id));
  }

  // One popup per low-water period, on any screen. Systems already alerted are remembered until
  // the level recovers, so a refresh while it's still low doesn't alert again. Logged out:
  // forget them, so the next login alerts again if the level is still low.
  const lowWaterAlertedRef = useRef(new Set<string>());
  useEffect(() => {
    if (username === null) {
      lowWaterAlertedRef.current = new Set();
      return;
    }
    const low = systems.filter((s) => isLowWater(s.readings[s.readings.length - 1]));
    const newlyLow = low.filter((s) => !lowWaterAlertedRef.current.has(s.id));
    lowWaterAlertedRef.current = new Set(low.map((s) => s.id));
    if (newlyLow.length > 0) {
      Alert.alert(
        "⚠ Low water level",
        `${newlyLow.map((s) => s.name).join(", ")}: the water has dropped below the low-level sensor. Refill the reservoir.`
      );
    }
  }, [systems, username]);

  const cseSettingsModal = cseSettings && showCseSettings && (
    <OneM2MSettingsModal
      visible
      settings={cseSettings}
      onSave={applyCseSettings}
      onClose={() => setShowCseSettings(false)}
    />
  );
  const cseSettingsButton = (
    <TouchableOpacity onPress={() => setShowCseSettings(true)} style={{ marginTop: 16, padding: 8 }}>
      <Text style={[styles.subtleMono, { color: COLORS.primary }]}>⚙ oneM2M settings ({cseSettings?.cseUrl ?? "…"})</Text>
    </TouchableOpacity>
  );

  if (username === null) {
    return (
      <View style={{ flex: 1, backgroundColor: COLORS.background }}>
        <LoginScreen onLogin={setUsername} />
        <View style={{ position: "absolute", bottom: 32, left: 0, right: 0, alignItems: "center" }}>{cseSettingsButton}</View>
        {cseSettingsModal}
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.screen, { justifyContent: "center", alignItems: "center" }]}>
        <Text style={styles.subtleMono}>Loading sensor data…</Text>
      </View>
    );
  }

  if (loadError || systems.every((s) => s.readings.length === 0)) {
    return (
      <View style={[styles.screen, { justifyContent: "center", alignItems: "center", padding: 24 }]}>
        <Text style={styles.subtleMono}>{loadError ?? "No recent sensor readings on the oneM2M CSE yet."}</Text>
        {cseSettingsButton}
        {cseSettingsModal}
        {bleAvailable() && (
          <TouchableOpacity onPress={() => setShowStartupBluetooth(true)} style={[styles.primaryBtn, { marginTop: 16 }]}>
            <Text style={styles.primaryBtnText}>ᛒ Sync from Pi over Bluetooth</Text>
          </TouchableOpacity>
        )}
        {/* Users with no rows land here, so they need a way back to the login screen */}
        <View style={{ marginTop: 16 }}>
          <Button title="Logout" onPress={() => setUsername(null)} color={COLORS.danger} />
        </View>
        <BluetoothModal
          visible={showStartupBluetooth}
          onClose={() => setShowStartupBluetooth(false)}
          lastDevice={startupBtDevice}
          onData={applyStartupBle}
        />
      </View>
    );
  }

  const active = systems.find((s) => s.id === activeId) ?? null;

  if (active) {
    return <SystemDetail key={active.id} hs={active} username={username} onBack={() => setActiveId(null)} updateSystem={updateSystem}
        nextFetchAt={nextFetchAt}
        btDevice={btDevices[active.id] ?? null}
        setBtDevice={(d) => setBtDevices((prev) => ({ ...prev, [active.id]: d }))}
        onBleData={(transfer) => applySystemBle(active, transfer)}
      />;
  }

  return (
    <HomeScreen
      systems={systems}
      onAdd={addSystem}
      onRemove={removeSystem}
      onLogout={() => setUsername(null)}
      locations={locations}
      setLocations={setLocations}
      onOpen={setActiveId}
      nextFetchAt={nextFetchAt}
    />
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.background },
  tabScroll: { flex: 1 },
  tabContent: { padding: 16, paddingBottom: 32 },

  card: { borderRadius: 4, padding: 14, borderWidth: 1, backgroundColor: COLORS.card, borderColor: COLORS.border, gap: 10 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowEnd: { flexDirection: "row", alignItems: "flex-end", gap: 6 },

  labelText: { fontSize: 10, letterSpacing: 1.2, textTransform: "uppercase", fontWeight: "600", color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 3 },
  glancePanel: { borderWidth: 1, borderRadius: 4, padding: 14, marginTop: 14, gap: 12, backgroundColor: COLORS.card, borderColor: COLORS.border },
  glanceSummary: { fontSize: 11, fontWeight: "700", letterSpacing: 0.8, fontFamily: MONO_FONT },
  glanceRow: { flexDirection: "row", justifyContent: "space-between" },
  glanceCol: { flex: 1, alignItems: "center", gap: 4 },
  glanceTrack: { width: 8, height: 72, borderRadius: 4, backgroundColor: COLORS.border, overflow: "visible" },
  glanceBand: { position: "absolute", left: 0, right: 0, borderRadius: 4, backgroundColor: COLORS.primary + "66" },
  glanceDot: { position: "absolute", left: -3, width: 14, height: 14, borderRadius: 7, marginBottom: -7, borderWidth: 2, borderColor: COLORS.card },
  glanceFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, borderRadius: 4 },
  glanceStatus: { fontSize: 9, fontWeight: "700", letterSpacing: 0.5, fontFamily: MONO_FONT, marginTop: 4 },
  glanceLabel: { fontSize: 9, color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  rangeBarWrap: { gap: 4 },
  rangeBarTrack: { height: 4, borderRadius: 2, backgroundColor: COLORS.border, justifyContent: "center" },
  rangeBarBand: { position: "absolute", top: 0, bottom: 0, borderRadius: 2, backgroundColor: COLORS.primary + "66" },
  rangeBarDot: { position: "absolute", width: 10, height: 10, borderRadius: 5, marginLeft: -5, borderWidth: 2, borderColor: COLORS.card },
  rangeBarLabel: { fontSize: 9, letterSpacing: 0.5, color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  sensorName: { fontSize: 15, fontWeight: "600", color: COLORS.foreground },
  sensorPart: { fontSize: 11, color: COLORS.primary, fontFamily: MONO_FONT },
  sensorLocation: { fontSize: 11, color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginBottom: 4 },
  sensorBody: { fontSize: 13, lineHeight: 19, color: COLORS.foreground },
  sensorFacts: { flexDirection: "row", gap: 12, marginTop: 8, paddingTop: 10, borderTopWidth: 1, borderColor: COLORS.border },
  sensorFact: { fontSize: 12, color: COLORS.foreground, fontFamily: MONO_FONT },
  alertBanner: { borderWidth: 1, borderRadius: 6, padding: 12, marginBottom: 14, gap: 4, backgroundColor: COLORS.danger + "18", borderColor: COLORS.danger },
  alertTitle: { fontSize: 12, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", color: COLORS.danger, fontFamily: MONO_FONT },
  alertBody: { fontSize: 12, lineHeight: 17, color: COLORS.foreground, fontFamily: MONO_FONT },
  badgeText: { fontSize: 9, letterSpacing: 0.6, fontWeight: "700", fontFamily: MONO_FONT },
  valueText: { fontSize: 28, fontWeight: "300", color: COLORS.foreground, fontFamily: MONO_FONT },
  unitText: { fontSize: 13, color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginBottom: 3 },
  rangeText: { fontSize: 10, color: COLORS.mutedForeground },

  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 18, marginBottom: 12 },
  sectionHeaderText: { fontSize: 10, letterSpacing: 2, textTransform: "uppercase", fontWeight: "600", color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  sectionHeaderLine: { flex: 1, height: 1, backgroundColor: COLORS.border },

  bottomNav: { flexDirection: "row", borderTopWidth: 1, backgroundColor: COLORS.card, borderColor: COLORS.border },
  bottomNavItem: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 10, gap: 3 },
  bottomNavIcon: { fontSize: 16, fontFamily: MONO_FONT },
  bottomNavLabel: { fontSize: 9, letterSpacing: 0.4 },
  bottomNavIndicator: { position: "absolute", top: 0, width: "60%", height: 2, backgroundColor: COLORS.primary },

  topBar: { height: 100, borderBottomWidth: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, gap: 10, backgroundColor: COLORS.card, borderColor: COLORS.border },
  backBtn: { paddingRight: 10, borderRightWidth: 1, borderColor: COLORS.border },
  backBtnText: { fontSize: 14, color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  systemNameText: { fontSize: 12, fontWeight: "500", color: COLORS.foreground, maxWidth: 110 },
  pillPh: { fontSize: 10, fontWeight: "500", fontFamily: MONO_FONT },
  pillTemp: { fontSize: 9, color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  topBarClock: { marginLeft: "auto", fontSize: 9, letterSpacing: 1, color: COLORS.mutedForeground, fontFamily: MONO_FONT },

  h1: { fontSize: 20, fontWeight: "300", color: COLORS.foreground, marginBottom: 2 },
  h1Large: { fontSize: 26, fontWeight: "300", color: COLORS.foreground },
  subtleMono: { fontSize: 11, color: COLORS.mutedForeground, fontFamily: MONO_FONT },

  connectedPill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderRadius: 3, borderColor: COLORS.border },
  connectedPillText: { fontSize: 10, fontWeight: "500", letterSpacing: 1, textTransform: "uppercase", fontFamily: MONO_FONT },

  grid2: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: 4 },
  gridItem: { width: "47%", flexGrow: 1 },
  grid3: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  settingBox: { width: "30%", flexGrow: 1, borderWidth: 1, borderRadius: 4, padding: 12, backgroundColor: COLORS.secondary, borderColor: COLORS.border },
  settingLabel: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginBottom: 6 },
  settingValue: { fontSize: 20, fontWeight: "300", color: COLORS.foreground, fontFamily: MONO_FONT },
  settingUnit: { fontSize: 12, color: COLORS.mutedForeground },

  panel: { borderWidth: 1, borderRadius: 4, padding: 16, marginBottom: 14, backgroundColor: COLORS.card, borderColor: COLORS.border, gap: 6 },
  phRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 16, padding: 10, borderRadius: 4, backgroundColor: COLORS.secondary, marginBottom: 6 },
  miniLabel: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginBottom: 4 },
  bigValue: { fontSize: 24, fontWeight: "300", color: COLORS.foreground, fontFamily: MONO_FONT },
  numInput: { width: 70, borderWidth: 1, borderRadius: 3, paddingHorizontal: 8, paddingVertical: 4, fontSize: 16, fontFamily: MONO_FONT, color: COLORS.foreground, borderColor: COLORS.border },
  miniUnit: { fontSize: 13, color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  sliderValue: { width: 56, textAlign: "right", fontSize: 13, color: COLORS.foreground, fontFamily: MONO_FONT },

  doseRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  doseBtn: { flex: 1, borderWidth: 1, borderRadius: 4, paddingVertical: 12, paddingHorizontal: 10 },
  doseBtnText: { fontSize: 13, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", fontFamily: MONO_FONT },
  doseBtnSub: { fontSize: 9, opacity: 0.7, marginTop: 3, color: COLORS.foreground },

  lightStateText: { fontSize: 13, fontWeight: "500", fontFamily: MONO_FONT },
  toggleBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 3 },
  toggleBtnText: { fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", fontFamily: MONO_FONT },

  presetRow: { flexDirection: "row", gap: 8, marginTop: 12 },
  presetBtn: { flex: 1, borderWidth: 1, borderRadius: 3, paddingVertical: 10, alignItems: "center", borderColor: COLORS.border },
  presetLabel: { fontSize: 9, letterSpacing: 0.6, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  presetValue: { fontSize: 12, fontWeight: "500", color: COLORS.foreground, marginTop: 2 },

  logRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderColor: COLORS.border },
  logTime: { fontSize: 11, color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  logType: { fontSize: 11, color: COLORS.foreground },
  logAmount: { fontSize: 11, color: COLORS.primary, fontFamily: MONO_FONT },

  visionPreview: { borderRadius: 4, overflow: "hidden", backgroundColor: "#0f1a0f", borderWidth: 1, borderColor: COLORS.border, aspectRatio: 4 / 3, marginBottom: 12 },
  visionImage: { width: "100%", height: "100%" },
  visionOverlay: { position: "absolute", bottom: 0, left: 0, right: 0, padding: 12, backgroundColor: "rgba(8,13,8,0.75)" },
  visionTime: { fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginBottom: 4 },
  visionAnalysis: { fontSize: 13, color: COLORS.foreground },
  liveBadge: { position: "absolute", top: 10, right: 10, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 3, backgroundColor: "rgba(8,13,8,0.8)", borderWidth: 1, borderColor: COLORS.border },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.primary },
  liveText: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: COLORS.primary, fontFamily: MONO_FONT },

  thumb: { width: 80, borderRadius: 3, overflow: "hidden", borderWidth: 2 },
  thumbImage: { width: "100%", height: 56 },
  thumbCaption: { padding: 4, backgroundColor: COLORS.card },
  thumbCaptionText: { fontSize: 9, color: COLORS.mutedForeground, fontFamily: MONO_FONT },

  axisText: { fontSize: 9, color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginTop: 4 },

  modalBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(8,13,8,0.85)" },
  modalSheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, borderWidth: 1, borderBottomWidth: 0, padding: 20, gap: 6, backgroundColor: COLORS.card, borderColor: COLORS.border },
  dragHandle: { width: 32, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 10, backgroundColor: COLORS.border },
  modalTitle: { fontSize: 10, letterSpacing: 2, textTransform: "uppercase", fontWeight: "600", color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  closeX: { fontSize: 14, color: COLORS.foreground, opacity: 0.6 },
  fieldLabel: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginTop: 10, marginBottom: 6 },
  textInput: { borderWidth: 1, borderRadius: 3, paddingHorizontal: 10, paddingVertical: 10, fontSize: 14, fontFamily: MONO_FONT, color: COLORS.foreground, borderColor: COLORS.border },
  pickerWrap: { borderWidth: 1, borderRadius: 3, borderColor: COLORS.border, overflow: "hidden" },

  modalBtnRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  cancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 3, borderWidth: 1, alignItems: "center", borderColor: COLORS.border },
  cancelBtnText: { fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  submitBtn: { flex: 1, paddingVertical: 12, borderRadius: 3, alignItems: "center", backgroundColor: COLORS.primary },
  submitBtnText: { fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: COLORS.primaryForeground, fontFamily: MONO_FONT },
  dangerBtn: { flex: 1, paddingVertical: 12, borderRadius: 3, alignItems: "center", backgroundColor: "rgba(248,113,113,0.18)", borderWidth: 1, borderColor: "rgba(248,113,113,0.4)" },
  dangerBtnText: { fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: COLORS.danger, fontFamily: MONO_FONT },

  emptyText: { fontSize: 12, color: COLORS.mutedForeground, textAlign: "center", paddingVertical: 16, fontFamily: MONO_FONT },
  locationRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderColor: COLORS.border },
  locationText: { fontSize: 13, color: COLORS.foreground, fontFamily: MONO_FONT },
  removeBtn: { paddingHorizontal: 8, paddingVertical: 5, borderWidth: 1, borderRadius: 3, borderColor: COLORS.border },
  removeBtnText: { fontSize: 10, color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  addBtn: { paddingHorizontal: 14, justifyContent: "center", borderRadius: 3, backgroundColor: COLORS.primary },
  addBtnText: { fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: COLORS.primaryForeground, fontFamily: MONO_FONT },
  errorText: { fontSize: 10, color: COLORS.danger, marginTop: 6, fontFamily: MONO_FONT },

  sysCard: { borderWidth: 1, borderRadius: 4, backgroundColor: COLORS.card, borderColor: COLORS.border, overflow: "hidden" },
  sysCardHeader: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", padding: 14, borderBottomWidth: 1, borderColor: COLORS.border },
  sysCardName: { fontSize: 13, fontWeight: "500", color: COLORS.foreground },
  sysCardMeta: { fontSize: 10, color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginTop: 3 },
  removeXBtn: { paddingHorizontal: 6, paddingVertical: 3, borderWidth: 1, borderRadius: 3, borderColor: COLORS.border },
  removeXText: { fontSize: 10, color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  sysCardMetrics: { flexDirection: "row", borderBottomWidth: 1, borderColor: COLORS.border },
  sysCardMetric: { flex: 1, padding: 10, borderRightWidth: 1, borderColor: COLORS.border, gap: 2 },
  sysCardMetricLabel: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  sysCardMetricValue: { fontSize: 13, fontWeight: "300", color: COLORS.foreground, fontFamily: MONO_FONT },
  sysCardFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10 },
  tag: { paddingHorizontal: 6, paddingVertical: 3, borderRadius: 3 },
  tagText: { fontSize: 9, fontFamily: MONO_FONT },
  sysCardDays: { fontSize: 9, color: COLORS.mutedForeground, fontFamily: MONO_FONT },

  btTopBtn: { width: 28, height: 28, borderRadius: 6, borderWidth: 1, alignItems: "center", justifyContent: "center", borderColor: COLORS.border },
  btIcon: { fontSize: 14, fontWeight: "700", color: COLORS.blue },
  btDeviceRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 8, borderWidth: 1, marginTop: 6, backgroundColor: COLORS.secondary, borderColor: COLORS.border },
  btConnectedBox: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 8, borderWidth: 1, marginTop: 8, backgroundColor: COLORS.secondary, borderColor: COLORS.blue },
  btDeviceName: { fontSize: 13, fontWeight: "600", color: COLORS.foreground },
  btDeviceMeta: { fontSize: 10, letterSpacing: 0.5, color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  btSmallBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: COLORS.border },
  btSmallBtnText: { fontSize: 10, letterSpacing: 1, textTransform: "uppercase", fontWeight: "600", fontFamily: MONO_FONT },
  insightText: { fontSize: 13, lineHeight: 19, color: COLORS.foreground, marginBottom: 8 },
  homeTopBar: { height: 44, borderBottomWidth: 1, flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 8, backgroundColor: COLORS.card, borderColor: COLORS.border },
  homeTopBarTitle: { fontSize: 12, fontWeight: "600", letterSpacing: 1.5, textTransform: "uppercase", color: COLORS.foreground, fontFamily: MONO_FONT },
  homeTopBarStatus: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT },

  eyebrow: { fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginBottom: 6 },
  homeActionsRow: { flexDirection: "row", gap: 10, marginTop: 16, marginBottom: 20 },
  secondaryBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 3, borderWidth: 1, borderColor: COLORS.border },
  secondaryBtnText: { fontSize: 11, fontWeight: "500", letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  historyRangeRow: { flexDirection: "row", gap: 8, marginTop: 10, marginBottom: 8 },
  historyRangeBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 3, borderWidth: 1, borderColor: COLORS.border },
  historyRangeBtnActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  historyRangeText: { fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT },
  historyRangeTextActive: { color: COLORS.primaryForeground, fontWeight: "600" },
  primaryBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 11, borderRadius: 3, backgroundColor: COLORS.primary },
  primaryBtnText: { fontSize: 11, fontWeight: "600", letterSpacing: 1, textTransform: "uppercase", color: COLORS.primaryForeground, fontFamily: MONO_FONT },

  statGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 20 },
  statBox: { width: "47%", flexGrow: 1, borderWidth: 1, borderRadius: 4, padding: 14, backgroundColor: COLORS.card, borderColor: COLORS.border },
  statLabel: { fontSize: 9, letterSpacing: 1, textTransform: "uppercase", color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginBottom: 8 },
  statValue: { fontSize: 22, fontWeight: "300", color: COLORS.foreground, fontFamily: MONO_FONT },

  emptyState: { alignItems: "center", justifyContent: "center", paddingVertical: 60, borderWidth: 1, borderStyle: "dashed", borderRadius: 4, borderColor: COLORS.border },
  emptyStateText: { fontSize: 13, color: COLORS.mutedForeground },
  emptyStateLink: { fontSize: 11, marginTop: 10, textDecorationLine: "underline", color: COLORS.primary, opacity: 0.8 },

  confirmSheet: { borderTopLeftRadius: 12, borderTopRightRadius: 12, borderWidth: 1, borderBottomWidth: 0, padding: 20, backgroundColor: COLORS.card, borderColor: COLORS.border },
  confirmTitle: { fontSize: 14, color: COLORS.foreground, marginBottom: 4 },
  confirmSub: { fontSize: 10, color: COLORS.mutedForeground, fontFamily: MONO_FONT, marginBottom: 16 },
});
