import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    resolveMetaApiKey: vi.fn(),
    fetchWithTimeout: vi.fn(
      async (
        _url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse();
        return await options.consume(response, new AbortController().signal);
      },
    ),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

vi.mock("../src/lib/meta-config.js", () => ({
  resolveMetaApiKey: mocks.resolveMetaApiKey,
}));

import { _parseMetaSubscriptionUsage, _selectProbeModel, queryMetaQuota } from "../src/lib/meta.js";

function mockJsonResponse(params: { ok: boolean; status: number; json?: unknown; text?: string }) {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: params.ok,
    status: params.status,
    text: async () => params.text ?? JSON.stringify(params.json),
  });
}

function mockSseResponse(lines: string[]) {
  const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  });
}

const modelsPayload = {
  object: "list",
  data: [{ id: "muse-spark-1.3-contributor" }, { id: "muse-spark-1.3" }, { id: "muse-spark-1.2" }],
};

const subscriptionSse = [
  'data: {"type":"response.created"}',
  'data: {"type":"response.in_progress"}',
  'data: {"type":"response.subscription_usage","subscription":{"tier":"123","window":{"used_percent":1,"resets_at":1789325875,"window_duration_mins":300},"weekly":{"used_percent":26,"resets_at":1789344000}}}',
  "data: [DONE]",
];

describe("queryMetaQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveMetaApiKey.mockResolvedValue({
      key: "meta-secret-key",
      source: "env:META_MODEL_API_KEY",
    });
  });

  it("returns null without a configured API key", async () => {
    mocks.resolveMetaApiKey.mockResolvedValueOnce(null);

    await expect(queryMetaQuota()).resolves.toBeNull();
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("discovers the probe model from the free models roster", async () => {
    mockJsonResponse({ ok: true, status: 200, json: modelsPayload });
    mockSseResponse(subscriptionSse);

    await queryMetaQuota();

    expect(mocks.fetchWithTimeout).toHaveBeenNthCalledWith(
      1,
      "https://api.meta.ai/v1/models",
      expect.objectContaining({
        request: {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: "Bearer meta-secret-key",
          },
          redirect: "manual",
        },
      }),
    );
    const probeBody = JSON.parse(
      String(mocks.fetchWithTimeout.mock.calls[1]?.[1]?.request.body),
    ) as Record<string, unknown>;
    expect(mocks.fetchWithTimeout).toHaveBeenNthCalledWith(
      2,
      "https://api.meta.ai/v1/responses",
      expect.objectContaining({
        request: expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer meta-secret-key",
          }),
        }),
      }),
    );
    expect(probeBody).toEqual({
      model: "muse-spark-1.3",
      input: "Reply with exactly: ok",
      stream: true,
      max_output_tokens: 16,
      reasoning: { effort: "minimal" },
    });
  });

  it("falls back to the default probe model when the roster is unavailable", async () => {
    mockJsonResponse({ ok: false, status: 500, text: "boom" });
    mockSseResponse(subscriptionSse);

    await queryMetaQuota();

    const probeBody = JSON.parse(
      String(mocks.fetchWithTimeout.mock.calls[1]?.[1]?.request.body),
    ) as Record<string, unknown>;
    expect(probeBody.model).toBe("muse-spark-1.3");
  });

  it("parses subscription windows from the quota SSE event", async () => {
    mockJsonResponse({ ok: true, status: 200, json: modelsPayload });
    mockSseResponse(subscriptionSse);

    const out = await queryMetaQuota();
    expect(out).toEqual({
      success: true,
      fiveHour: {
        usagePercent: 1,
        percentRemaining: 99,
        resetTimeIso: new Date(1789325875 * 1000).toISOString(),
      },
      weekly: {
        usagePercent: 26,
        percentRemaining: 74,
        resetTimeIso: new Date(1789344000 * 1000).toISOString(),
      },
    });
  });

  it("reports a missing quota event for non-subscription keys", async () => {
    mockJsonResponse({ ok: true, status: 200, json: modelsPayload });
    mockSseResponse(['data: {"type":"response.completed"}']);

    const out = await queryMetaQuota();
    expect(out).toEqual({
      success: false,
      error:
        "Meta API returned no subscription usage event; quota windows need a subscription-linked key",
    });
  });

  it("maps probe HTTP errors with the key redacted", async () => {
    mockJsonResponse({ ok: true, status: 200, json: modelsPayload });
    mockJsonResponse({ ok: false, status: 401, text: "bad key meta-secret-key" });

    const out = await queryMetaQuota();
    expect(out).toEqual({
      success: false,
      error: "Meta API error 401: bad key [redacted]",
    });
  });

  it("passes a configured request timeout", async () => {
    mockJsonResponse({ ok: true, status: 200, json: modelsPayload });
    mockSseResponse(subscriptionSse);

    await queryMetaQuota({ requestTimeoutMs: 1234 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeoutMs: 1234 }),
    );
  });
});

describe("selectProbeModel", () => {
  it("prefers a non-contributor muse-spark model", () => {
    expect(_selectProbeModel(modelsPayload)).toBe("muse-spark-1.3");
  });

  it("falls back to contributor, then any model, then the default", () => {
    expect(_selectProbeModel({ data: [{ id: "muse-spark-1.2-contributor" }] })).toBe(
      "muse-spark-1.2-contributor",
    );
    expect(_selectProbeModel({ data: [{ id: "other-model" }] })).toBe("other-model");
    expect(_selectProbeModel({})).toBe("muse-spark-1.3");
    expect(_selectProbeModel(null)).toBe("muse-spark-1.3");
  });
});

describe("parseMetaSubscriptionUsage", () => {
  it("rejects non-object payloads", () => {
    expect(_parseMetaSubscriptionUsage(null)).toEqual({
      success: false,
      error: "Meta API returned an unexpected subscription usage shape",
    });
  });

  it("reports row errors but keeps valid windows", () => {
    expect(
      _parseMetaSubscriptionUsage({
        window: { used_percent: 10, resets_at: 1789325875 },
        weekly: { used_percent: "lots", resets_at: 1789344000 },
      }),
    ).toEqual({
      success: true,
      fiveHour: {
        usagePercent: 10,
        percentRemaining: 90,
        resetTimeIso: new Date(1789325875 * 1000).toISOString(),
      },
      rowErrors: ["Weekly: ignored invalid used_percent"],
    });
  });

  it("fails when no window is usable", () => {
    expect(_parseMetaSubscriptionUsage({})).toEqual({
      success: false,
      error: "Meta API returned no usable subscription windows",
    });
  });
});
