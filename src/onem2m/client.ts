/**
 * oneM2M client for the HydroPi CSE (ACME), HTTP binding.
 *
 * The app finds systems by discovering AEs labelled "type:hydropi", then reads each AE's
 * "readings" timeSeries for a recent time window. Each instance's content is the same record
 * the Pi sends to Supabase and over Bluetooth, so screens map it with the usual rowToReading.
 * Query forms are the ones checked against ACME 2026.5.3 (see HydroponicPiLogic docs/onem2m.md):
 * "last N by offset" is unreliable there, so recent data is fetched by creation time (cra).
 *
 * The app's only write is an on-demand request (requestFromPi): it posts into the Pi's
 * "requests" container, where its access policy allows CREATE and nothing else, and reads the
 * Pi's answer from "responses". The Pi checks for requests every few seconds.
 */

export interface OneM2MSettings {
  cseUrl: string; // e.g. http://192.168.1.50:8080 (the Pi's LAN address)
  cseRn: string; // CSEBase resource name, e.g. cse-hydropi
  originator: string; // read-only originator the Pi's ACP allows, e.g. CHydroOS-app
  token: string; // bearer token (its hash is in the CSE's token file)
}

export const HYDROPI_LABEL = "type:hydropi";
const TIMEOUT_MS = 8000;

export class OneM2MError extends Error {
  constructor(message: string, readonly status?: number, readonly rsc?: number) {
    super(message);
  }
}

let requestCounter = 0;

async function retrieve(settings: OneM2MSettings, path: string, query = ""): Promise<any> {
  return send(settings, "GET", path, query);
}

// One HTTP request with the oneM2M headers. A body means a create (ty = resource type).
async function send(settings: OneM2MSettings, method: "GET" | "POST", path: string, query = "",
                    payload?: unknown, ty?: number): Promise<any> {
  const base = settings.cseUrl.replace(/\/+$/, "");
  const url = `${base}/${path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = {
    "X-M2M-Origin": settings.originator,
    "X-M2M-RI": `app-${Date.now()}-${requestCounter++}`,
    "X-M2M-RVI": "3",
    Accept: "application/json",
  };
  if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
  if (payload !== undefined) headers["Content-Type"] = `application/json${ty ? `;ty=${ty}` : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e: any) {
    const reason = e?.name === "AbortError" ? "timed out" : "not reachable";
    throw new OneM2MError(`The oneM2M CSE at ${base} is ${reason}. Check the address and that the phone is on the Pi's network.`);
  } finally {
    clearTimeout(timer);
  }

  const rsc = Number(res.headers.get("X-M2M-RSC")) || undefined;
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    if (res.status === 401) throw new OneM2MError("The CSE rejected the token. Check it in oneM2M settings.", 401, rsc);
    const detail = body && typeof body === "object" && body["m2m:dbg"] ? `: ${body["m2m:dbg"]}` : "";
    throw new OneM2MError(`CSE request failed (${res.status}${rsc ? `/${rsc}` : ""})${detail}`, res.status, rsc);
  }
  return body;
}

/** oneM2M absolute time (UTC), e.g. 20261115T062455 */
function oneM2MTime(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15);
}

/** Paths of every HydroPi AE the originator may see, e.g. ["cse-hydropi/HydroPi-3f9a0c12"] */
export async function discoverSystems(settings: OneM2MSettings): Promise<string[]> {
  const body = await retrieve(settings, settings.cseRn, `fu=1&ty=2&lbl=${encodeURIComponent(HYDROPI_LABEL)}`);
  const uris = body?.["m2m:uril"];
  return Array.isArray(uris) ? uris : [];
}

/** Reading records (timeSeriesInstance contents) created in the last `windowMs`, any order. */
export async function fetchRecentRecords(settings: OneM2MSettings, aePath: string, windowMs: number): Promise<any[]> {
  const since = oneM2MTime(Date.now() - windowMs);
  const body = await retrieve(settings, `${aePath}/readings`, `rcn=4&fu=2&ty=30&cra=${since}`);
  const instances = body?.["m2m:ts"]?.["m2m:tsi"];
  if (!Array.isArray(instances)) return [];
  return instances.map((tsi) => (typeof tsi.con === "string" ? safeParse(tsi.con) : tsi.con)).filter((c) => c && typeof c === "object");
}

/** All systems' recent records, flattened; each carries its own system_name. */
export async function fetchAllRecentRecords(settings: OneM2MSettings, windowMs: number): Promise<any[]> {
  const systems = await discoverSystems(settings);
  const perSystem = await Promise.all(systems.map((ae) => fetchRecentRecords(settings, ae, windowMs)));
  return perSystem.flat();
}

