import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  getMetaKeyDiagnostics: vi.fn(),
  hasMetaApiKey: vi.fn(),
  isCanonicalProviderAvailable: vi.fn(),
  queryMetaQuota: vi.fn(),
}));

vi.mock("../src/lib/meta-config.js", () => ({
  getMetaKeyDiagnostics: mocks.getMetaKeyDiagnostics,
  hasMetaApiKey: mocks.hasMetaApiKey,
}));

vi.mock("../src/lib/meta.js", () => ({
  queryMetaQuota: mocks.queryMetaQuota,
}));

vi.mock("../src/lib/provider-availability.js", () => ({
  isCanonicalProviderAvailable: mocks.isCanonicalProviderAvailable,
}));

import { metaProvider } from "../src/providers/meta.js";

async function runProviderFetch(config: Record<string, unknown> = {}) {
  return metaProvider.fetch({ config } as never);
}

describe("meta provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMetaKeyDiagnostics.mockResolvedValue({
      configured: true,
      source: "env:META_MODEL_API_KEY",
      checkedPaths: ["env:META_MODEL_API_KEY"],
      authPaths: ["/tmp/auth.json"],
    });
  });

  it("returns attempted:false when no API key is configured", async () => {
    mocks.queryMetaQuota.mockResolvedValueOnce(null);

    const out = await runProviderFetch();

    expectNotAttempted(out);
    expect(out.statusDetails).toContainEqual({ key: "api_key_configured", value: "true" });
  });

  it("maps 5h and weekly quota entries", async () => {
    mocks.queryMetaQuota.mockResolvedValueOnce({
      success: true,
      fiveHour: {
        usagePercent: 1,
        percentRemaining: 99,
        resetTimeIso: "2026-09-20T00:00:00.000Z",
      },
      weekly: {
        usagePercent: 26,
        percentRemaining: 74,
        resetTimeIso: "2026-09-21T00:00:00.000Z",
      },
    });

    const out = await runProviderFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "meta")).toEqual([
      {
        name: "Muse 5h",
        group: "Muse",
        label: "5h:",
        percentRemaining: 99,
        resetTimeIso: "2026-09-20T00:00:00.000Z",
      },
      {
        name: "Muse Weekly",
        group: "Muse",
        label: "Weekly:",
        percentRemaining: 74,
        resetTimeIso: "2026-09-21T00:00:00.000Z",
      },
    ]);
    expect(out.entries.map((entry) => entry.accounting)).toEqual([
      {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "api_key_source", value: "env:META_MODEL_API_KEY" },
        { key: "five_hour_usage_percent", value: "1" },
        { key: "weekly_usage_percent", value: "26" },
      ]),
    );
  });

  it("keeps valid entries and exposes row-level response errors", async () => {
    mocks.queryMetaQuota.mockResolvedValueOnce({
      success: true,
      fiveHour: {
        usagePercent: 1,
        percentRemaining: 99,
      },
      rowErrors: ["Weekly: ignored invalid used_percent"],
    });

    const out = await runProviderFetch();

    expect(out.attempted).toBe(true);
    expect(out.entries).toHaveLength(1);
    expect(out.errors[0]?.label).toBe("Muse");
    expect(out.errors[0]?.message).toBe("Weekly: ignored invalid used_percent");
    expect(out.statusDetails).toContainEqual({
      key: "live_error_1",
      value: "Weekly: ignored invalid used_percent",
    });
  });

  it("maps provider errors into quota errors", async () => {
    mocks.queryMetaQuota.mockResolvedValueOnce({
      success: false,
      error: "Meta API error 401: bad key",
    });

    const out = await runProviderFetch();
    expectAttemptedWithErrorLabel(out, "Muse");
  });

  it("passes the effective request timeout", async () => {
    mocks.queryMetaQuota.mockResolvedValue({
      success: true,
      weekly: { usagePercent: 10, percentRemaining: 90 },
    });

    await runProviderFetch({ requestTimeoutMs: 1234, requestTimeoutMsConfigured: true });
    expect(mocks.queryMetaQuota).toHaveBeenLastCalledWith({ requestTimeoutMs: 1234 });

    await runProviderFetch({ requestTimeoutMs: 5678, requestTimeoutMsConfigured: false });
    expect(mocks.queryMetaQuota).toHaveBeenLastCalledWith({ requestTimeoutMs: 5678 });
  });

  it("is available when canonical provider metadata is available", async () => {
    mocks.isCanonicalProviderAvailable.mockResolvedValueOnce(true);

    await expect(metaProvider.isAvailable({} as never)).resolves.toBe(true);
    expect(mocks.isCanonicalProviderAvailable).toHaveBeenCalledWith({
      ctx: {},
      providerId: "meta",
      fallbackOnError: false,
    });
  });

  it("falls back to trusted API key presence when provider metadata is absent", async () => {
    mocks.isCanonicalProviderAvailable.mockResolvedValueOnce(false);
    mocks.hasMetaApiKey.mockResolvedValueOnce(true);

    await expect(metaProvider.isAvailable({} as never)).resolves.toBe(true);
  });

  it("matches meta models only", () => {
    expect(metaProvider.matchesCurrentModel("meta/muse-spark-1.3")).toBe(true);
    expect(metaProvider.matchesCurrentModel("openai/gpt-5")).toBe(false);
  });
});
