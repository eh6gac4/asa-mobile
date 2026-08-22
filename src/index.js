import { XMLParser } from "fast-xml-parser";
import PostalMime from "postal-mime";
import { APPLE_TOUCH_ICON_PNG_BASE64 } from "./apple-touch-icon.base64.js";

// TLDR AIのメール受信KVキー。email()ハンドラが書き込み、processFeedSource(経由の
// buildInboxContent)が読む。feed.inboxにこのキーを持たせることでメール優先経路が有効になる。
const TLDR_AI_INBOX_KEY = "inbox:tldr-ai:latest";

// 取得するRSSフィード一覧。
// mode: "single" -> 週刊フィード。最新1件のみ使用。cronはJST基準の月曜のみ取得する(isWeeklyRefreshDay参照)
// mode: "multi"  -> 日刊フィード。直近5件を連結して1週間分として扱う。cronは毎日取得する
// siteUrl: 画面下部の参照元フッターから貼るニュースレター本家サイトのURL。
// inbox: 指定があるとメール受信(KV)を一次ソースとして優先し、無い/古い場合のみurlのRSSへ
// フォールバックする(processFeedSource参照)。modeはフォールバック時に使う値なので、
// メール優先ソースでも"multi"のまま変えないこと(scheduledの週次ゲート判定に影響するため)。
const FEEDS = [
  {
    name: "Android Weekly",
    url: "https://androidweekly.net/rss.xml",
    mode: "single",
    siteUrl: "https://androidweekly.net/",
  },
  {
    name: "iOS Dev Weekly",
    url: "https://iosdevweekly.com/issues.rss",
    mode: "single",
    siteUrl: "https://iosdevweekly.com/",
  },
  {
    name: "TLDR AI",
    // TLDR公式はメール配信のみでRSSを提供していない。email()ハンドラで受信したメールを
    // 優先的に使い、非公式ミラー(RSS)は受信が無い/古いときのフォールバックとして残す
    // （ミラーが停止・URL変更した場合や、ミラー側の配信漏れの両方に対応するため）。
    url: "https://bullrich.dev/tldr-rss/ai.rss",
    mode: "multi",
    inbox: TLDR_AI_INBOX_KEY,
    siteUrl: "https://tldr.tech/ai",
  },
];

const MULTI_ITEM_LIMIT = 5;
// リンク候補抽出(extractLinkCandidates)の上限。号あたりのリンク数が異常に多いフィード対策。
const MAX_LINK_CANDIDATES = 40;
// メールHTMLはRSSの号本文よりヘッダ・フッタ・スポンサー枠が多く、リンク数も多いため別枠で緩める。
const INBOX_MAX_LINK_CANDIDATES = 80;
// メール受信からこの時間を過ぎたらRSSフォールバックへ倒す(TLDRは米国時間午後配信=JST未明着なので
// 5:00 JST cron時点で数時間前の新着がある想定。前日分の使い回しを防ぐ)。
const INBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// TLDR AIの送信元として許可するドメイン。email()ハンドラでここに一致しない差出人を拒否する
// (第三者が受信アドレスを知って任意のHTMLを送り込み、Geminiに要約させて公開ページに載せる
// 経路を塞ぐため。SPF/DKIM/DMARCの検証自体はCloudflare Email Routing側で完了している前提)。
const TLDR_AI_ALLOWED_SENDER_DOMAINS = ["tldrnewsletter.com", "tldr.tech"];
const GEMINI_MODEL = "gemini-3.6-flash";

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 日時(ISO文字列/エポックミリ秒/Date、`new Date()`が解釈できるもの)をJST基準の
 * 暦日 "YYYY-MM-DD" に変換する。
 * 本番cronは20:00 UTCに発火するため、UTCの暦日をそのまま使うと号の日付が
 * 常に1日前になる。号のキー・URL・曜日ラベルはすべてJST基準で揃える。
 */