/** Newest camera metrics across systems (the vision container's latest instance), or null. */
export async function fetchLatestVision(settings: OneM2MSettings): Promise<{ con: any; ct: string } | null> {
  const systems = await discoverSystems(settings);
  let newest: { con: any; ct: string } | null = null;
  for (const ae of systems) {
    try {
      const cin = (await retrieve(settings, `${ae}/vision/la`))?.["m2m:cin"];
      if (cin && (!newest || cin.ct > newest.ct)) newest = { con: typeof cin.con === "string" ? safeParse(cin.con) : cin.con, ct: cin.ct };
    } catch (e) {
      if (!(e instanceof OneM2MError && e.status === 404)) throw e; // no metrics yet is fine
    }
  }
  return newest;
}

/** The AE path of the system with this display name (the Pi labels its AE system:<name>), or null. */
export async function findSystemAE(settings: OneM2MSettings, systemName: string): Promise<string | null> {
  // Only the system label: several lbl values in one discovery mean "any of them", not "all"
  const body = await retrieve(settings, settings.cseRn, `fu=1&ty=2&lbl=${encodeURIComponent(`system:${systemName}`)}`);
  const uris = body?.["m2m:uril"];
  return Array.isArray(uris) && uris.length > 0 ? uris[0] : null;
}

// ─── On-demand requests (answered by the Pi from its own database) ───────────

export type PiRequest =
  | { op: "latest" }
  | { op: "history"; since: string; until?: string; step_s?: number; limit?: number };

export interface PiReply {
  status: number; // 200 ok, 400 bad request, 404 nothing to return, 500 error on the Pi
  records: any[]; // the usual reading records (rowToReading), oldest first
  truncated: boolean; // more matched than the Pi returns; the newest were kept
  error?: string;
}

const TY_CONTENT_INSTANCE = 4;

/**
 * Ask the Pi for data the CSE doesn't hold, e.g. history older than ~2 days.
 * Posts a request into <ae>/requests, then polls <ae>/responses for the answer's parts (labelled
 * rqi:<id>) until all have arrived. The Pi checks every ~3 s, so expect a few seconds' wait.
 */
export async function requestFromPi(
  settings: OneM2MSettings,
  aePath: string,
  request: PiRequest,
  { timeoutMs = 20000, pollMs = 1000 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<PiReply> {
  const rqi = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  // When this app stops waiting: the Pi skips the request after that instead of answering late
  const deadline = new Date(Date.now() + timeoutMs).toISOString();
  try {
    await send(settings, "POST", `${aePath}/requests`, "", { "m2m:cin": { con: { rqi, deadline, ...request } } }, TY_CONTENT_INSTANCE);
  } catch (e) {
    if (e instanceof OneM2MError && (e.status === 404 || e.rsc === 4004)) {
      throw new OneM2MError("This Pi doesn't take requests yet (its software needs updating).", e.status, e.rsc);
    }
    if (e instanceof OneM2MError && (e.status === 403 || e.rsc === 4103)) {
      throw new OneM2MError("This Pi doesn't accept requests from this app (check the originator in oneM2M settings).", e.status, e.rsc);
    }
    throw e;
  }

  const parts = new Map<number, any>(); // part number -> content (duplicates from a retry collapse)
  const giveUpAt = Date.now() + timeoutMs;
  while (Date.now() < giveUpAt) {
    await new Promise((r) => setTimeout(r, pollMs));
    const body = await retrieve(settings, `${aePath}/responses`, `rcn=4&fu=2&ty=4&lbl=${encodeURIComponent(`rqi:${rqi}`)}`);
    const instances = body?.["m2m:cnt"]?.["m2m:cin"];
    for (const cin of Array.isArray(instances) ? instances : []) {
      const con = typeof cin.con === "string" ? safeParse(cin.con) : cin.con;
      if (con && con.rqi === rqi && Number.isInteger(con.part)) parts.set(con.part, con);
    }
    const first = parts.get(1);
    if (first && parts.size >= first.of) {
      const ordered = [...parts.values()].sort((a, b) => a.part - b.part);
      return {
        status: first.status,
        records: ordered.flatMap((p) => (Array.isArray(p.records) ? p.records : [])),
        truncated: ordered.some((p) => p.truncated === true),
        error: first.error,
      };
    }
  }
  throw new OneM2MError(`The Pi didn't answer within ${Math.round(timeoutMs / 1000)} s. It may be offline.`);
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
