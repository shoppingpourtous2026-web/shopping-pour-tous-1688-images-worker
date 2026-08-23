const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u;
const TOKEN_RE = /__SPT_(?:TAG|VALUE)_[A-Z]+__/g;
const UNSAFE_HTML_RE = /<(?:script|style|iframe|object|embed|form|input|button|meta|link)\b|\son[a-z]+\s*=|javascript\s*:/iu;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const EMOJI_SEQUENCE_RE = /[\p{Extended_Pictographic}\uFE0F\u200D]+/gu;

const englishWords = new Set([
  "a", "an", "and", "are", "as", "available", "color", "colour", "design", "description",
  "drain", "easy", "faucet", "feature", "features", "for", "from", "high", "includes", "item",
  "launch", "made", "material", "note", "of", "origin", "package", "pad", "pattern", "please",
  "product", "quality", "quantity", "size", "solid", "specification", "suitable", "the", "this",
  "time", "to", "type", "upgraded", "use", "washbasin", "with", "without", "you", "your"
]);

const frenchWords = new Set([
  "avec", "caractéristique", "caractéristiques", "ce", "cette", "comprend", "conception", "convient",
  "couleur", "dans", "de", "des", "description", "du", "et", "facile", "fabriqué", "haute", "la",
  "le", "les", "matière", "pour", "produit", "qualité", "quantité", "remarque", "sans", "spécification",
  "taille", "type", "un", "une", "utilisation", "votre"
]);

const visibleText = html => String(html || "")
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/\s+/g, " ")
  .trim();

const addProfessionalEmoji = html => {
  const value = String(html || "");
  if (!value) return value;
  const cleaned = value.replace(EMOJI_SEQUENCE_RE, "").replace(/ {2,}/g, " ");
  const styled = cleaned.replace(
    /(<(?:p|h[1-6]|li|div)\b[^>]*>)(\s*)/i,
    "$1$2✨ "
  );
  return styled === cleaned ? `✨ ${cleaned}` : styled;
};

const languageSignals = value => {
  const text = visibleText(value).toLocaleLowerCase("fr");
  const words = text.match(/\p{L}+/gu) || [];
  return {
    text,
    words,
    cjk: CJK_RE.test(text),
    english: words.filter(word => englishWords.has(word)).length,
    french: words.filter(word => frenchWords.has(word)).length
  };
};

export function descriptionNeedsTranslation(html) {
  const signals = languageSignals(html);
  if (!signals.text) return false;
  if (signals.cjk) return true;
  if (signals.french >= 2 && signals.french >= signals.english) return false;
  if (signals.english >= 2 && signals.english > signals.french) return true;
  return signals.words.length >= 8 && signals.french < 2;
}

const alphaIndex = number => {
  let value = Number(number) + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result.padStart(4, "A");
};