export function jstDateKey(dateLike) {
  return new Date(new Date(dateLike).getTime() + JST_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

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

// アンカーテキストがこれらの汎用的な呼びかけ文言「だけ」の場合、記事本文とは
// 無関係な広告・登録・購読・ナビゲーション用リンクである可能性が高いので候補から除く
// （本番実行でiOS Dev Weeklyの候補にこの種のリンクが混ざり、Geminiが本文中のどのトピックにも
// 対応付けられず全エントリのcandidateIndexをnullにする事例が発生したため）。
// unsubscribe等はメールニュースレター(TLDR AI)のフッタ由来のノイズ除け。
const GENERIC_LINK_TEXT = /^(here|read more|learn more|click here|register|registration link|sign ?up|subscribe|unsubscribe|view (online|in browser)|manage (your )?(subscriptions?|preferences)|advertise( with us)?|sponsor(ed)?( by)?|discount code|home ?page|this (article|post)|link)$/i;

/**
 * RSS本文/メールHTML中から <a href="URL">テキスト</a> をリンク候補として抽出する。
 * Geminiに「どの候補が生成したトピックに対応するか」を選ばせるための材料になる
 * (buildPrompt/summarizeEntries参照)。フルDOMパースは過剰なため正規表現で簡易抽出する
 * （stripHtmlと同種の既知の技術的負債: 凝ったマークアップには弱い）。
 * limit: 候補数の上限。メールHTMLはRSSの号本文よりノイズ(ヘッダ・フッタ・スポンサー)が
 * 多いため、呼び出し側でINBOX_MAX_LINK_CANDIDATESのように緩めた値を渡せるようにしている。
 */
export function extractLinkCandidates(html, limit = MAX_LINK_CANDIDATES) {
  const source = String(html ?? "");
  const candidates = [];
  const seen = new Set();
  const linkPattern = /<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = linkPattern.exec(source)) && candidates.length < limit) {
    const url = match[1].trim();
    const text = stripHtml(match[2]);
    if (!url || !text) continue;
    if (/^(#|mailto:|javascript:)/i.test(url)) continue;
    if (GENERIC_LINK_TEXT.test(text.trim())) continue;

    const key = `${url} ${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ text, url });
  }

  return candidates;
}

/**
 * TLDRのメール内リンクはクリック計測のためラップされている
 * (例: https://tracking.tldrnewsletter.com/CL0/<percent-encodeされた元URL>/<番号>/<ハッシュ>)。
 * これをそのままentry.urlに使うと、送信のたびにハッシュが変わり同じ記事が毎日
 * 「新着」として再掲載されてしまう(entryKeyがurlを既出判定キーにしているため)。
 * パス中に percent-encode された元URLを探して復元する。取り出せない/不正な場合は
 * ラップされたURLをそのまま返す(壊すよりリンクが機能する状態を優先する)。
 */
export function unwrapTrackingUrl(url) {
  const raw = String(url ?? "");
  const match = raw.match(/https?%3A%2F%2F[^/]+(?:%2F[^/]*)*/i);
  if (!match) return raw;
  try {
    return new URL(decodeURIComponent(match[0])).href;
  } catch {
    return raw;
  }
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

/**
 * itemのpubDateをISO文字列に変換する。パースできない/存在しない場合はnull。
 * RSSの日付書式はRFC822形式とGMT表記が混在するが、Dateコンストラクタはどちらも解釈できる。
 */
function extractPubDate(item) {
  const raw = item?.pubDate;
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * itemの本文HTMLを選ぶ。description/content:encodedのどちらが本文を持つかは
 * フィードによってまちまち（例: Android Weeklyはdescriptionが本文、iOS Dev Weeklyは
 * descriptionが号のトピック一覧の短い要約文だけで、実際の本文とリンクはcontent:encoded
 * 側にある）。単純に「descriptionが存在すればdescriptionを使う」(旧実装)だと、
 * iOS Dev Weeklyのように存在はするが薄いdescriptionを誤って選んでしまい、
 * extractLinkCandidatesがリンクを一つも拾えなくなる。文字数が長い方＝本文である
 * 可能性が高いという単純なヒューリスティックで選ぶ。
 */
function pickBodyHtml(item) {
  const description = item?.description;
  const encoded = item?.["content:encoded"];
  if (encoded && String(encoded).length > String(description ?? "").length) {
    return encoded;
  }
  return description ?? encoded;
}

/**
 * 1フィード分のGemini入力を組み立てる。modeによってリンクの出所が異なるため
 * 経路を分ける（processFeedSource/summarizeEntries参照）。
 *
 * - mode: "single"（週刊フィード）: 号のHTML本文中に複数記事へのリンクが列挙されている。
 *   extractLinkCandidatesでリンク候補一覧を作り、Geminiにどの候補が生成トピックに
 *   対応するか選ばせる（buildPrompt参照）。号自体のURL(latestLink)はカード見出し用。
 * - mode: "multi"（日刊フィード）: 1 RSS item = 1記事なので、記事単位のURLは
 *   extractLink(item)で確定済み。Geminiにはリンク選択をさせず、見出し・説明文の
 *   生成だけを依頼する（ハルシネーション防止）。TLDR AIには「号」の概念が無いため
 *   latestLinkは空にする（renderHtmlは空なら号リンクを描画しない）。
 */
function buildSourceContent(feed, items) {
  if (feed.mode === "single") {
    const picked = items.slice(0, 1);
    const rawHtml = pickBodyHtml(picked[0]);
    return {
      mode: "single",
      combinedText: stripHtml(rawHtml),
      candidates: extractLinkCandidates(rawHtml),
      latestLink: extractLink(picked[0]),
      // 号単位でしか公開日が取れないため、この号に属する全entryに同じ値をコピーする
      // (processFeedSource参照)。
      publishedAt: extractPubDate(picked[0]),
    };
  }

  const picked = items.slice(0, MULTI_ITEM_LIMIT);
  return {
    mode: "multi",
    multiItems: picked.map((item) => ({
      title: stripHtml(item.title),
      description: stripHtml(pickBodyHtml(item)),
      url: extractLink(item),
      publishedAt: extractPubDate(item),
    })),
    latestLink: "",
  };
}

/**
 * メール優先ソース(feed.inbox指定あり)用に、email()ハンドラがKVへ保存した受信メールから
 * buildSourceContentと同じ形(mode: "single")を組み立てる。TLDRのメールは1通に複数記事が
 * 列挙された構造なので、候補リンク+candidateIndex方式(single経路)がそのまま適合する。
 * 受信が無い/古すぎる/壊れている場合はnullを返す(エラーではない — 呼び出し側が
 * RSSフォールバックへ倒す。throwするとstale fallbackが発動しRSSを試さず終わってしまう)。
 */
async function buildInboxContent(env, feed) {
  const raw = await env.DIGEST_KV.get(feed.inbox);
  if (!raw) return null;

  let inbox;
  try {
    inbox = JSON.parse(raw);
  } catch {
    return null;
  }

  const receivedAtMs = new Date(inbox.receivedAt ?? "").getTime();
  if (!Number.isFinite(receivedAtMs) || Date.now() - receivedAtMs > INBOX_MAX_AGE_MS) {
    return null;
  }

  const html = inbox.html ?? "";
  return {
    mode: "single",
    combinedText: stripHtml(html),
    candidates: extractLinkCandidates(html, INBOX_MAX_LINK_CANDIDATES).map((c) => ({
      ...c,
      url: unwrapTrackingUrl(c.url),
    })),
    latestLink: "", // TLDRに「号」URLの概念は無い(buildSourceContentのmulti分岐と同じ理由)
    publishedAt: inbox.receivedAt,
    subject: inbox.subject ?? "",
  };
}

// entriesに付与する「開発者（自分）への影響」の生成指示。single/multi両モードで共通なので
// buildPromptから両方参照する。読み手はモバイルアプリ(Android/iOS)開発者本人という前提。
const IMPACT_INSTRUCTION =
  `さらに各トピックについて、読者であるモバイルアプリ(Android/iOS)開発者自身の開発業務にとっての` +
  `影響も添えてください。「役立つ点」には具体的に役立つ内容(効率化・新機能・学びなど、1文20〜40字程度)、` +
  `「注意すべき点」には気をつけるべき内容(移行コスト・非推奨化・学習コストなど、1文20〜40字程度)を` +
  `書いてください。項目名やラベルは書かず、内容の文章だけを書いてください。` +
  `明確な影響が無ければ無理に作らず空文字列にしてください。`;

function buildPrompt(feed, built) {
  if (built.mode === "single") {
    const candidateLines = built.candidates
      .map((c, i) => `[${i}] ${c.text} — ${c.url}`)
      .join("\n");
    return (
      `以下は「${feed.name}」というニュースレターの直近号の内容です。` +
      `日本語で3〜5個のトピックに整理し、それぞれ見出し(15〜25字程度)と説明(1〜2文、40〜80字程度)を作成してください。` +
      `前置きや結びの文は不要です。\n` +
      `候補リンク一覧には、本文中の各トピックへのリンクだけでなく、広告・イベント告知・` +
      `他の号への相互リンクなど本文の内容と無関係なものも混ざっています。各トピックについて、` +
      `そのトピックの内容と実際に一致する記事へのリンクが候補にあれば、最も合致する番号を` +
      `candidateIndexとして選んでください。少しでも自信が無い場合や、該当する記事が無い場合は` +
      `無理に対応付けずcandidateIndexをnullにしてください。一覧に無いURLを作り出さないでください。\n` +
      `${IMPACT_INSTRUCTION}\n\n` +
      `# 候補リンク一覧\n${candidateLines || "(候補なし)"}\n\n` +
      `# 本文\n${built.combinedText}`
    );
  }

  const itemLines = built.multiItems
    .map((item, i) => `[${i}] ${item.title}\n${item.description}`)
    .join("\n\n");
  return (
    `以下は「${feed.name}」というニュースレターの直近の記事一覧です。` +
    `各記事について、日本語で見出し(15〜25字程度)と説明(1〜2文、40〜80字程度)を作成してください。` +
    `記事の順序を変えず、記事数ちょうどの件数を出力してください。前置きや結びの文は不要です。\n` +
    `${IMPACT_INSTRUCTION}\n\n${itemLines}`
  );
}

function buildResponseSchema(built) {
  const properties = {
    headline: {
      type: "STRING",
      description: "トピックの見出し(15〜25字程度)。項目名やラベルを含めず、見出しの文章のみ。",
    },
    description: {
      type: "STRING",
      description: "トピックの説明文(1〜2文、40〜80字程度)。項目名やラベルを含めず、本文の文章のみ。",
    },
    impactGood: {
      type: "STRING",
      description:
        "モバイルアプリ開発者にとって具体的に役立つ点(1文20〜40字程度)。項目名やラベルを含めず、内容の文章のみ。明確な影響が無ければ空文字列。",
    },
    impactBad: {
      type: "STRING",
      description:
        "モバイルアプリ開発者が注意すべき点(1文20〜40字程度)。項目名やラベルを含めず、内容の文章のみ。明確な影響が無ければ空文字列。",
    },
  };
  if (built.mode === "single") {
    properties.candidateIndex = { type: "INTEGER", nullable: true };
  }
  return {
    type: "ARRAY",
    items: { type: "OBJECT", properties, required: ["headline", "description"] },
  };
}

/**
 * Gemini APIに構造化要約(見出し+説明文の配列)を依頼する。
 *
 * 注意: Gemini 3.x系では temperature / top_p / top_k が廃止されており、
 * generationConfig.thinkingConfig.thinkingLevel で思考量を制御する方式になっている。
 * 古いパラメータは渡さないこと。
 * responseMimeType: "application/json" + responseSchema で構造化出力を強制する
 * （箇条書きテキストのパース処理が不要になる）。
 *
 * 429/5xx (高負荷時の503等)は一時的なエラーとみなし、指数バックオフでリトライする。
 * Retry-Afterヘッダがあればそちらを優先する（上限あり）。
 */
async function summarizeEntries(env, feed, built) {
  const prompt = buildPrompt(feed, built);
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
          // single mode(候補リンクとの対応付け)は他トピックとの照合が必要な分、複雑な
          // 推論が要る。multi modeはリンクが確定済みで見出し・説明文の生成だけなので
          // "low"のままで十分（コスト・レイテンシ優先）。
          thinkingConfig: { thinkingLevel: built.mode === "single" ? "medium" : "low" },
          responseMimeType: "application/json",
          responseSchema: buildResponseSchema(built),
        },
      }),
    });

    if (res.ok) {
      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) {
        throw new Error(`Gemini APIレスポンスの形式が想定外 (${feed.name}): ${JSON.stringify(data)}`);
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`Gemini APIのJSON出力をパースできなかった (${feed.name}): ${raw}`);
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(`Gemini APIの出力が空または配列でない (${feed.name}): ${raw}`);
      }
      return parsed;
    }

    const errBody = await res.text().catch(() => "");
    lastErr = new Error(`Gemini API失敗 (${feed.name}): status ${res.status} ${errBody}`);

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
 * builtされたGemini入力を要約し、KVに保存する号アイテムの形にまとめる。
 * RSS経路・メール経路の両方から呼ばれる共通の後半処理(processFeedSource参照)。
 */
