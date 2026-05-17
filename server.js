import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, "data");
const usageFile = join(dataDir, "usage.json");
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const usageLimits = {
  "gemini-2.5-flash": { rpm: 5, tpm: 250_000, rpd: 20 },
  "gemini-3.1-flash-lite": { rpm: 15, tpm: 250_000, rpd: 500 }
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function emptyUsage() {
  return { events: [] };
}

async function readUsage() {
  try {
    return { ...emptyUsage(), ...JSON.parse(await readFile(usageFile, "utf8")) };
  } catch {
    return emptyUsage();
  }
}

async function writeUsage(usage) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(usageFile, JSON.stringify(usage, null, 2));
}

function summarizeUsage(usage, model = "gemini-2.5-flash") {
  const now = Date.now();
  const day = todayKey(new Date(now));
  const events = Array.isArray(usage.events) ? usage.events : [];
  const dailyEvents = events.filter(event => event.model === model && event.day === day);
  const minuteEvents = dailyEvents.filter(event => now - Number(event.timestamp || 0) < 60_000);
  const limits = usageLimits[model] || usageLimits["gemini-2.5-flash"];
  const used = {
    rpm: minuteEvents.length,
    tpm: minuteEvents.reduce((sum, event) => sum + Number(event.tokens || 0), 0),
    rpd: dailyEvents.length
  };

  return {
    model,
    limits,
    used,
    percentages: {
      rpm: Math.min(100, Math.round((used.rpm / limits.rpm) * 100)),
      tpm: Math.min(100, Math.round((used.tpm / limits.tpm) * 100)),
      rpd: Math.min(100, Math.round((used.rpd / limits.rpd) * 100))
    },
    reset: {
      rpmSeconds: minuteEvents.length ? Math.max(0, Math.ceil((60_000 - (now - Number(minuteEvents[0].timestamp || 0))) / 1000)) : 0,
      rpdDate: day
    }
  };
}

