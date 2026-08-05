import { XMLParser } from "fast-xml-parser";

// 取得するRSSフィード一覧。
// mode: "single" -> 週刊フィード。最新1件のみ使用。cronは月曜のみ取得する(isWeeklyRefreshDay参照)
// mode: "multi"  -> 日刊フィード。直近5件を連結して1週間分として扱う。cronは毎日取得する
const FEEDS = [
  {
    name: "Android Weekly",
    url: "https://androidweekly.net/rss.xml",
    mode: "single",
  },
  {
    name: "iOS Dev Weekly",
    url: "https://iosdevweekly.com/issues.rss",
    mode: "single",
  },
  {
    name: "TLDR AI",
    // TLDR公式はメール配信のみでRSSを提供していないため非公式ミラーを使用。
    // ミラーが停止・URL変更した場合はここが動かなくなる（README/HANDOFF参照）。
    url: "https://bullrich.dev/tldr-rss/ai.rss",
    mode: "multi",
  },
];

const MULTI_ITEM_LIMIT = 5;
const GEMINI_MODEL = "gemini-3.6-flash";

// Gemini APIの一時エラー(高負荷時の503等)向けリトライ設定。
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // 標準entity(&lt; &gt; &quot; 等)がRSS本文中に大量出現するフィードがあり、
  // デフォルトの上限(1000)だと billion-laughs対策の上限に誤爆する。実測18939件
  // (iOS Dev Weekly)を踏まえ余裕を持った値に引き上げる。
  processEntities: { maxTotalExpansions: 50000 },
});

/**
 * RSS内のHTMLタグを簡易的に除去する。
 * 凝ったマークアップだと余計な空白やノイズが残る可能性がある（既知の技術的負債）。
 */