// Geminiが構造化出力のvalue先頭に "impactGood: " のようなラベル風の文字列を
// 混入させることがあるため、表示前に取り除く(910f841のフォローアップ)。
// "Kotlin: Coroutines新版"のような正当な見出し文言を誤って削らないよう、
// 既知のスキーマフィールド名に限定してマッチさせる。
const LABEL_PREFIX_RE = /^(headline|description|impactGood|impactBad)\s*[:：]\s*/i;
function stripLabelPrefix(text) {
  return text.replace(LABEL_PREFIX_RE, "");
}

async function summarizeIntoItem(env, feed, built, title) {
  const rawEntries = await summarizeEntries(env, feed, built);

  const entries = rawEntries
    .map((raw, index) => {
      const headline = stripLabelPrefix(String(raw?.headline ?? "").trim());
      const description = stripLabelPrefix(String(raw?.description ?? "").trim());
      const impactGood = stripLabelPrefix(String(raw?.impactGood ?? "").trim());
      const impactBad = stripLabelPrefix(String(raw?.impactBad ?? "").trim());

      let url = null;
      let publishedAt = null;
      if (built.mode === "single") {
        const candidateIndex = raw?.candidateIndex;
        if (Number.isInteger(candidateIndex) && built.candidates[candidateIndex]) {
          url = built.candidates[candidateIndex].url || null;
        }
        publishedAt = built.publishedAt;
      } else {
        url = built.multiItems[index]?.url || null;
        publishedAt = built.multiItems[index]?.publishedAt || null;
      }

      return { headline, description, impactGood, impactBad, url, publishedAt };
    })
    .filter((entry) => entry.headline && entry.description);

  return {
    source: feed.name,
    title,
    link: built.latestLink || "",
    entries,
  };
}

/**
 * 取得した本文の同一性を判定するハッシュ。前回と一致するならGeminiを呼ばずに
 * 前回の要約を使い回す(processFeedSource参照)。無料枠が1日20リクエストしかないため、
 * 休刊日や未更新の号を毎日要約し直す無駄を省く。
 * mode:"single"は号本文そのもの、mode:"multi"は記事URL/公開日/タイトルの並びを材料にする。
 */
