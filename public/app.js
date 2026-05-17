const bulkInput = document.querySelector("#bulkInput");
const output = document.querySelector("#tsvOutput");
const status = document.querySelector("#status");
const rowCount = document.querySelector("#rowCount");
const resultBody = document.querySelector("#resultBody");
const geminiKey = document.querySelector("#geminiKey");
const geminiModel = document.querySelector("#geminiModel");
const rememberKey = document.querySelector("#rememberKey");
const enrichBtn = document.querySelector("#enrichBtn");
const copyBtn = document.querySelector("#copyBtn");
const downloadBtn = document.querySelector("#downloadBtn");
const clearBtn = document.querySelector("#clearBtn");
const rpmText = document.querySelector("#rpmText");
const tpmText = document.querySelector("#tpmText");
const rpdText = document.querySelector("#rpdText");
const rpmBar = document.querySelector("#rpmBar");
const tpmBar = document.querySelector("#tpmBar");
const rpdBar = document.querySelector("#rpdBar");
const quotaNote = document.querySelector("#quotaNote");
const toast = document.querySelector("#toast");
const existingNotesFile = document.querySelector("#existingNotesFile");
const caseSensitiveDupes = document.querySelector("#caseSensitiveDupes");
const dupeSummary = document.querySelector("#dupeSummary");
const progressPanel = document.querySelector("#progressPanel");
const progressText = document.querySelector("#progressText");
const progressCount = document.querySelector("#progressCount");
const progressBar = document.querySelector("#progressBar");
const inputModeRadios = [...document.querySelectorAll('input[name="inputMode"]')];
const ocrFrequency = document.querySelector("#ocrFrequency");
const ocrFrequencyLabel = document.querySelector("#ocrFrequencyLabel");
const ocrPartOfSpeechBlocks = document.querySelector("#ocrPartOfSpeechBlocks");
const ocrPartOfSpeechBlocksInput = document.querySelector("#ocrPartOfSpeechBlocksInput");
const inputHint = document.querySelector("#inputHint");
const knownWordsInput = document.querySelector("#knownWordsInput");

const inputHeaders = ["覚えたい単語", "空欄つきの文", "日本語訳", "パス単備考", "でる度", "品詞"];
const outputHeaders = ["覚えたい単語", "空欄つきの文", "日本語訳", "発音記号", "単語の定義", "タイプ2", "備考", "タグ"];
let cards = [];
let existingWords = new Map();
let knownWords = new Set();
const existingWordsStorageKey = "ankiTsvExistingWords";
const existingWordsMetaStorageKey = "ankiTsvExistingWordsMeta";

function cleanCell(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .trim();
}

function outputCell(text) {
  return cleanCell(text).replace(/\n/g, "<br>");
}

function stripSlashes(text) {
  return cleanCell(text).replaceAll("/", "");
}

function parsePastedRows(text) {
  const rows = parseDelimitedText(text)
    .map(row => row.map(cell => cleanCell(cell)))
    .filter(row => row.some(Boolean));

  if (!rows.length) return [];

  const first = rows[0].map(cell => cleanCell(cell));
  const ocrMode = currentInputMode() === "ocr";
  const hasHeader = ocrMode
    ? ["覚えたい単語", "空欄つきの文", "日本語訳", "パス単備考"].every((header, index) => first[index] === header)
    : inputHeaders.every((header, index) => first[index] === header);
  return (hasHeader ? rows.slice(1) : rows)
    .map((row, index) => buildInputCard(row, index, ocrMode))
    .filter(card => card.word || card.sentence);
}

function buildInputCard(row, index, ocrMode) {
  const partOfSpeech = ocrMode ? ocrPartOfSpeechForRow(index) : row[5] || "";
  return {
    id: crypto.randomUUID(),
    index,
    selected: true,
    word: row[0] || "",
    sentence: row[1] || "",
    japanese: row[2] || "",
    memo: row[3] || "",
    frequency: ocrMode ? cleanCell(ocrFrequency.value) : row[4] || "",
    partOfSpeech: normalizePartOfSpeech(partOfSpeech),
    originalPartOfSpeech: partOfSpeech,
    phonetic: "",
    definition: "",
    cefr: "",
    etymology: "",
    state: "未補完",
    error: ""
  };
}