const protectDescription = html => {
  const originals = new Map();
  let tagIndex = 0;
  let valueIndex = 0;
  const token = (kind, value) => {
    const index = kind === "TAG" ? tagIndex++ : valueIndex++;
    const key = `__SPT_${kind}_${alphaIndex(index)}__`;
    originals.set(key, value);
    return key;
  };
  let protectedText = String(html).replace(/<!--[\s\S]*?-->|<[^>]+>/g, value => token("TAG", value));
  const protect = regex => {
    protectedText = protectedText.replace(regex, value => token("VALUE", value));
  };
  protect(/https?:\/\/[^\s<>'"]+/giu);
  protect(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gu);
  protect(/\b\d+(?:[.,]\d+)?(?:\s*[×xX]\s*\d+(?:[.,]\d+)?){0,2}(?:\s*(?:mm|cm|km|mg|kg|ml|cl|hz|mah|v|w|g|m|l|°c|%|pcs?|pièces?))?\b/giu);
  protect(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{3,}\b/gu);
  return {
    protectedText,
    originals,
    expectedTokens: protectedText.match(TOKEN_RE) || []
  };
};

const translatedTextFrom = result => {
  const value = typeof result === "string"
    ? result
    : result?.response || result?.answer || result?.result?.response || result?.result?.answer || result?.text;
  let text = String(value || "").trim();
  const fenced = text.match(/^```(?:html|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) text = fenced[1].trim();
  if (!text) throw new Error("description_translation_empty");
  return text;
};

const restoreAndValidate = (translated, protectedDescription, originalHtml) => {
  const actualTokens = translated.match(TOKEN_RE) || [];
  if (actualTokens.length !== protectedDescription.expectedTokens.length ||
    actualTokens.some((value, index) => value !== protectedDescription.expectedTokens[index])) {
    throw new Error("description_translation_placeholders_changed");
  }
  let restored = translated;
  for (const [key, value] of protectedDescription.originals) {
    const count = restored.split(key).length - 1;
    if (count !== 1) throw new Error("description_translation_placeholder_invalid");
    restored = restored.replace(key, value);
  }
  if (TOKEN_RE.test(restored)) throw new Error("description_translation_placeholder_remaining");
  const before = languageSignals(originalHtml);
  const after = languageSignals(restored);
  if (!after.text || CJK_RE.test(after.text)) throw new Error("description_translation_not_french");
  const ratio = after.text.length / Math.max(1, before.text.length);
  if (ratio < 0.4 || ratio > 2.8) throw new Error("description_translation_length_invalid");
  if (after.text === before.text && descriptionNeedsTranslation(originalHtml)) {
    throw new Error("description_translation_unchanged");
  }
  if (after.french < 1 && after.words.length >= 8) throw new Error("description_translation_language_unverified");
  if (after.english >= 3 && after.english > after.french / 2) {
    throw new Error("description_translation_still_contains_english");
  }
  return restored;
};

export async function translateDescriptionToFrench(html, env) {
  const originalHtml = String(html || "").trim();
  if (!originalHtml) return { changed: false, html: originalHtml, reason: "empty" };
  if (!descriptionNeedsTranslation(originalHtml)) {
    const styled = addProfessionalEmoji(originalHtml);
    return {
      changed: styled !== originalHtml,
      html: styled,
      reason: styled !== originalHtml ? "french_styled_with_emoji" : "already_french_or_neutral"
    };
  }
  if (originalHtml.length > 45_000) throw new Error("description_too_large_to_translate_safely");
  if (UNSAFE_HTML_RE.test(originalHtml)) throw new Error("description_html_unsafe_original_preserved");
  if (!env?.AI?.run) throw new Error("cloudflare_ai_binding_missing");

  const protectedDescription = protectDescription(originalHtml);
  const prompt = [
    "Traduis littéralement en français professionnel le texte de cette description produit 1688.",
    "Le texte source peut être en anglais, en chinois ou mélanger plusieurs langues.",
    "N'ajoute, ne supprime et n'invente aucune information, caractéristique, promesse ou avantage.",
    "Tous les marqueurs __SPT_...__ représentent des balises HTML ou des valeurs factuelles protégées.",
    "Recopie chaque marqueur exactement une fois, sans le modifier, et conserve leur ordre.",
    "Ne traduis pas les noms de marque ni les références de modèle.",
    "Ajoute de 1 à 4 émojis sobres et pertinents au début des rubriques ou phrases importantes, sans remplacer de mot et sans ajouter de promesse commerciale.",
    "N'utilise jamais d'émoji au milieu d'une dimension, d'une quantité, d'une référence ou d'une valeur technique.",
    "Réponds uniquement avec la description traduite, sans explication et sans bloc Markdown.",
    "DESCRIPTION À TRADUIRE :",
    protectedDescription.protectedText
  ].join("\n");
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await env.AI.run(env.SPT_1688_TEXT_MODEL || "@cf/zai-org/glm-4.7-flash", {
      messages: [
        { role: "system", content: "Tu es un traducteur professionnel extrêmement fidèle pour une boutique belge francophone." },
        {
          role: "user",
          content: attempt === 0
            ? prompt
            : `${prompt}\nCONTRÔLE OBLIGATOIRE : aucun mot anglais ou chinois ne doit rester dans le résultat.`
        }
      ],
      temperature: 0,
      max_tokens: 8192,
      stream: false
    });
    try {
      const translated = translatedTextFrom(result);
      const restored = restoreAndValidate(translated, protectedDescription, originalHtml);
      const styled = addProfessionalEmoji(restored);
      return { changed: styled !== originalHtml, html: styled, reason: "translated_to_french_with_emoji" };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("description_translation_failed");
}