export async function contentFingerprint(built) {
  const material =
    built.mode === "single"
      ? [built.latestLink ?? "", built.publishedAt ?? "", built.combinedText ?? ""].join("\n")
      : (built.multiItems ?? [])
          .map((i) => `${i.url ?? ""}\t${i.publishedAt ?? ""}\t${i.title ?? ""}`)
          .join("\n");
  const bytes = new TextEncoder().encode(`${built.mode}\n${material}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 1フィードを取得・構造化要約する。generateDigest/retryFailedSourcesの両方から使う。
 * feed.inboxが指定されているソースは、email()ハンドラが受信したメール(KV)を優先し、
 * 受信が無い/古すぎる場合のみurlのRSSへフォールバックする(buildInboxContent参照)。
 *
 * prevItemには前回KVに保存されたitemを渡す。取得した本文のfingerprintが前回と一致すれば
 * (=中身が変わっていない)、Geminiを呼ばずに前回の要約をそのまま返す(generatedAtも前回のまま
 * 据え置く)。forceを渡すと一致していても強制的に再要約する(/run?force=1用)。
 * nowISOはGeminiを実際に呼んだ場合にのみgeneratedAtとして使う。
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 1ソース分の処理結果を、表示用のresults(digestのitems)と調査用のlogEntries
 * (appendRunLog参照)の両方に反映する。stale時、resultsにはエラー文言を含めない
 * (表示には出さない設計)が、logEntriesには残す。1箇所にまとめることで、
 * generateDigest/retryFailedSourcesの各分岐でsourceの取り違えなどが起きないようにする。
 */
function recordSourceResult(results, logEntries, source, resultItem, status, error) {
  results.push(resultItem);
  logEntries.push(error === undefined ? { source, status } : { source, status, error });
}

async function processFeedSource(env, feed, prevItem, nowISO, { force = false } = {}) {
  let built = null;
  let title = "";
  if (feed.inbox) {
    built = await buildInboxContent(env, feed);
    if (built) title = built.subject;
  }
  if (!built) {
    const items = await fetchFeedItems(feed.url);
    built = buildSourceContent(feed, items);
    title = stripHtml(items[0]?.title);
  }

  const fingerprint = await contentFingerprint(built);
  if (!force && prevItem && !prevItem.error && prevItem.fingerprint === fingerprint) {
    // 取得内容が前回から変わっていない。entriesは既にseen:urls済みのはずなので
    // buildEditionで弾かれ号には出ない。取得自体は成功しているのでstaleは落とす。
    const { stale, ...rest } = prevItem;
    return rest;
  }

  const item = await summarizeIntoItem(env, feed, built, title);
  return { ...item, fingerprint, generatedAt: nowISO };
}

/**
 * 指定フィードを取得・要約してKVに保存する。
 * フィード単位でtry/catchし、1つ失敗しても他は続行する。
 *
 * feedsToProcess を渡さない場合は全フィードが対象(手動実行の /run 用)。
 * 渡した場合、対象外のフィード(例: 月曜以外の日のAndroid/iOS Weekly)は
 * 取得を行わず、KVに残っている前回の結果をそのまま引き継ぐ。
 *
 * 取得した本文が前回のfingerprintと一致するソースはGeminiを呼ばずに前回の要約を
 * 使い回す(processFeedSource参照)。forceを渡すと一致していても強制的に再要約する
 * (/run?force=1用)。
 *
 * リトライ後もなお失敗したソースは、KVに残っている前回成功分を代わりに使い
 * (stale: trueを付与)、表示が「取得失敗」で丸ごと潰れないようにする。
 * 前回分も無ければ従来通りエラーを記録する。
 */
async function generateDigest(env, feedsToProcess = FEEDS, { force = false, trigger = "manual" } = {}) {
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
  const logEntries = [];

  for (const feed of FEEDS) {
    if (!targetNames.has(feed.name)) {
      // 今回は対象外(例: 週次ソースを非月曜に実行しない)。前回の結果を維持する。
      const prevItem = prevBySource.get(feed.name);
      if (prevItem) results.push(prevItem);
      continue;
    }

    try {
      const item = await processFeedSource(env, feed, prevBySource.get(feed.name), nowISO, { force });
      recordSourceResult(results, logEntries, feed.name, item, "ok");
    } catch (err) {
      const message = errorMessage(err);
      const prevItem = prevBySource.get(feed.name);
      if (prevItem && !prevItem.error) {
        recordSourceResult(results, logEntries, feed.name, { ...prevItem, stale: true }, "stale", message);
      } else {
        recordSourceResult(results, logEntries, feed.name, { source: feed.name, error: message }, "error", message);
      }
    }
  }

  const digest = { generatedAt: nowISO, items: results };
  await persistDigest(env, digest);
  await appendRunLog(env, { at: nowISO, trigger, results: logEntries });

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
  const logEntries = [];

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
      const recovered = await processFeedSource(env, feed, item, nowISO);
      recordSourceResult(updatedItems, logEntries, item.source, recovered, "recovered");
    } catch (err) {
      // リトライも失敗。既存のerror/staleエントリをそのまま維持する。
      recordSourceResult(updatedItems, logEntries, item.source, item, "error", errorMessage(err));
    }
  }

  const digestOut = { generatedAt: nowISO, items: updatedItems };
  await persistDigest(env, digestOut);
  // needsRetryがtrueの時点でerror/staleが最低1件あり、それは必ずこのループを通るため
  // logEntriesは常に1件以上ある。
  await appendRunLog(env, { at: nowISO, trigger: "retry", results: logEntries });

  return digestOut;
}

// 実行ログ("logs"キー)に保持する件数の上限。generateDigest/retryFailedSourcesは
// 実行のたびにappendRunLogを呼ぶため、無制限に貯めるとKVが肥大化する。
const LOG_MAX_ENTRIES = 50;

/**
 * 1回の実行(cron発火または手動/run)の結果をKVの"logs"キーに追記する。
 * 従来はソース単位の失敗(error/stale)がKVに残らず、原因調査ができなかった
 * (前回成功分で上書きされるため)。ここに追記しておけば、staleが続く原因の
 * エラーメッセージを後から遡って確認できる。
 * trigger: どの経路からの実行か("manual" | cron文字列 | "retry")。
 * results: [{ source, status: "ok"|"stale"|"error"|"recovered", error? }]
 */
async function appendRunLog(env, entry) {
  const raw = await env.DIGEST_KV.get("logs");
  const logs = raw ? JSON.parse(raw) : [];
  logs.push(entry);
  // appendRunLogは1回の実行につき1件しか積まないため、超過は常に高々1件。
  if (logs.length > LOG_MAX_ENTRIES) logs.shift();
  await env.DIGEST_KV.put("logs", JSON.stringify(logs));
}

// seen:urls に記録した既出URLをいつまで保持するか。これより古い記録は
// persistDigest内で剪定する(KVを無限に肥大化させないため)。
const SEEN_TTL_DAYS = 90;

/**
 * entry(または取得失敗item)を一意に識別するキー。entry.urlがあればそれを使うが、
 * 単一号内リンク(single mode)でGeminiがcandidateIndexを対応付けられなかった場合など
 * url: nullのentryも存在するため、その場合は source+headline を代替キーにする。
 */
function entryKey(item, entry) {
  return entry.url || `${item.source}::${entry.headline}`;
}

/**
 * digestから「その日の新着分」だけを抜き出した号(edition)を組み立てる。
 * Android Weekly / iOS Dev Weekly は月曜しか号が更新されないため、historyの
 * スナップショットをそのまま出すと火〜日に同じ記事が並び続けてしまう。
 * 既出URL台帳(seenMap)と突き合わせて、まだ載せていない分だけを残す。
 *
 * seenMap[key] === dateKey (=当日) のentryは既出扱いにしない。リトライcronが
 * 同日中に再実行されても、自分が先に記録した分で紙面が空にならないようにするため
 * (冪等性)。
 *
 * error itemは単独では号を成立させない。新着entryが1件も無い日にエラーカードだけの
 * 号が発行されるのを防ぐため(persistDigestの「号が空なら作らない」ゲートに対応)。
 */
export function buildEdition(digest, seenMap, dateKey) {
  const items = [];
  for (const item of digest.items) {
    if (item.error) {
      items.push(item);
      continue;
    }
    const entries = (item.entries ?? []).filter((entry) => {
      const seenDate = seenMap[entryKey(item, entry)];
      return !seenDate || seenDate === dateKey;
    });
    if (entries.length > 0) {
      items.push({ ...item, entries });
    }
  }
  // itemsに入るのはerror itemか新着entryを持つitemのみ。error item以外が無ければ
  // 新着はゼロなので、号を成立させない(persistDigestの「号が空なら作らない」ゲートに対応)。
  const hasFreshEntry = items.some((item) => !item.error);
  return { date: dateKey, generatedAt: digest.generatedAt, items: hasFreshEntry ? items : [] };
}

/**
 * digestをKVへ保存する。従来の「latest」「history:」に加えて、その日の新着分だけを
 * 「edition:」として保存し、発行日一覧(editions)と既出URL台帳(seen:urls)を更新する。
 * generateDigest/retryFailedSourcesの両方から呼ぶ(旧実装ではこの3行が2箇所に重複していた)。
 * dateKeyはJST基準の暦日(jstDateKey参照)。本番cronは20:00 UTC=翌5:00 JSTに発火するため、
 * UTCの暦日をそのまま使うと号の日付が1日ズレる。
 */
async function persistDigest(env, digest) {
  const dateKey = jstDateKey(digest.generatedAt);

  await env.DIGEST_KV.put("latest", JSON.stringify(digest));
  await env.DIGEST_KV.put(`history:${dateKey}`, JSON.stringify(digest));

  const seenRaw = await env.DIGEST_KV.get("seen:urls");
  const seenMap = seenRaw ? JSON.parse(seenRaw) : {};

  const edition = buildEdition(digest, seenMap, dateKey);
  if (edition.items.length === 0) {
    // その日の新着が無い(週刊ソースの非月曜、取得失敗しか無かった日など)。号は作らない。
    return;
  }

  await env.DIGEST_KV.put(`edition:${dateKey}`, JSON.stringify(edition));

  const editionsRaw = await env.DIGEST_KV.get("editions");
  const editions = editionsRaw ? JSON.parse(editionsRaw) : [];
  if (!editions.includes(dateKey)) {
    editions.push(dateKey);
    editions.sort((a, b) => (a < b ? 1 : -1)); // 降順(新しい日付が先頭)
    await env.DIGEST_KV.put("editions", JSON.stringify(editions));
  }

  for (const item of edition.items) {
    if (item.error) continue;
    for (const entry of item.entries) {
      seenMap[entryKey(item, entry)] = dateKey;
    }
  }
  const cutoff = jstDateKey(Date.now() - SEEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  for (const key of Object.keys(seenMap)) {
    if (seenMap[key] < cutoff) delete seenMap[key];
  }
  await env.DIGEST_KV.put("seen:urls", JSON.stringify(seenMap));
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

// ソースごとの色分け(CSS変数 --accent-*)に対応するdata-source値。
// 未知のソース名が来ても描画自体は壊れないよう、フォールバックを用意する。
function sourceSlug(sourceName) {
  switch (sourceName) {
    case "Android Weekly":
      return "android";
    case "iOS Dev Weekly":
      return "ios";
    case "TLDR AI":
      return "tldr";
    default:
      return "other";
  }
}

// item.title (例: "Android Weekly Issue #738") から号数だけを取り出す。
// 見つからない場合はtitleをそのまま返す。
function issueLabel(item) {
  const match = item.title?.match(/#\d+/);
  return match ? match[0] : item.title || "";
}

/**
 * 取得失敗ソースを.row.error要素として描画する。
 */
function renderErrorRow(item) {
  const slug = sourceSlug(item.source);
  return `
      <div class="row error" data-source="${slug}">
        <span class="node"></span>
        <div class="row-head">
          <span class="badge">${escapeHtml(item.source)}</span>
          <span>・エラー</span>
        </div>
        <span class="headline">取得失敗</span>
        <p class="desc">${escapeHtml(item.error)}</p>
      </div>`;
}

/**
 * 1記事(entry)を.row要素として描画する。entry.urlの有無で見出しのリンク/
 * プレーンテキストが分岐する。日付はentry.publishedAt(元記事/号の公開日)を使い、
 * 無ければitem.generatedAt(要約日)にフォールバックする(旧スキーマのdigest互換)。
 */
function renderEntryRow(item, entry) {
  const slug = sourceSlug(item.source);
  const dateSource = entry.publishedAt ?? item.generatedAt;
  const dateLabel = dateSource
    ? new Date(dateSource).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })
    : "";
  // stale: 最新取得に失敗し、KVに残っていた前回成功分を代わりに表示している。
  // 日付欄は公開日を表示しつつ、注記には「いつ取得した分か」(生成日)を出す。
  const metaHtml = item.stale
    ? `<span>・${escapeHtml(dateLabel)}</span><span class="stale">・前回取得(${escapeHtml(
        item.generatedAt
          ? new Date(item.generatedAt).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })
          : "",
      )})分</span>`
    : dateLabel
      ? `<span>・${escapeHtml(dateLabel)}</span>`
      : "";
  // リンク先が取れなかった場合、href="" は現在のページ自身を指してしまうため
  // <a> ではなくリンク自体を描画しない。
  const issueLinkHtml = item.link
    ? `<a class="issue" href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(issueLabel(item))}</a>`
    : "";

  const headlineText = renderInlineMarkdown(escapeHtml(entry.headline));
  const headlineHtml = entry.url
    ? `<a class="headline" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">${headlineText}</a>`
    : `<span class="headline">${headlineText}</span>`;

  // impactGood/impactBad(自分への良い影響/悪い影響)は旧スキーマのentryやGeminiが
  // 明確な影響なしと判断した場合に空/未設定になりうるため、値がある方だけ描画する。
  const impactItemsHtml = [
    ["impact-good", "＋", entry.impactGood],
    ["impact-bad", "－", entry.impactBad],
  ]
    .filter(([, , text]) => text)
    .map(
      ([cls, icon, text]) =>
        `<li class="${cls}"><span class="impact-icon">${icon}</span>${renderInlineMarkdown(escapeHtml(text))}</li>`,
    )
    .join("");
  const impactHtml = impactItemsHtml ? `<ul class="impact">${impactItemsHtml}</ul>` : "";

  return `
      <div class="row" data-source="${slug}">
        <span class="node"></span>
        <div class="row-head">
          <span class="badge">${escapeHtml(item.source)}</span>
          ${issueLinkHtml}
          ${metaHtml}
        </div>
        ${headlineHtml}
        <p class="desc">${renderInlineMarkdown(escapeHtml(entry.description))}</p>
        ${impactHtml}
      </div>`;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

