/**
 * Meta (Muse) subscription quota client.
 *
 * Meta exposes no pollable usage endpoint and no quota response headers:
 * subscription quota arrives only as a `response.subscription_usage` SSE event
 * on streaming `POST /v1/responses` calls. This client spends one minimal probe
 * turn (tiny input, 16 output tokens max, minimal reasoning) and parses that
 * event into 5-hour + weekly windows.
 *
 * Probe model discovery reuses the free `GET /v1/models` roster and prefers a
 * non-contributor `muse-spark-*` model. The stream is cancelled as soon as the
 * quota event arrives so the probe never pays for a full completion.
 */

import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import { resolveMetaApiKey } from "./meta-config.js";
import type { MetaQuotaResult, MetaQuotaWindow } from "./types.js";

const META_API_BASE_URL = "https://api.meta.ai/v1";
const META_MODELS_URL = `${META_API_BASE_URL}/models`;
const META_RESPONSES_URL = `${META_API_BASE_URL}/responses`;
const MAX_RESPONSE_BYTES = 256 * 1024;
const FALLBACK_PROBE_MODEL = "muse-spark-1.3";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeRemoteSingleLineText(text: string): string {
  return sanitizeSingleLineDisplayText(text).replace(/\p{Cf}/gu, "");
}

function sanitizeMessage(text: string, secret?: string, maxLength = 200): string {
  const redacted = secret ? text.split(secret).join("[redacted]") : text;
  const sanitized = sanitizeRemoteSingleLineText(redacted);
  return (sanitized || "unknown").slice(0, maxLength);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`Meta API response exceeded ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error(`Meta API response exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function selectProbeModel(payload: unknown): string {
  if (isRecord(payload) && Array.isArray(payload.data)) {
    const ids = payload.data
      .map((entry) => (isRecord(entry) ? entry.id : undefined))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const spark = ids.filter((id) => id.startsWith("muse-spark-"));
    const standard = spark.find((id) => !id.includes("contributor"));
    if (standard) return standard;
    if (spark[0]) return spark[0];
    if (ids[0]) return ids[0];
  }
  return FALLBACK_PROBE_MODEL;
}

function parseSubscriptionUsageEvent(payload: unknown): JsonRecord | undefined {
  if (!isRecord(payload)) return undefined;
  if (payload.type !== "response.subscription_usage") return undefined;
  return isRecord(payload.subscription) ? payload.subscription : undefined;
}

function normalizeResetTimeIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function parseWindow(
  value: unknown,
  label: string,
  rowErrors: string[],
): MetaQuotaWindow | undefined {
  if (!isRecord(value)) {
    rowErrors.push(`${label}: expected an object`);
    return undefined;
  }
  const usedPercent = value.used_percent;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0) {
    rowErrors.push(`${label}: ignored invalid used_percent`);
    return undefined;
  }
  const window: MetaQuotaWindow = {
    usagePercent: usedPercent,
    percentRemaining: 100 - usedPercent,
  };
  const resetTimeIso = normalizeResetTimeIso(value.resets_at);
  if (resetTimeIso) {
    window.resetTimeIso = resetTimeIso;
  } else {
    rowErrors.push(`${label}: ignored invalid resets_at`);
  }
  return window;
}

function parseMetaSubscriptionUsage(payload: unknown): MetaQuotaResult {
  if (!isRecord(payload)) {
    return {
      success: false,
      error: "Meta API returned an unexpected subscription usage shape",
    };
  }

  const rowErrors: string[] = [];
  const fiveHour = parseWindow(payload.window, "5h", rowErrors);
  const weekly = parseWindow(payload.weekly, "Weekly", rowErrors);

  if (!fiveHour && !weekly) {
    return {
      success: false,
      error: "Meta API returned no usable subscription windows",
    };
  }

  return {
    success: true,
    ...(fiveHour ? { fiveHour } : {}),
    ...(weekly ? { weekly } : {}),
    ...(rowErrors.length > 0 ? { rowErrors } : {}),
  };
}

async function readSubscriptionUsageFromStream(
  response: Response,
  maxBytes: number,
): Promise<JsonRecord | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        byteLength += value.byteLength;
        if (byteLength > maxBytes) {
          await reader.cancel();
          throw new Error(`Meta API response exceeded ${maxBytes} bytes`);
        }
        buffer += decoder.decode(value, { stream: true });
      }
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data && data !== "[DONE]") {
            try {
              const event = parseSubscriptionUsageEvent(JSON.parse(data) as unknown);
              if (event) {
                await reader.cancel();
                return event;
              }
            } catch {
              // Ignore non-JSON SSE payloads; the quota event may arrive later.
            }
          }
        }
        newlineIndex = buffer.indexOf("\n");
      }
      if (done) break;
    }
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

async function resolveProbeModel(apiKey: string, requestTimeoutMs?: number): Promise<string> {
  try {
    return await fetchWithTimeout<string>(META_MODELS_URL, {
      request: {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        redirect: "manual",
      },
      timeoutMs: requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) return FALLBACK_PROBE_MODEL;
        const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
        return selectProbeModel(JSON.parse(text) as unknown);
      },
    });
  } catch {
    return FALLBACK_PROBE_MODEL;
  }
}

export async function queryMetaQuota(
  options: { requestTimeoutMs?: number } = {},
): Promise<MetaQuotaResult> {
  const resolved = await resolveMetaApiKey();
  if (!resolved) return null;

  try {
    const model = await resolveProbeModel(resolved.key, options.requestTimeoutMs);
    return await fetchWithTimeout(META_RESPONSES_URL, {
      request: {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${resolved.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: "Reply with exactly: ok",
          stream: true,
          max_output_tokens: 16,
          reasoning: { effort: "minimal" },
        }),
        redirect: "manual",
      },
      timeoutMs: options.requestTimeoutMs,
      consume: async (response) => {
        if (!response.ok) {
          const text = await readBoundedText(response, MAX_RESPONSE_BYTES).catch(() => "");
          const snippet = sanitizeMessage(text, resolved.key);
          return {
            success: false,
            error: `Meta API error ${response.status}: ${snippet}`,
          };
        }
        const subscription = await readSubscriptionUsageFromStream(response, MAX_RESPONSE_BYTES);
        if (!subscription) {
          return {
            success: false,
            error:
              "Meta API returned no subscription usage event; quota windows need a subscription-linked key",
          };
        }
        return parseMetaSubscriptionUsage(subscription);
      },
    });
  } catch (error) {
    return {
      success: false,
      error: sanitizeMessage(error instanceof Error ? error.message : String(error), resolved.key),
    };
  }
}

export {
  parseMetaSubscriptionUsage as _parseMetaSubscriptionUsage,
  selectProbeModel as _selectProbeModel,
};
