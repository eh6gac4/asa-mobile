import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeEntries } from "../src/index.js";

const feed = { name: "Test Feed" };
const built = {
  mode: "multi",
  multiItems: [{ title: "Test", description: "Article body" }],
};

function response(status, body) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("primary model 503 falls back to lite with the same structured request", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return calls.length === 1
      ? response(503, { error: { message: "high demand" } })
      : response(200, { candidates: [{ content: { parts: [{ text: '[{"headline":"見出し","description":"説明"}]' }] } }] });
  };

  try {
    const meta = {};
    const entries = await summarizeEntries({ GEMINI_API_KEY: "test" }, feed, built, meta);
    assert.equal(entries[0].headline, "見出し");
    assert.match(calls[0].url, /gemini-3\.6-flash/);
    assert.match(calls[1].url, /gemini-3\.5-flash-lite/);
    assert.deepEqual(calls[0].body, calls[1].body);
    assert.equal(calls.length, 2);
    assert.equal(meta.model, "gemini-3.5-flash-lite");
    assert.equal(meta.fallbackFrom, "gemini-3.6-flash");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-retryable error does not switch models", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return response(400, { error: { message: "bad request" } });
  };

  try {
    await assert.rejects(
      summarizeEntries({ GEMINI_API_KEY: "test" }, feed, built),
      /status 400/,
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