// "2026-08-07" -> "2026-08-07 (金)"。edition.dateはJST基準の暦日文字列なので、
// タイムゾーンのズレを避けるためJST正午固定でDateを作ってgetDay()する。
function formatDateLabel(dateKey) {
  const d = new Date(`${dateKey}T12:00:00+09:00`);
  return `${dateKey} (${WEEKDAY_JA[d.getDay()]})`;
}

// ナビゲーション用の短縮表記。"2026-08-07" -> "8/7"
function formatShortDate(dateKey) {
  const [, month, day] = dateKey.split("-");
  return `${Number(month)}/${Number(day)}`;
}

function renderSourcesFooter() {
  const footerHtml = FEEDS.map(
    (feed) =>
      `<a href="${escapeHtml(feed.siteUrl)}" target="_blank" rel="noopener"><span class="dot ${sourceSlug(feed.name)}"></span>${escapeHtml(feed.name)}</a>`,
  ).join("\n          ");
  return `
<footer class="sources">
  <span class="label">参照元</span>
  ${footerHtml}
</footer>`;
}

/**
 * 号ページの前号/次号ナビ。editionsは新しい日付が先頭の降順配列なので、
 * prevDate(過去へ)はindex+1、nextDate(未来へ)はindex-1側になる(呼び出し元で算出)。
 * 右矢印(→)で過去へ遡る向きにするため、prevDateを右側、nextDateを左側に配置する。
 * 端では該当リンクの代わりに無効表示にする。
 */