function stripHtml(html) {
  return String(html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

async function fetchFeedItems(feedUrl) {
  const res = await fetch(feedUrl, {
    headers: { "User-Agent": "asa-mobile-digest-bot/1.0" },
  });
  if (!res.ok) {
    throw new Error(`RSS取得失敗: ${feedUrl} (status ${res.status})`);
  }
  const xml = await res.text();
  const parsed = xmlParser.parse(xml);
  const items = toArray(parsed?.rss?.channel?.item);
  if (items.length === 0) {
    throw new Error(`RSSにitemが見つからない: ${feedUrl}`);
  }
  return items;
}

/**
 * itemのリンクURLを取り出す。<link> が無いフィード(TLDR AIミラー等)は
 * <guid isPermaLink="true"> にURLを持つため、そちらにフォールバックする。
 */
function extractLink(item) {
  if (typeof item?.link === "string" && item.link) return item.link;
  const linkText = item?.link?.["#text"];
  if (typeof linkText === "string" && linkText) return linkText;
  if (typeof item?.guid === "string" && item.guid) return item.guid;
  const guidText = item?.guid?.["#text"];
  if (typeof guidText === "string" && guidText) return guidText;
  return "";
}

function buildSourceContent(feed, items) {
  const picked = feed.mode === "single" ? items.slice(0, 1) : items.slice(0, MULTI_ITEM_LIMIT);

  const combined = picked
    .map((item) => {
      const title = stripHtml(item.title);
      const description = stripHtml(item.description ?? item["content:encoded"]);
      return `# ${title}\n${description}`;
    })
    .join("\n\n---\n\n");

  return {
    combinedText: combined,
    latestLink: extractLink(picked[0]),
  };
}

/**
 * Gemini APIに要約を依頼する。
 *
 * 注意: Gemini 3.x系では temperature / top_p / top_k が廃止されており、
 * generationConfig.thinkingConfig.thinkingLevel で思考量を制御する方式になっている。
 * 古いパラメータは渡さないこと。
 *
 * 429/5xx (高負荷時の503等)は一時的なエラーとみなし、指数バックオフでリトライする。
 * Retry-Afterヘッダがあればそちらを優先する（上限あり）。
 */
async function summarize(env, sourceName, text) {
  const prompt =
    `以下は「${sourceName}」というニュースレターの直近の内容です。` +
    `日本語で3〜5個の箇条書きに要約してください。前置きや結びの文は不要、箇条書きのみ出力してください。\n\n${text}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          thinkingConfig: { thinkingLevel: "low" },
        },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const summaryText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!summaryText) {
        throw new Error(`Gemini APIレスポンスの形式が想定外 (${sourceName}): ${JSON.stringify(data)}`);
      }
      return summaryText.trim();
    }

    const errBody = await res.text().catch(() => "");
    lastErr = new Error(`Gemini API失敗 (${sourceName}): status ${res.status} ${errBody}`);

    const retryable = RETRYABLE_STATUS.has(res.status);
    if (!retryable || attempt === MAX_ATTEMPTS) {
      throw lastErr;
    }

    const retryAfterSec = Number(res.headers.get("Retry-After"));
    const delayMs =
      Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, RETRY_MAX_DELAY_MS)
        : Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
    await sleep(delayMs);
  }

  throw lastErr;
}

/**
 * 1フィードを取得・要約する。generateDigest/retryFailedSourcesの両方から使う。
 */
async function processFeedSource(env, feed) {
  const items = await fetchFeedItems(feed.url);
  const { combinedText, latestLink } = buildSourceContent(feed, items);
  const summary = await summarize(env, feed.name, combinedText);
  return {
    source: feed.name,
    title: stripHtml(items[0]?.title),
    link: latestLink,
    summary,
  };
}

/**
 * 指定フィードを取得・要約してKVに保存する。
 * フィード単位でtry/catchし、1つ失敗しても他は続行する。
 *
 * feedsToProcess を渡さない場合は全フィードが対象(手動実行の /run 用)。
 * 渡した場合、対象外のフィード(例: 月曜以外の日のAndroid/iOS Weekly)は
 * 取得を行わず、KVに残っている前回の結果をそのまま引き継ぐ。
 *
 * リトライ後もなお失敗したソースは、KVに残っている前回成功分を代わりに使い
 * (stale: trueを付与)、表示が「取得失敗」で丸ごと潰れないようにする。
 * 前回分も無ければ従来通りエラーを記録する。
 */
async function generateDigest(env, feedsToProcess = FEEDS) {
  const prevRaw = await env.DIGEST_KV.get("latest");
  const prevDigest = prevRaw ? JSON.parse(prevRaw) : null;
  const prevBySource = new Map();
  if (prevDigest) {
    for (const item of prevDigest.items) {
      prevBySource.set(item.source, item);
    }
  }

  const nowISO = new Date().toISOString();
  const targetNames = new Set(feedsToProcess.map((f) => f.name));
  const results = [];

  for (const feed of FEEDS) {
    if (!targetNames.has(feed.name)) {
      // 今回は対象外(例: 週次ソースを非月曜に実行しない)。前回の結果を維持する。
      const prevItem = prevBySource.get(feed.name);
      if (prevItem) results.push(prevItem);
      continue;
    }

    try {
      const fresh = await processFeedSource(env, feed);
      results.push({ ...fresh, generatedAt: nowISO });
    } catch (err) {
      const prevItem = prevBySource.get(feed.name);
      if (prevItem && !prevItem.error) {
        results.push({ ...prevItem, stale: true });
      } else {
        results.push({
          source: feed.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const digest = { generatedAt: nowISO, items: results };

  const dateKey = digest.generatedAt.slice(0, 10); // YYYY-MM-DD
  await env.DIGEST_KV.put("latest", JSON.stringify(digest));
  await env.DIGEST_KV.put(`history:${dateKey}`, JSON.stringify(digest));

  return digest;
}

/**
 * 前回の実行で失敗(error)またはフォールバック(stale)扱いだったソースだけを再要約する。
 * 数時間後のリトライ用cronから呼ばれる。全ソースが成功済みなら何もしない
 * (Gemini/RSSを無駄に叩かない)。
 */
async function retryFailedSources(env) {
  const raw = await env.DIGEST_KV.get("latest");
  if (!raw) return null;

  const digest = JSON.parse(raw);
  const needsRetry = digest.items.some((item) => item.error || item.stale);
  if (!needsRetry) return digest;

  const nowISO = new Date().toISOString();
  const updatedItems = [];

  for (const item of digest.items) {
    if (!item.error && !item.stale) {
      updatedItems.push(item);
      continue;
    }

    const feed = FEEDS.find((f) => f.name === item.source);
    if (!feed) {
      updatedItems.push(item);
      continue;
    }

    try {
      const fresh = await processFeedSource(env, feed);
      updatedItems.push({ ...fresh, generatedAt: nowISO });
    } catch {
      // リトライも失敗。既存のerror/staleエントリをそのまま維持する。
      updatedItems.push(item);
    }
  }

  const digestOut = { generatedAt: nowISO, items: updatedItems };
  const dateKey = digestOut.generatedAt.slice(0, 10);
  await env.DIGEST_KV.put("latest", JSON.stringify(digestOut));
  await env.DIGEST_KV.put(`history:${dateKey}`, JSON.stringify(digestOut));

  return digestOut;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Geminiの出力にMarkdownの太字記法(**text**)が混ざることがあるため、
 * エスケープ済みテキストに対してのみ <strong> に変換する。
 */
function renderInlineMarkdown(escapedText) {
  return escapedText.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

export function renderHtml(digest) {
  const generatedAtLabel = digest
    ? new Date(digest.generatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
    : null;

  const body = digest
    ? digest.items
        .map((item) => {
          if (item.error) {
            return `
        <section class="card card-error">
          <h2>${escapeHtml(item.source)}</h2>
          <p class="error">取得失敗: ${escapeHtml(item.error)}</p>
        </section>`;
          }
          const summaryHtml = escapeHtml(item.summary)
            .split("\n")
            .filter((line) => line.trim().length > 0)
            // 箇条書きマーカー除去: "-"/"*" は直後にスペースがある場合のみマーカーとみなす。
            // スペース任意にすると "**hoge**" の先頭 "*" だけを誤って剥がしてしまう。
            .map((line) => renderInlineMarkdown(line.replace(/^(?:[-*]\s+|・\s*)/, "")))
            .map((line) => `<li>${line}</li>`)
            .join("");
          // リンク先が取れなかった場合、href="" は現在のページ自身を指してしまうため
          // <a> ではなくプレーンテキストで表示する。
          const sourceHeading = item.link
            ? `<a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.source)}</a>`
            : escapeHtml(item.source);
          // stale: 最新取得に失敗し、KVに残っていた前回成功分を代わりに表示している。
          const staleNote = item.stale
            ? `<p class="stale-note">前回(${escapeHtml(
                new Date(item.generatedAt).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }),
              )})の内容を表示中</p>`
            : "";
          // ソースごとに更新頻度が異なる(TLDR AIは毎日、Android/iOS Weeklyは週次)ため、
          // 各カードに最終更新日を出して古さが分かるようにする。
          const updatedNote =
            !item.stale && item.generatedAt
              ? `<p class="updated-note">更新: ${escapeHtml(
                  new Date(item.generatedAt).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" }),
                )}</p>`
              : "";
          return `
        <section class="card">
          <h2>${sourceHeading}</h2>
          <p class="original-title">${escapeHtml(item.title)}</p>
          ${staleNote}${updatedNote}
          <ul>${summaryHtml}</ul>
        </section>`;
        })
        .join("\n")
    : `<p>まだダイジェストが生成されていません。<code>POST /run</code> で手動実行するか、次回のcron発火を待ってください。</p>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>asa-mobile digest</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 16px; background: #f7f7f8; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  .generated-at { color: #666; font-size: 0.85rem; margin-bottom: 24px; }
  .card { background: #fff; border-radius: 8px; padding: 16px 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .card h2 { margin: 0 0 8px; font-size: 1.1rem; }
  .card h2 a { color: #1a1a1a; text-decoration: none; }
  .original-title { color: #888; font-size: 0.8rem; margin: 0 0 8px; }
  .card ul { margin: 0; padding-left: 1.2em; }
  .card-error { border-left: 4px solid #d33; }
  .error { color: #d33; }
  .stale-note { color: #a67c00; font-size: 0.75rem; margin: 0 0 8px; }
  .updated-note { color: #999; font-size: 0.75rem; margin: 0 0 8px; }
</style>
</head>
<body>
<h1>asa-mobile digest</h1>
${generatedAtLabel ? `<p class="generated-at">最終更新: ${escapeHtml(generatedAtLabel)}</p>` : ""}
${body}
</body>
</html>`;
}

// リトライ用cron ("0 4 * * *" = 本番cronの4時間後、毎日)。この文字列はwrangler.tomlの
// [triggers].crons と一致させること。
const RETRY_CRON = "0 4 * * *";

/**
 * mode: "single" の週次ソース(Android Weekly / iOS Dev Weekly)を取得してよい日か。
 * 週1回しか新しい号が出ないため、毎日取得しても同じ号を再要約するだけで
 * Gemini呼び出しの無駄になる。月曜(cronは00:00 UTC=9:00 JST)のみ取得する。
 */
function isWeeklyRefreshDay(scheduledTime) {
  return new Date(scheduledTime).getUTCDay() === 1; // 1 = Monday
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === RETRY_CRON) {
      ctx.waitUntil(retryFailedSources(env));
    } else {
      const feedsToProcess = FEEDS.filter(
        (feed) => feed.mode === "multi" || isWeeklyRefreshDay(event.scheduledTime),
      );
      ctx.waitUntil(generateDigest(env, feedsToProcess));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/run") {
      // 認証なしで公開すると、URLを知っている誰でもこのエンドポイントを叩いて
      // こちらのGemini APIキーでリクエストを消費できてしまう。共有シークレットで保護する。
      if (request.headers.get("x-run-secret") !== env.RUN_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      const digest = await generateDigest(env);
      return new Response(JSON.stringify(digest, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    const raw = await env.DIGEST_KV.get("latest");
    const digest = raw ? JSON.parse(raw) : null;
    return new Response(renderHtml(digest), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};
