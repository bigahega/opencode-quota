/**
 * Meta (Muse) provider wrapper.
 *
 * Spends one minimal streaming probe turn per refresh to read the
 * `response.subscription_usage` SSE event; Meta exposes no pollable usage
 * endpoint. Reports the subscription 5-hour and weekly windows.
 */

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { queryMetaQuota } from "../lib/meta.js";
import { getMetaKeyDiagnostics, hasMetaApiKey } from "../lib/meta-config.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderMatchesRuntimeId } from "../lib/provider-model-matching.js";
import type { MetaQuotaResult } from "../lib/types.js";
import {
  attemptedResult,
  mapNullableProviderResult,
  simpleApiKeyStatusDetails,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const META_PROVIDER_LABEL = "Muse";
const REMOTE_API_ACCOUNTING = {
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

type MetaQuotaSuccess = Extract<MetaQuotaResult, { success: true }>;

function mapMetaQuotaSuccess(result: MetaQuotaSuccess): QuotaProviderResult {
  const entries: QuotaToastEntry[] = [];

  if (result.fiveHour) {
    entries.push({
      accounting: {
        resultType: "quota",
        ...REMOTE_API_ACCOUNTING,
      },
      name: `${META_PROVIDER_LABEL} 5h`,
      group: META_PROVIDER_LABEL,
      label: "5h:",
      percentRemaining: result.fiveHour.percentRemaining,
      ...(result.fiveHour.resetTimeIso ? { resetTimeIso: result.fiveHour.resetTimeIso } : {}),
    });
  }

  if (result.weekly) {
    entries.push({
      accounting: {
        resultType: "quota",
        ...REMOTE_API_ACCOUNTING,
      },
      name: `${META_PROVIDER_LABEL} Weekly`,
      group: META_PROVIDER_LABEL,
      label: "Weekly:",
      percentRemaining: result.weekly.percentRemaining,
      ...(result.weekly.resetTimeIso ? { resetTimeIso: result.weekly.resetTimeIso } : {}),
    });
  }

  const errors = (result.rowErrors ?? []).map((message) => ({
    label: META_PROVIDER_LABEL,
    message,
  }));
  if (entries.length === 0) {
    errors.push({
      label: META_PROVIDER_LABEL,
      message: "No usable Meta subscription windows",
    });
  }

  return withStatusDetails(attemptedResult(entries, errors), [
    ...statusDetailsFromRecord({
      five_hour_usage_percent: result.fiveHour?.usagePercent.toString(),
      weekly_usage_percent: result.weekly?.usagePercent.toString(),
    }),
    ...(result.rowErrors ?? []).map((message, index) => ({
      key: `live_error_${index + 1}`,
      value: message,
    })),
  ]);
}

export const metaProvider: QuotaProvider = {
  id: "meta",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const providerAvailable = await isCanonicalProviderAvailable({
      ctx,
      providerId: "meta",
      fallbackOnError: false,
    });
    if (providerAvailable) return true;

    return await hasMetaApiKey();
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderMatchesRuntimeId(model, "meta");
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const diagnostics = await getMetaKeyDiagnostics().catch(() => ({
      configured: false,
      source: null,
      checkedPaths: [],
      authPaths: [],
    }));
    const result = await queryMetaQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMs,
    });
    const providerResult = mapNullableProviderResult(result, {
      errorLabel: META_PROVIDER_LABEL,
      onSuccess: mapMetaQuotaSuccess,
    });

    return withStatusDetails(providerResult, [
      ...simpleApiKeyStatusDetails(diagnostics),
      ...(providerResult.statusDetails ?? []),
    ]);
  },
};