function renderNav(nav) {
  if (!nav) return "";
  const leftHtml = nav.nextDate
    ? `<a href="/${nav.nextDate}">← ${escapeHtml(formatShortDate(nav.nextDate))}</a>`
    : `<span class="disabled">←</span>`;
  const rightHtml = nav.prevDate
    ? `<a href="/${nav.prevDate}">${escapeHtml(formatShortDate(nav.prevDate))} →</a>`
    : `<span class="disabled">→</span>`;
  return `
<nav class="nav">
  ${leftHtml}
  <a class="spacer" href="/archive">バックナンバー</a>
  ${rightHtml}
</nav>`;
}

// 全ページ共通のHTMLシェル(head/CSS/header/footer)。ヘッダー右側とbody中身だけ
// ページごとに差し替える。
function renderShell({ headerRight, body }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>朝刊モバイル</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Sora:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${PAGE_STYLES}</style>
</head>
<body>
<div class="page">
<header class="top">
  <h1>朝刊モバイル</h1>
  ${headerRight ?? ""}
</header>
${body}
</div>
</body>
</html>`;
}

export function renderHtml(digest, nav) {
  const generatedAtLabel = nav
    ? formatDateLabel(nav.date)
    : digest
      ? new Date(digest.generatedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
      : null;

  let body;
  if (!digest) {
    body = `<div class="empty-line">まだダイジェストが生成されていません。<code>POST /run</code> で手動実行するか、次回のcron発火を待ってください。</div>`;
  } else {
    // 記事は「ソースごとのブロック」ではなく、公開日降順のフラットな1本のフィードにする
    // (新しい記事が上に来るように)。エラーitemは公開日を持たないためソート対象外とし、
    // 通常行の後ろにFEEDS順のまままとめて描画する。
    const rows = [];
    const errorItems = [];
    for (const item of digest.items) {
      if (item.error) {
        errorItems.push(item);
        continue;
      }
      for (const entry of item.entries ?? []) {
        const sortKey = entry.publishedAt ?? item.generatedAt ?? digest.generatedAt;
        rows.push({ item, entry, sortKey });
      }
    }
    rows.sort((a, b) => new Date(b.sortKey) - new Date(a.sortKey));

    const rowsHtml = rows.map(({ item, entry }) => renderEntryRow(item, entry)).join("\n");
    const errorRowsHtml = errorItems.map((item) => renderErrorRow(item)).join("\n");
    body = `<div class="feed">${rowsHtml}${errorRowsHtml}</div>`;
  }

  const headerRight = generatedAtLabel
    ? `<span class="ts">${escapeHtml(generatedAtLabel)}</span>`
    : "";

  return renderShell({
    headerRight,
    body: `${body}${renderNav(nav)}${renderSourcesFooter()}`,
  });
}

const PAGE_STYLES = `
  :root {
    --bg: oklch(99% 0.004 95);
    --bg-dark: oklch(15% 0.008 95);
    --ink: oklch(18% 0.01 95);
    --ink-dark: oklch(94% 0.006 95);
    --soft: oklch(48% 0.012 95);
    --soft-dark: oklch(65% 0.012 95);
    --line: oklch(85% 0.008 95);
    --line-dark: oklch(30% 0.01 95);
    --accent-android: oklch(62% 0.15 155);
    --accent-ios: oklch(62% 0.15 255);
    --accent-tldr: oklch(62% 0.15 330);
    --accent-other: oklch(62% 0.15 40);
    --danger: oklch(58% 0.19 25);
    --good: oklch(55% 0.14 155);
    --bad: oklch(55% 0.16 40);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--ink); font-family: "Sora", -apple-system, sans-serif; }
  @media (prefers-color-scheme: dark) { body { background: var(--bg-dark); color: var(--ink-dark); } }
  a { color: inherit; text-decoration: none; }

  .page { max-width: 620px; margin: 0 auto; padding: 32px clamp(16px, 5vw, 22px) 90px; }

  header.top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 28px; padding-bottom: 20px; border-bottom: 1px solid var(--line); }
  @media (prefers-color-scheme: dark) { header.top { border-bottom-color: var(--line-dark); } }
  header.top h1 { font-family: "Sora", -apple-system, sans-serif; font-size: clamp(16px, 4.4vw, 18px); font-weight: 700; margin: 0; white-space: nowrap; }
  header.top h1::before { content: "📱 "; }
  header.top .ts { font-family: "JetBrains Mono", monospace; font-size: 10.5px; color: var(--soft); white-space: nowrap; }
  @media (prefers-color-scheme: dark) { header.top .ts { color: var(--soft-dark); } }

  .sources { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--line); font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--soft); }
  @media (prefers-color-scheme: dark) { .sources { border-top-color: var(--line-dark); color: var(--soft-dark); } }
  .sources .label { color: var(--soft); }
  @media (prefers-color-scheme: dark) { .sources .label { color: var(--soft-dark); } }
  .sources a { display: flex; align-items: center; gap: 6px; }
  .sources a:hover { text-decoration: underline; }
  .sources .dot { width: 7px; height: 7px; border-radius: 999px; flex: none; }
  .sources .dot.android { background: var(--accent-android); }
  .sources .dot.ios { background: var(--accent-ios); }
  .sources .dot.tldr { background: var(--accent-tldr); }
  .sources .dot.other { background: var(--accent-other); }

  .feed { position: relative; padding-left: 20px; }
  .feed::before { content: ""; position: absolute; left: 4px; top: 8px; bottom: 8px; width: 1px; background: var(--line); }
  @media (prefers-color-scheme: dark) { .feed::before { background: var(--line-dark); } }

  .row { position: relative; margin-bottom: 30px; }
  .row:last-child { margin-bottom: 0; }
  .row .node { position: absolute; left: -20px; top: 6px; width: 9px; height: 9px; border-radius: 999px; border: 2px solid var(--bg); }
  @media (prefers-color-scheme: dark) { .row .node { border-color: var(--bg-dark); } }
  .row[data-source="android"] .node { background: var(--accent-android); }
  .row[data-source="ios"] .node { background: var(--accent-ios); }
  .row[data-source="tldr"] .node { background: var(--accent-tldr); }
  .row[data-source="other"] .node { background: var(--accent-other); }

  .row-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-family: "JetBrains Mono", monospace; font-size: 11px; color: var(--soft); margin-bottom: 10px; }
  @media (prefers-color-scheme: dark) { .row-head { color: var(--soft-dark); } }
  .row-head .badge { font-weight: 600; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--line); line-height: 1.4; }
  @media (prefers-color-scheme: dark) { .row-head .badge { border-color: var(--line-dark); } }
  .row[data-source="android"] .badge { color: var(--accent-android); }
  .row[data-source="ios"] .badge { color: var(--accent-ios); }
  .row[data-source="tldr"] .badge { color: var(--accent-tldr); }
  .row[data-source="other"] .badge { color: var(--accent-other); }
  .row-head a.issue { color: var(--soft); padding: 3px 2px; }
  @media (prefers-color-scheme: dark) { .row-head a.issue { color: var(--soft-dark); } }
  .row-head a.issue:hover { text-decoration: underline; }
  .row-head .stale { color: oklch(58% 0.16 70); }

  .row .headline { display: inline-block; font-size: clamp(15px, 4vw, 16px); font-weight: 600; margin-bottom: 6px; line-height: 1.5; padding: 1px 0; }
  .row a.headline:hover { text-decoration: underline; text-underline-offset: 3px; }
  .row .desc { font-size: 14px; line-height: 1.75; color: var(--soft); margin: 0; max-width: 56ch; }
  @media (prefers-color-scheme: dark) { .row .desc { color: var(--soft-dark); } }

  .row .impact { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-width: 56ch; }
  .row .impact li { font-size: 12.5px; line-height: 1.6; display: flex; gap: 6px; }
  .row .impact-good { color: var(--good); }
  .row .impact-bad { color: var(--bad); }
  .row .impact-icon { flex: none; font-weight: 700; }

  .row.error .headline { color: var(--danger); }
  .row.error .desc { color: var(--danger); font-family: "JetBrains Mono", monospace; font-size: 12px; }

  .empty-line { font-family: "JetBrains Mono", monospace; font-size: 12.5px; color: var(--soft); border: 1px dashed var(--line); border-radius: 6px; padding: 18px; }
  @media (prefers-color-scheme: dark) { .empty-line { color: var(--soft-dark); border-color: var(--line-dark); } }
  .empty-line code { color: var(--ink); background: var(--line); border-radius: 3px; padding: 1px 5px; }
  @media (prefers-color-scheme: dark) { .empty-line code { color: var(--ink-dark); background: var(--line-dark); } }
  .empty-line a { color: var(--ink); text-decoration: underline; }
  @media (prefers-color-scheme: dark) { .empty-line a { color: var(--ink-dark); } }

  .nav { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--line); font-family: "JetBrains Mono", monospace; font-size: 12px; }
  @media (prefers-color-scheme: dark) { .nav { border-top-color: var(--line-dark); } }
  .nav a { color: var(--soft); }
  @media (prefers-color-scheme: dark) { .nav a { color: var(--soft-dark); } }
  .nav a:hover { text-decoration: underline; }
  .nav .disabled { color: var(--line); }
  .nav > :first-child { justify-self: start; }
  .nav > .spacer { justify-self: center; }
  .nav > :last-child { justify-self: end; }
  @media (prefers-color-scheme: dark) { .nav .disabled { color: var(--line-dark); } }

  .archive-group { margin-bottom: 24px; }
  .archive-group h2 { font-family: "JetBrains Mono", monospace; font-size: 12px; font-weight: 600; color: var(--soft); margin: 0 0 10px; }
  @media (prefers-color-scheme: dark) { .archive-group h2 { color: var(--soft-dark); } }
  .archive-group ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .archive-group a { font-size: 14px; padding: 4px 0; }
  .archive-group a:hover { text-decoration: underline; }