async function recordGeminiUsage(model, usageMetadata) {
  const usage = await readUsage();
  const now = Date.now();
  const day = todayKey(new Date(now));
  const tokens = Number(usageMetadata?.totalTokenCount || usageMetadata?.promptTokenCount || 0);
  const events = Array.isArray(usage.events) ? usage.events : [];
  const cutoff = now - 48 * 60 * 60 * 1000;

  usage.events = [
    ...events.filter(event => Number(event.timestamp || 0) >= cutoff),
    {
      timestamp: now,
      day,
      model,
      tokens,
      promptTokens: Number(usageMetadata?.promptTokenCount || 0),
      candidateTokens: Number(usageMetadata?.candidatesTokenCount || 0)
    }
  ];

  await writeUsage(usage);
  return summarizeUsage(usage, model);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function stripHtml(value = "") {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWordForOxford(word) {
  return String(word || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function phraseMatchesExample(definitionBlock, example) {
  const text = stripHtml(definitionBlock).toLowerCase();
  const words = String(example || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .match(/[a-z]{4,}/g) || [];
  const unique = [...new Set(words)].slice(0, 14);
  return unique.reduce((score, word) => score + (text.includes(word) ? 1 : 0), 0);
}

function parseOxford(html, requestedPartOfSpeech, example) {
  const entries = [];
  const entryRegex = /<li[^>]+class="[^"]*sense[^"]*"[\s\S]*?<\/li>/gi;
  const blocks = html.match(entryRegex) || [];
  const pageText = stripHtml(html);
  const phonetic = pageText.match(/\/([^/]{2,40})\//)?.[1]?.trim() || "";
  const posMatches = [...html.matchAll(/<span[^>]+class="pos"[^>]*>([\s\S]*?)<\/span>/gi)].map(match => stripHtml(match[1]));
  const fallbackPos = posMatches[0] || requestedPartOfSpeech || "";
  const representativeCefr = extractRepresentativeCefr(html);

  for (const block of blocks) {
    const defMatch = block.match(/<span[^>]+class="[^"]*def[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (!defMatch) continue;

    const definition = stripHtml(defMatch[1]);
    const blockPrefix = html.slice(Math.max(0, html.indexOf(block) - 3000), html.indexOf(block));
    const pos = [...blockPrefix.matchAll(/<span[^>]+class="pos"[^>]*>([\s\S]*?)<\/span>/gi)]
      .map(match => stripHtml(match[1]))
      .pop() || fallbackPos;
    const senseCefr = extractCefr(block);

    entries.push({
      partOfSpeech: pos,
      definition,
      cefr: senseCefr || representativeCefr,
      senseCefr,
      score: phraseMatchesExample(block, example) + (requestedPartOfSpeech && pos.includes(requestedPartOfSpeech) ? 3 : 0)
    });
  }

  entries.sort((a, b) => b.score - a.score);
  return {
    phonetic,
    cefr: entries[0]?.cefr || "",
    definition: entries[0]?.definition || "",
    partOfSpeech: entries[0]?.partOfSpeech || fallbackPos
  };
}

function extractCefr(html) {
  const text = stripHtml(html);
  return text.match(/\b(A1|A2|B1|B2|C1|C2)\b/)?.[1] || "";
}

function extractRepresentativeCefr(html) {
  const firstSenseIndex = html.search(/<li[^>]+class="[^"]*sense[^"]*"/i);
  const headwordArea = firstSenseIndex > 0 ? html.slice(0, firstSenseIndex) : html.slice(0, 5000);
  return extractCefr(headwordArea) || extractCefr(html);
}

function normalizeCefr(value) {
  const cefr = String(value || "").toUpperCase().match(/\b(A1|A2|B1|B2|C1|C2)\b/)?.[1] || "";
  return cefr;
}

function normalizePartOfSpeech(value) {
  const normalized = stripHtml(value).toLowerCase();
  const compact = normalized.replace(/\s+/g, "");
  const map = {
    "名詞": "noun",
    "動詞": "verb",
    "他動詞": "verb",
    "自動詞": "verb",
    "形容詞": "adjective",
    "副詞": "adverb",
    "前置詞": "preposition",
    "接続詞": "conjunction",
    "代名詞": "pronoun",
    "間投詞": "interjection",
    "熟語": "phrase",
    "句動詞": "phrasal verb",
    "イディオム": "idiom",
    "n": "noun",
    "v": "verb",
    "adj": "adjective",
    "adv": "adverb",
    "prep": "preposition",
    "conj": "conjunction"
  };
  return map[compact] || normalized || "";
}

async function fetchOxford(word, partOfSpeech, example) {
  const slug = normalizeWordForOxford(word);
  if (!slug) return {};

  const url = `https://www.oxfordlearnersdictionaries.com/definition/english/${slug}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 Anki TSV Builder/0.1",
      "accept": "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    throw new Error(`Oxford page returned ${response.status}`);
  }

  const html = await response.text();
  return { ...parseOxford(html, partOfSpeech, example), sourceUrl: url };
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || raw;
  const objectText = firstJsonObject(candidate);
  return objectText ? JSON.parse(objectText) : null;
}

function firstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return "";
}

async function askGemini(apiKey, model, cards, oxfordResults) {
  const safeApiKey = String(apiKey || "").replace(/\s+/g, "");
  if (!safeApiKey) {
    throw new Error("Gemini API key is required.");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(safeApiKey)) {
    throw new Error("Gemini APIキーに使えない文字が含まれています。APIキーだけを貼り付けてください。");
  }

  const safeModel = String(model || "gemini-2.5-flash").trim();
  const prompt = {
    instruction: [
      "You are generating fields for an Anki TSV for Japanese learners of English.",
      "Return strict JSON only.",
      "For each card, fill phonetic, definition, cefr, and etymology.",
      "Use the Oxford definition exactly when provided. If Oxford has no definition, provide a concise learner-friendly fallback definition.",
      "The definition field must be the English definition only, without part of speech prefix.",
      "The etymology field should be Japanese and use this style when possible: ◇L.detinere（拘置する）+tion.",
      "Do not generate or rewrite japanese. If a japanese field is present in the response, copy the input japanese value unchanged.",
      "For cefr, return A1, A2, B1, B2, C1, or C2 only when you can determine it from reliable dictionary knowledge. Otherwise return an empty string. Do not default to C1.",
      "Return exactly one card object for every input card.",
      "The cards array length must equal the input cards length.",
      "Keep every row index unchanged."
    ],
    cards: cards.map((card, index) => ({
      index: Number.isInteger(Number(card.index)) ? Number(card.index) : index,
      word: card.word,
      sentence: card.sentence,
      japanese: card.japanese,
      memo: card.memo,
      frequency: card.frequency,
      partOfSpeech: card.partOfSpeech,
      oxford: oxfordResults[index] || {}
    })),
    responseShape: {
      cards: [
        {
          index: 0,
          japanese: "入力値を変更せずそのまま返す",
          phonetic: "slashes removed",
          definition: "Oxford definition or fallback definition",
          cefr: "A1/A2/B1/B2/C1/C2 or empty string",
          etymology: "原義",
          error: ""
        }
      ]
    }
  };

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(safeModel)}:generateContent?key=${encodeURIComponent(safeApiKey)}`;
  const response = await fetch(geminiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: JSON.stringify(prompt) }]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    const message = await response.text();
    if (response.status === 503) {
      throw new Error("選択中のGeminiモデルが混雑しています。少し待って再実行するか、Gemini 2.5 Flash Lite に切り替えてください。");
    }
    if (response.status === 429) {
      throw new Error("Geminiの利用制限に達しました。使用量メーターを確認して、制限が回復してから再実行してください。");
    }
    if (response.status === 400 || response.status === 403) {
      throw new Error(`Gemini APIキーまたはモデル設定を確認してください。Gemini API returned ${response.status}: ${message.slice(0, 200)}`);
    }
    throw new Error(`Gemini API returned ${response.status}: ${message.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("") || "";
  const parsed = extractJson(text);
  const parsedCards = normalizeGeminiCards(parsed);
  if (!parsedCards.length) {
    throw new Error(`Geminiの応答にカード配列がありませんでした。応答冒頭: ${text.slice(0, 300)}`);
  }
  return { cards: parsedCards, usageMetadata: data.usageMetadata || {} };
}

function normalizeGeminiCards(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.cards)) return parsed.cards;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.results)) return parsed.results;
  if (Array.isArray(parsed?.rows)) return parsed.rows;
  if (parsed && typeof parsed === "object" && Number.isInteger(Number(parsed.index))) return [parsed];
  return [];
}

async function handleEnrichBatch(req, res) {
  try {
    const body = JSON.parse(await readBody(req));
    const cards = Array.isArray(body.cards) ? body.cards.slice(0, 200) : [];
    if (!cards.length) throw new Error("No cards were provided.");

    const oxfordResults = await Promise.all(cards.map(card =>
      fetchOxford(card.word, card.partOfSpeech, card.sentence).catch(error => ({ error: error.message }))
    ));
    const geminiResult = await askGemini(body.apiKey, body.model, cards, oxfordResults);
    const geminiCards = geminiResult.cards;
    const usage = await recordGeminiUsage(body.model || "gemini-2.5-flash", geminiResult.usageMetadata);

    const enriched = cards.map((card, index) => {
      const oxford = oxfordResults[index] || {};
      const gemini = geminiCardAt(geminiCards, index) || {};
      return {
        index: Number.isInteger(Number(card.index)) ? Number(card.index) : index,
        word: card.word,
        sentence: card.sentence,
        memo: card.memo,
        frequency: card.frequency,
        partOfSpeech: normalizePartOfSpeech(card.partOfSpeech || oxford.partOfSpeech || ""),
        japanese: card.japanese || "",
        phonetic: gemini.phonetic || oxford.phonetic || "",
        definition: oxford.definition || gemini.definition || "",
        cefr: normalizeCefr(oxford.cefr) || normalizeCefr(gemini.cefr) || "",
        etymology: gemini.etymology || "",
        error: oxford.error ? `Oxford: ${oxford.error}` : gemini.error || ""
      };
    });

    json(res, 200, { cards: enriched, usage });
  } catch (error) {
    json(res, 400, { error: error.message });
  }
}

function geminiCardAt(geminiCards, index) {
  if (!Array.isArray(geminiCards)) return null;
  const byIndex = geminiCards.find(item => Number(item?.index) === index);
  if (byIndex) return byIndex;
  return geminiCards[index] || null;
}

async function handleUsage(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const model = url.searchParams.get("model") || "gemini-2.5-flash";
    json(res, 200, summarizeUsage(await readUsage(), model));
  } catch (error) {
    json(res, 400, { error: error.message });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/enrich-batch") {
    handleEnrichBatch(req, res);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/usage")) {
    handleUsage(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.listen(port, host, () => {
  console.log(`Anki TSV Builder running at http://${host}:${port}`);
});
