import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

test("manual retry bypasses all feeds when no source failed", async () => {
  const digest = {
    generatedAt: "2026-11-12T20:00:00.000Z",
    items: [{ source: "TLDR AI", entries: [{ headline: "既存記事" }] }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("feed must not be fetched"); };

  try {
    const env = {
      RUN_SECRET: "test",
      DIGEST_KV: {
        get: async (key) => key === "latest" ? JSON.stringify(digest) : null,
        put: async () => { throw new Error("KV must not be changed"); },
      },
    };
    const request = new Request("https://example.com/run?retry=1", {
      method: "POST",
      headers: { "x-run-secret": "test" },
    });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), digest);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