`;

/**
 * 発行日一覧ページ("/archive")。年月ごとにグルーピングして新しい順に並べる。
 */
export function renderArchiveHtml(editions) {
  let body;
  if (editions.length === 0) {
    body = `<div class="empty-line">まだ号がありません。</div>`;
  } else {
    const groups = new Map();
    for (const date of editions) {
      const yearMonth = date.slice(0, 7); // YYYY-MM
      if (!groups.has(yearMonth)) groups.set(yearMonth, []);
      groups.get(yearMonth).push(date);
    }

    body = [...groups.entries()]
      .map(([yearMonth, dates]) => {
        const [year, month] = yearMonth.split("-");
        const itemsHtml = dates
          .map((date) => `<li><a href="/${date}">${escapeHtml(formatDateLabel(date))}</a></li>`)
          .join("\n          ");
        return `
      <div class="archive-group">
        <h2>${Number(year)}年${Number(month)}月</h2>
        <ul>
          ${itemsHtml}
        </ul>
      </div>`;
      })
      .join("\n");
  }

  return renderShell({
    headerRight: `<span class="ts">バックナンバー</span>`,
    body: `${body}${renderSourcesFooter()}`,
  });
}

/**
 * 指定日の号がまだ無い/存在しない場合の404ページ。
 */
export function renderNotFoundHtml(date) {
  const body = `<div class="empty-line">${escapeHtml(date)} の号は見つかりませんでした。<a href="/archive">バックナンバー一覧</a>から探してください。</div>`;
  return renderShell({
    headerRight: "",
    body: `${body}${renderSourcesFooter()}`,
  });
}

// リトライ用cron ("0 0 * * *" = 9:00 JST、本番cronの4時間後、毎日)。この文字列は
// wrangler.tomlの [triggers].crons と一致させること。
const RETRY_CRON = "0 0 * * *";

/**
 * mode: "single" の週次ソース(Android Weekly / iOS Dev Weekly)を取得してよい日か。
 * 週1回しか新しい号が出ないため、毎日取得しても同じ号を再要約するだけで
 * Gemini呼び出しの無駄になる。JST基準の月曜のみ取得する。
 *
 * 本番cronは20:00 UTC(前日)=5:00 JSTに発火するため、event.scheduledTimeのUTC上の
 * 曜日とJSTの曜日がズレる（例: UTC日曜20:00 = JST月曜5:00）。判定を必ずJSTに
 * 変換してから行うこと（そのままgetUTCDay()すると一日ズレて誤判定する）。
 */
function isWeeklyRefreshDay(scheduledTime) {
  const jst = new Date(new Date(scheduledTime).getTime() + JST_OFFSET_MS);
  return jst.getUTCDay() === 1; // 1 = Monday (JST基準)
}

const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" };

// フィード画面のタイムラインノード(ソース別アクセントカラーのドット)をリング状にした
// favicon。ダークモードはprefers-color-schemeで自動切り替え。
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<style>
.bg{fill:oklch(99% 0.004 95)}
.dot{fill:oklch(18% 0.01 95)}
@media (prefers-color-scheme: dark) {
.bg{fill:oklch(15% 0.008 95)}
.dot{fill:oklch(94% 0.006 95)}
}
</style>
<circle class="bg" cx="50" cy="50" r="50"/>
<g transform="rotate(-90 50 50)" fill="none" stroke-width="14">
<circle cx="50" cy="50" r="32" stroke="oklch(62% 0.15 155)" stroke-dasharray="50.2655 150.7964" stroke-dashoffset="0"/>
<circle cx="50" cy="50" r="32" stroke="oklch(62% 0.15 255)" stroke-dasharray="50.2655 150.7964" stroke-dashoffset="-50.2655"/>
<circle cx="50" cy="50" r="32" stroke="oklch(62% 0.15 330)" stroke-dasharray="50.2655 150.7964" stroke-dashoffset="-100.531"/>
<circle cx="50" cy="50" r="32" stroke="oklch(62% 0.15 40)" stroke-dasharray="50.2655 150.7964" stroke-dashoffset="-150.7964"/>
</g>
<circle class="dot" cx="50" cy="50" r="12"/>
</svg>
`;