function parseOcrPartOfSpeechBlocks() {
  const assignments = [];
  const lines = String(ocrPartOfSpeechBlocksInput.value || "")
    .split(/\r?\n/)
    .map(line => cleanCell(line))
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const count = Number(match[1]);
    const partOfSpeech = cleanCell(match[2]);
    if (Number.isInteger(count) && count > 0 && partOfSpeech) {
      assignments.push({ count, partOfSpeech });
    }
  }

  return assignments;
}

function ocrPartOfSpeechForRow(rowIndex) {
  let cursor = 0;
  for (const assignment of parseOcrPartOfSpeechBlocks()) {
    cursor += assignment.count;
    if (rowIndex < cursor) return assignment.partOfSpeech;
  }
  return "";
}

function parseDelimitedText(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const value = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "\t" && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" && !inQuotes) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows;
}

function normalizeDuplicateKey(value) {
  const withoutSpacing = String(value || "")
    .replace(/\r\n/g, "")
    .replace(/[\n\r]/g, "")
    .replace(/[\u0020\u00a0\u3000\t]+/g, "")
    .trim();
  return caseSensitiveDupes.checked ? withoutSpacing : withoutSpacing.toLowerCase();
}

function currentInputMode() {
  return inputModeRadios.find(input => input.checked)?.value || "numbers";
}

function parseKnownWords(text) {
  return new Set(
    String(text || "")
      .split(/\r?\n/)
      .map(word => normalizeDuplicateKey(word))
      .filter(Boolean)
  );
}

function applyKnownWordSelection() {
  cards = cards.map(card => {
    const known = knownWords.has(normalizeDuplicateKey(card.word));
    return {
      ...card,
      knownWord: known,
      selected: known ? false : card.selected
    };
  });
}

function parseExistingNotes(text) {
  const rows = parseDelimitedText(text)
    .map(row => row.map(cell => cleanCell(cell)))
    .filter(row => row.some(Boolean));
  const words = new Map();

  for (const row of rows) {
    const first = row[0] || "";
    if (first.startsWith("#")) continue;
    const key = normalizeDuplicateKey(first);
    if (key && !words.has(key)) {
      words.set(key, first.replace(/\n/g, ""));
    }
  }

  return words;
}

function applyDuplicateWarnings() {
  cards = cards.map(card => {
    const key = normalizeDuplicateKey(card.word);
    const duplicateWord = key ? existingWords.get(key) : "";
    return {
      ...card,
      duplicateWord,
      duplicateMessage: duplicateWord ? `既存ノートに同じ覚えたい単語があります: ${duplicateWord}` : ""
    };
  });
}