/**
 * 号ページ("/"または"/YYYY-MM-DD")のレスポンスを組み立てる。
 * editions(新しい日付が先頭の降順配列)上でのdateの位置から前号/次号を求める。
 * 該当日のeditionが無ければ404ページを返す。
 */
async function respondWithEdition(env, editions, date) {
  const index = editions.indexOf(date);
  if (index === -1) {
    return new Response(renderNotFoundHtml(date), { status: 404, headers: HTML_HEADERS });
  }

  const raw = await env.DIGEST_KV.get(`edition:${date}`);
  const edition = raw ? JSON.parse(raw) : null;
  if (!edition) {
    return new Response(renderNotFoundHtml(date), { status: 404, headers: HTML_HEADERS });
  }

  const nav = {
    date,
    prevDate: editions[index + 1] ?? null, // 降順配列なので次のindexは過去日
    nextDate: index > 0 ? editions[index - 1] : null,
    isLatest: index === 0,
  };
  return new Response(renderHtml(edition, nav), { headers: HTML_HEADERS });
}

/**
 * fromアドレスのドメインが許可リストに含まれるか。
 * email()ハンドラの差出人検証にのみ使う(TLDR_AI_ALLOWED_SENDER_DOMAINS参照)。
 */
function isAllowedEmailSender(from, allowedDomains) {
  const domain = String(from ?? "").split("@")[1]?.toLowerCase();
  if (!domain) return false;
  return allowedDomains.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

/**
 * 認証なしで公開すると、URLを知っている誰でも叩けてしまう(/runはGemini APIキー消費、
 * /logsは内部エラーメッセージの閲覧につながる)。共有シークレットで保護する。
 * 未認証ならUnauthorizedレスポンスを返し、認証済みならnullを返す。
 */
function requireRunSecret(request, env) {
  if (request.headers.get("x-run-secret") !== env.RUN_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === RETRY_CRON) {
      ctx.waitUntil(retryFailedSources(env));
    } else {
      const feedsToProcess = FEEDS.filter(
        (feed) => feed.mode === "multi" || isWeeklyRefreshDay(event.scheduledTime),
      );
      ctx.waitUntil(generateDigest(env, feedsToProcess, { trigger: event.cron }));
    }
  },

  /**
   * Cloudflare Email Routingが受信したメールを処理する。要約は行わず、
   * 受信内容をKVへ保存するだけ(processFeedSource経由のbuildInboxContentが5:00 JST cronで
   * 読みに来る)。差出人検証を通らないメールはsetRejectで拒否する — 受信アドレスを知った
   * 第三者が任意のHTMLを送り込み、それがGeminiに要約されて公開ページに載る経路を塞ぐため
   * (SPF/DKIM/DMARCの検証自体はCloudflare Email Routing側で完了している前提)。
   */
  async email(message, env, ctx) {
    if (!isAllowedEmailSender(message.from, TLDR_AI_ALLOWED_SENDER_DOMAINS)) {
      message.setReject("Unexpected sender");
      return;
    }
    const parsed = await PostalMime.parse(message.raw);
    await env.DIGEST_KV.put(
      TLDR_AI_INBOX_KEY,
      JSON.stringify({
        html: parsed.html ?? "",
        subject: parsed.subject ?? "",
        from: message.from,
        receivedAt: new Date().toISOString(),
      }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/run") {
      const unauthorized = requireRunSecret(request, env);
      if (unauthorized) return unauthorized;
      // ?force=1 で、取得内容が前回と同じでもfingerprintキャッシュを無視して強制的に
      // 再要約する(要約が失敗気味だったときの手動やり直し用)。
      const force = url.searchParams.get("force") === "1";
      const digest = await generateDigest(env, FEEDS, { force });
      return new Response(JSON.stringify(digest, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (request.method !== "GET") {
      return new Response("Not Found", { status: 404 });
    }

    if (url.pathname === "/logs") {
      const unauthorized = requireRunSecret(request, env);
      if (unauthorized) return unauthorized;
      const raw = await env.DIGEST_KV.get("logs");
      const logs = raw ? JSON.parse(raw) : [];
      return new Response(JSON.stringify(logs, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/favicon.svg") {
      return new Response(FAVICON_SVG, {
        headers: {
          "Content-Type": "image/svg+xml; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    if (url.pathname === "/apple-touch-icon.png") {
      return new Response(Uint8Array.from(atob(APPLE_TOUCH_ICON_PNG_BASE64), (c) => c.charCodeAt(0)), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }

    if (url.pathname === "/archive") {
      const editionsRaw = await env.DIGEST_KV.get("editions");
      const editions = editionsRaw ? JSON.parse(editionsRaw) : [];
      return new Response(renderArchiveHtml(editions), { headers: HTML_HEADERS });
    }

    const editionsRaw = await env.DIGEST_KV.get("editions");
    const editions = editionsRaw ? JSON.parse(editionsRaw) : [];

    if (url.pathname === "/") {
      if (editions.length === 0) {
        // 移行期フォールバック: editionがまだ1件も無い(導入直後)場合はlatestをそのまま出す。
        const raw = await env.DIGEST_KV.get("latest");
        const digest = raw ? JSON.parse(raw) : null;
        return new Response(renderHtml(digest), { headers: HTML_HEADERS });
      }
      return respondWithEdition(env, editions, editions[0]);
    }

    const dateMatch = url.pathname.match(/^\/(\d{4}-\d{2}-\d{2})$/);
    if (dateMatch) {
      return respondWithEdition(env, editions, dateMatch[1]);
    }

    return new Response("Not Found", { status: 404 });
  },
};