function normalizePartOfSpeech(value) {
  const normalized = cleanCell(value).toLowerCase();
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

function buildDefinition(card) {
  if (!card.definition) return "";
  const definition = card.definition.replace(/^[^:：]{1,30}[:：]\s*/, "");
  return `${normalizePartOfSpeech(card.partOfSpeech) || "word"}: ${definition}`;
}

function buildTags(card) {
  const frequency = card.frequency || "未設定";
  const partOfSpeech = card.originalPartOfSpeech || card.partOfSpeech || "未設定";
  const cefr = cleanCell(card.cefr);
  const tags = [];
  if (cefr && cefr !== "未設定") {
    tags.push(`CEFR::${cefr}`);
  }
  tags.push(`英検1級でる順パス単::でる度${frequency}`);
  tags.push(`語彙::${partOfSpeech}`);
  return tags.join(" ");
}

function buildNote(card) {
  return [card.etymology, card.memo].filter(Boolean).join("\n");
}

function buildOutputRow(card) {
  return [
    card.word,
    card.sentence,
    card.japanese,
    stripSlashes(card.phonetic),
    buildDefinition(card),
    "y",
    buildNote(card),
    buildTags(card)
  ].map(outputCell);
}

function renderTsv() {
  const rows = [outputHeaders, ...cards.filter(card => card.selected).map(buildOutputRow)];
  output.value = rows.map(row => row.join("\t")).join("\n");
  rowCount.textContent = `${cards.filter(card => card.selected).length} / ${cards.length}行`;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function previewCell(text, max = 260) {
  const value = cleanCell(text);
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function renderTable() {
  if (!cards.length) {
    resultBody.innerHTML = '<tr><td colspan="11" class="empty">貼り付けて読み込んでください。</td></tr>';
    renderTsv();
    return;
  }

  resultBody.innerHTML = cards.map((card, index) => `
    <tr>
      <td><input class="rowSelect" type="checkbox" data-index="${index}" ${card.selected ? "checked" : ""} aria-label="${escapeHtml(card.word)}を出力する"></td>
      <td class="multiline">${escapeHtml(card.word)}</td>
      <td><input class="tableTextInput partOfSpeechInput" data-index="${index}" value="${escapeHtml(card.originalPartOfSpeech || card.partOfSpeech)}" aria-label="${escapeHtml(card.word)}の品詞"></td>
      <td class="multiline">${escapeHtml(previewCell(card.sentence))}</td>
      <td class="multiline">${escapeHtml(previewCell(card.japanese, 120))}</td>
      <td class="multiline">${escapeHtml(card.phonetic)}</td>
      <td class="multiline">${escapeHtml(previewCell(buildDefinition(card), 220))}</td>
      <td class="multiline">${escapeHtml(previewCell(buildNote(card), 220))}</td>
      <td class="multiline">${escapeHtml(previewCell(buildTags(card), 160))}</td>
      <td class="multiline ${card.duplicateMessage ? "warn" : ""}">${escapeHtml(card.duplicateMessage || "")}</td>
      <td class="${card.error ? "bad" : card.state === "補完済み" ? "good" : card.knownWord ? "warn" : ""}">${escapeHtml(card.knownWord ? "既知単語のため出力対象外" : card.error || card.state)}</td>
    </tr>
  `).join("");
  resultBody.querySelectorAll(".rowSelect").forEach(input => {
    input.addEventListener("change", event => {
      const index = Number(event.currentTarget.dataset.index);
      cards[index] = { ...cards[index], selected: event.currentTarget.checked };
      renderTsv();
      updateDupeSummary();
    });
  });
  resultBody.querySelectorAll(".partOfSpeechInput").forEach(input => {
    input.addEventListener("input", event => {
      const index = Number(event.currentTarget.dataset.index);
      const partOfSpeech = cleanCell(event.currentTarget.value);
      cards[index] = {
        ...cards[index],
        partOfSpeech: normalizePartOfSpeech(partOfSpeech),
        originalPartOfSpeech: partOfSpeech
      };
      renderTsv();
    });
  });
  renderTsv();
}

function loadRows() {
  cards = parsePastedRows(bulkInput.value);
  knownWords = parseKnownWords(knownWordsInput.value);
  applyKnownWordSelection();
  applyDuplicateWarnings();
  status.textContent = cards.length ? `${cards.length}行を読み込み` : "入力待ち";
  renderTable();
}

function updateDupeSummary() {
  const duplicateCount = cards.filter(card => card.selected && card.duplicateMessage).length;
  if (!existingWords.size) {
    dupeSummary.textContent = "既存ノート未読み込み";
  } else {
    const meta = readExistingWordsMeta();
    const source = meta?.fileName ? `（${meta.fileName}）` : "";
    dupeSummary.textContent = `既存単語 ${existingWords.size}件${source} / 重複 ${duplicateCount}件`;
  }
}

let toastTimer;

function showToast(message, tone = "ok") {
  toast.textContent = message;
  toast.className = `toast show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.className = "toast";
  }, 2600);
}

function formatNumber(value) {
  return new Intl.NumberFormat("ja-JP").format(Number(value || 0));
}

function renderUsage(usage) {
  if (!usage?.limits || !usage?.used || !usage?.percentages) return;
  const modelLabel = currentModelLabel();
  rpmText.textContent = `${usage.used.rpm} / ${usage.limits.rpm} (${usage.percentages.rpm}%)`;
  tpmText.textContent = `${formatNumber(usage.used.tpm)} / ${formatNumber(usage.limits.tpm)} (${usage.percentages.tpm}%)`;
  rpdText.textContent = `${usage.used.rpd} / ${usage.limits.rpd} (${usage.percentages.rpd}%)`;
  rpmBar.style.width = `${usage.percentages.rpm}%`;
  tpmBar.style.width = `${usage.percentages.tpm}%`;
  rpdBar.style.width = `${usage.percentages.rpd}%`;
  quotaNote.textContent = `${modelLabel} の制限目安: RPM ${usage.limits.rpm} / TPM ${formatNumber(usage.limits.tpm)} / RPD ${usage.limits.rpd}${usage.reset?.rpmSeconds ? `。RPMは約${usage.reset.rpmSeconds}秒後に一部回復` : ""}`;
}

function currentModelLabel() {
  return geminiModel.selectedOptions[0]?.textContent || geminiModel.value || "Gemini";
}

async function refreshUsage() {
  try {
    const response = await fetch(`/api/usage?model=${encodeURIComponent(geminiModel.value.trim() || "gemini-2.5-flash")}`);
    if (!response.ok) return;
    renderUsage(await response.json());
  } catch {
    // Usage display should not block the main TSV workflow.
  }
}

function mergeEnrichment(enrichedCards) {
  const byIndex = new Map(enrichedCards.map(card => [card.index, card]));
  cards = cards.map((card, index) => {
    if (!card.selected) return card;
    const enriched = byIndex.get(index);
    if (!enriched) return { ...card, state: "未補完", error: "結果なし" };
    return {
      ...card,
      partOfSpeech: normalizePartOfSpeech(enriched.partOfSpeech || card.partOfSpeech),
      originalPartOfSpeech: card.originalPartOfSpeech || enriched.partOfSpeech || card.partOfSpeech,
      japanese: card.japanese,
      phonetic: enriched.phonetic || card.phonetic,
      definition: enriched.definition || card.definition,
      cefr: enriched.cefr || card.cefr,
      etymology: enriched.etymology || card.etymology,
      state: enriched.error ? "要確認" : "補完済み",
      error: enriched.error || ""
    };
  });
  applyDuplicateWarnings();
}

function updateProgress(done, total, label = "一括補完中") {
  const percent = total ? Math.round((done / total) * 100) : 0;
  progressPanel.classList.add("active");
  progressText.textContent = label;
  progressCount.textContent = `${done} / ${total}`;
  progressBar.style.width = `${percent}%`;
}

let progressTimer;
let progressStartedAt = 0;

function startIndeterminateProgress(total) {
  clearInterval(progressTimer);
  progressStartedAt = Date.now();
  progressPanel.classList.add("active");
  progressCount.textContent = `0 / ${total}`;
  progressBar.style.width = "8%";
  progressText.textContent = "Geminiに一括補完を依頼中";
  progressTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - progressStartedAt) / 1000);
    const width = Math.min(88, 8 + elapsed * 4);
    progressBar.style.width = `${width}%`;
    progressText.textContent = `Geminiに一括補完を依頼中（${elapsed}秒）`;
  }, 1000);
}

function stopIndeterminateProgress(done, total, label) {
  clearInterval(progressTimer);
  progressTimer = null;
  updateProgress(done, total, label);
}

function resetProgress() {
  clearInterval(progressTimer);
  progressTimer = null;
  progressText.textContent = "補完待機中";
  progressCount.textContent = "0 / 0";
  progressBar.style.width = "0%";
}

async function enrichAll() {
  if (!cards.length) loadRows();
  if (!cards.length) return;
  const selectedCards = cards.filter(card => card.selected);
  if (!selectedCards.length) {
    status.textContent = "出力対象の行を選択してください";
    showToast("出力対象の行を選択してください", "bad");
    return;
  }

  const apiKey = geminiKey.value.replace(/\s+/g, "");
  geminiKey.value = apiKey;
  if (!apiKey) {
    status.textContent = "Gemini APIキーを入力してください";
    showToast("Gemini APIキーを入力してください", "bad");
    return;
  }

  enrichBtn.disabled = true;
  status.textContent = "一括補完中";
  showToast("一括補完を開始しました", "ok");
  cards = cards.map(card => card.selected ? { ...card, state: "補完中", error: "" } : card);
  renderTable();

  try {
    startIndeterminateProgress(selectedCards.length);
    const response = await fetch("/api/enrich-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        apiKey,
        model: geminiModel.value.trim() || "gemini-2.5-flash",
        cards: selectedCards.map(({ id, state, error, ...card }) => card)
      })
    });

    const data = await readJsonResponse(response);
    if (!response.ok) throw new Error(normalizeErrorMessage(data.error || "補完できませんでした。"));
    mergeEnrichment(data.cards || []);
    renderUsage(data.usage);
    status.textContent = "一括補完済み";
    stopIndeterminateProgress(selectedCards.length, selectedCards.length, "一括補完完了");
    showToast("一括補完が完了しました", "ok");
  } catch (error) {
    const message = normalizeErrorMessage(`${error.name || "Error"}: ${error.message || "補完できませんでした。"}`);
    status.textContent = message;
    cards = cards.map(card => card.selected ? { ...card, state: "要確認", error: message } : card);
    stopIndeterminateProgress(0, selectedCards.length, "一括補完失敗");
    showToast("一括補完に失敗しました", "bad");
  } finally {
    enrichBtn.disabled = false;
    renderTable();
    saveSettings();
  }
}

function normalizeErrorMessage(message) {
  const text = String(message || "");
  if (text.includes("Gemini API returned 429") || text.includes('"code": 429') || text.includes("exceeded your current quota")) {
    return "Geminiのクォータ上限に達しています。このAPIキーでは今すぐ補完できません。時間を置く、別のGemini APIキーを使う、またはGoogle AI Studioの利用枠/課金設定を確認してください。";
  }
  if (text.includes("Gemini API returned 503") || text.includes('"code": 503') || text.includes("high demand")) {
    return "選択中のGeminiモデルが混雑しています。少し待って再実行するか、Gemini 2.5 Flash Lite に切り替えてください。";
  }
  return text;
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`サーバーからJSONではない応答が返りました。Nodeサーバーが古いまま動いている可能性があります。HTTP ${response.status}: ${text.slice(0, 120)}`);
  }
}

async function copyTsv() {
  renderTsv();
  await navigator.clipboard.writeText(output.value);
  status.textContent = "コピー済み";
  showToast("TSVをコピーしました", "ok");
}

function downloadTsv() {
  renderTsv();
  const blob = new Blob([output.value], { type: "text/tab-separated-values;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "anki-pass-tan.tsv";
  link.click();
  URL.revokeObjectURL(url);
  showToast("TSVをダウンロードしました", "ok");
}

function clearAll() {
  cards = [];
  bulkInput.value = "";
  output.value = "";
  status.textContent = "入力待ち";
  resetProgress();
  renderTable();
  updateDupeSummary();
  showToast("入力をクリアしました", "ok");
}

function updateInputModeUi() {
  const ocrMode = currentInputMode() === "ocr";
  ocrFrequency.disabled = !ocrMode;
  ocrFrequencyLabel.classList.toggle("hidden", !ocrMode);
  ocrPartOfSpeechBlocks.classList.toggle("hidden", !ocrMode);
  ocrPartOfSpeechBlocksInput.disabled = !ocrMode;
  inputHint.textContent = ocrMode
    ? "OCR列順: 覚えたい単語 / 空欄つきの文 / 日本語訳 / パス単備考。でる度は上の入力欄、品詞は品詞ブロックまたは処理結果の行ごとの欄で設定します。"
    : "Numbers列順: 覚えたい単語 / 空欄つきの文 / 日本語訳 / パス単備考 / でる度 / 品詞。";
  bulkInput.placeholder = ocrMode
    ? "underestimate\tThe president had clearly (        ) the extent of hostility voters felt about his policies.\tを過小評価する（⇔ overestimate）\tunderestimation（名）"
    : "覚えたい単語\t空欄つきの文\t日本語訳\tパス単備考\tでる度\t品詞\ndetention\tStudents may receive (     ) for being late.\t拘留\t校則違反の罰\tA\tnoun";
}

async function loadExistingNotesFile() {
  const file = existingNotesFile.files?.[0];
  if (!file) return;
  const text = await file.text();
  existingWords = parseExistingNotes(text);
  saveExistingWords(file.name);
  applyDuplicateWarnings();
  renderTable();
  updateDupeSummary();
  showToast(`既存ノート ${existingWords.size}件を読み込みました`, "ok");
}

function saveExistingWords(fileName = "") {
  localStorage.setItem(existingWordsStorageKey, JSON.stringify([...existingWords.entries()]));
  localStorage.setItem(existingWordsMetaStorageKey, JSON.stringify({
    fileName,
    savedAt: new Date().toISOString()
  }));
}

function loadExistingWords() {
  try {
    const entries = JSON.parse(localStorage.getItem(existingWordsStorageKey) || "[]");
    if (Array.isArray(entries)) {
      existingWords = new Map(entries);
      applyDuplicateWarnings();
    }
  } catch {
    existingWords = new Map();
  }
}

function readExistingWordsMeta() {
  try {
    return JSON.parse(localStorage.getItem(existingWordsMetaStorageKey) || "null");
  } catch {
    return null;
  }
}

function rebuildExistingWordsForCaseMode() {
  if (!existingWords.size) return;
  const rebuilt = new Map();
  for (const original of existingWords.values()) {
    const key = normalizeDuplicateKey(original);
    if (key && !rebuilt.has(key)) {
      rebuilt.set(key, original);
    }
  }
  existingWords = rebuilt;
  saveExistingWords(readExistingWordsMeta()?.fileName || "");
}

function saveSettings() {
  localStorage.setItem("ankiTsvGeminiModel", geminiModel.value.trim() || "gemini-2.5-flash");
  localStorage.setItem("ankiTsvRememberKey", rememberKey.checked ? "yes" : "no");
  if (rememberKey.checked) {
    localStorage.setItem("ankiTsvGeminiKey", geminiKey.value.trim());
  } else {
    localStorage.removeItem("ankiTsvGeminiKey");
  }
}

function loadSettings() {
  const savedModel = localStorage.getItem("ankiTsvGeminiModel") || "gemini-2.5-flash";
  const modelValues = [...geminiModel.options].map(option => option.value);
  geminiModel.value = modelValues.includes(savedModel) ? savedModel : "gemini-2.5-flash";
  rememberKey.checked = localStorage.getItem("ankiTsvRememberKey") === "yes";
  if (rememberKey.checked) {
    geminiKey.value = (localStorage.getItem("ankiTsvGeminiKey") || "").replace(/\s+/g, "");
  }
}

bulkInput.addEventListener("input", loadRows);
knownWordsInput.addEventListener("input", () => {
  knownWords = parseKnownWords(knownWordsInput.value);
  applyKnownWordSelection();
  renderTable();
  updateDupeSummary();
});
inputModeRadios.forEach(input => input.addEventListener("change", () => {
  updateInputModeUi();
  loadRows();
}));
ocrFrequency.addEventListener("input", loadRows);
ocrPartOfSpeechBlocksInput.addEventListener("input", loadRows);
existingNotesFile.addEventListener("change", loadExistingNotesFile);
caseSensitiveDupes.addEventListener("change", () => {
  if (existingNotesFile.files?.[0]) {
    loadExistingNotesFile();
  } else {
    rebuildExistingWordsForCaseMode();
    applyDuplicateWarnings();
    renderTable();
    updateDupeSummary();
  }
});
enrichBtn.addEventListener("click", enrichAll);
copyBtn.addEventListener("click", copyTsv);
downloadBtn.addEventListener("click", downloadTsv);
clearBtn.addEventListener("click", clearAll);
rememberKey.addEventListener("change", saveSettings);
geminiModel.addEventListener("change", () => {
  saveSettings();
  refreshUsage();
});

loadSettings();
loadExistingWords();
updateInputModeUi();
renderTable();
updateDupeSummary();
refreshUsage();
setInterval(refreshUsage, 15_000);
