const parseJsonAnswer = value => {
  const text = String(value || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate) {
    const diagnostic = text.replace(/\s+/g, " ").slice(0, 280) || "empty";
    throw new Error(`cloudflare_analysis_unstructured:${diagnostic}`);
  }
  return JSON.parse(candidate);
};

const answerText = result => String(
  result?.answer || result?.response || result?.caption ||
  result?.result?.answer || result?.result?.response || result?.result?.caption || ""
).trim();

const runVisionQuery = async (image, question, env, maxTokens) => {
  let lastError = new Error("cloudflare_analysis_unstructured:empty");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await env.AI.run(env.SPT_1688_VISION_MODEL || "@cf/moondream/moondream3.1-9B-A2B", {
        task: "query",
        image,
        question,
        reasoning: true,
        temperature: 0,
        max_tokens: maxTokens,
        stream: false
      });
      const answer = answerText(result);
      if (answer) return answer;
      lastError = new Error("cloudflare_analysis_unstructured:empty");
    } catch (error) {
      lastError = error;
      if (!/8008|internal server error/i.test(String(error?.message || error))) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw lastError;
};

const cjkVerdict = value => {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const parsed = parseJsonAnswer(text);
    if (typeof parsed?.containsCjk === "boolean") return parsed.containsCjk;
  } catch (_) {
    // Le second contrôle accepte aussi une réponse très courte CJK/CLEAR.
  }
  if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u.test(text)) return true;
  const normalised = text.toLowerCase().replace(/[^a-zà-ÿ]+/g, " ").trim();
  if (/\b(clear|none|absent|no|non|aucun|false)\b/.test(normalised)) return false;
  if (/\b(cjk|chinese|chinois|japanese|japonais|korean|coréen|hanzi|kanji|hangul|yes|oui|present|présent|detected|détecté|true)\b/.test(normalised)) return true;
  return null;
};

export function normalisePlan(raw, minimumConfidence = 0.85) {
  const plan = raw && typeof raw === "object" ? raw : {};
  const containsCjk = plan.containsCjk === true;
  const textCoverage = Math.min(1, Math.max(0, Number(plan.textCoverage) || 0));
  const confidence = Math.min(1, Math.max(0, Number(plan.confidence) || 0));
  const allowed = new Set(["keep", "remove_text", "translate", "reject"]);
  let action = allowed.has(plan.action) ? plan.action : "reject";
  const essentialFrenchText = (Array.isArray(plan.essentialFrenchText) ? plan.essentialFrenchText : [])
    .map(value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 10);
  const colourSet = new Set([
    "black", "white", "grey", "red", "orange", "yellow", "green", "blue",
    "purple", "pink", "brown", "beige", "transparent", "multicolor"
  ]);
  const dominantColors = (Array.isArray(plan.dominantColors) ? plan.dominantColors : [])
    .map(value => String(value || "").toLowerCase().trim())
    .filter(value => colourSet.has(value))
    .slice(0, 5);
  const productCount = Number.isInteger(Number(plan.productCount)) && Number(plan.productCount) > 0
    ? Math.min(100, Number(plan.productCount))
    : null;
  if (!containsCjk) action = "keep";
  else if (textCoverage >= 0.42) action = "reject";
  else if (essentialFrenchText.length && action !== "reject") action = "translate";
  else if (action === "keep") action = "remove_text";
  if (containsCjk && confidence < minimumConfidence) action = "reject";
  return {
    containsCjk,
    textCoverage,
    action,
    confidence,
    essentialFrenchText,
    dominantColors,
    productCount,
    reason: String(plan.reason || "").replace(/\s+/g, " ").trim().slice(0, 300)
  };
}

export async function analyseImage(imageUrl, productTitle, env) {
  if (!env?.AI?.run) throw new Error("cloudflare_ai_binding_missing");
  const source = await downloadImage(referenceImageUrl(imageUrl));
  let binary = "";
  for (let offset = 0; offset < source.bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...source.bytes.subarray(offset, offset + 32_768));
  }
  const imageDataUri = `data:${source.mimeType};base64,${btoa(binary)}`;
  const question = [
    `Produit : ${String(productTitle || "").slice(0, 500)}.`,
    "Analyse cette image 1688 pour une boutique belge francophone.",
    "Réponds uniquement avec un objet JSON strict, sans markdown, utilisant exactement ces clés :",
    '{"containsCjk":boolean,"textCoverage":number,"action":"keep|remove_text|translate|reject","confidence":number,"essentialFrenchText":string[],"dominantColors":string[],"productCount":number|null,"reason":string}.',
    "containsCjk est vrai si du texte chinois, japonais ou coréen est visible.",
    "textCoverage est la proportion approximative de l'image couverte par ce texte, entre 0 et 1.",
    "keep si aucun texte CJK n'est visible.",
    "remove_text si le texte est publicitaire, décoratif, un slogan, une promotion ou une marque vendeur et que le produit restera clair après suppression.",
    "translate si le texte contient une information essentielle réellement visible, comme dimensions, matière, contenu du paquet ou instruction utile; essentialFrenchText contient seulement les traductions françaises exactes.",
    "reject si l'image est une affiche très chargée, un tableau complexe ou si le nettoyage risque de déformer le produit.",
    "dominantColors utilise seulement les mots anglais black, white, grey, red, orange, yellow, green, blue, purple, pink, brown, beige, transparent ou multicolor.",
    "productCount est le nombre d'articles produits clairement visibles, sans compter le décor ni les petits pictogrammes.",
    "N'invente aucune caractéristique."
  ].join(" ");
  let primaryPlan = null;
  let primaryError = null;
  try {
    const answer = await runVisionQuery(imageDataUri, question, env, 900);
    primaryPlan = normalisePlan(
      parseJsonAnswer(answer),
      Number(env.SPT_1688_MIN_CONFIDENCE) || 0.85
    );
  } catch (error) {
    primaryError = error;
  }
  if (primaryPlan?.containsCjk === true) return primaryPlan;

  const verificationQuestion = [
    "Inspecte attentivement toute cette image, y compris les grands titres, les étiquettes et le bas de l'image.",
    "Y a-t-il au moins un caractère chinois, japonais ou coréen visible ?",
    "Réponds par un seul mot : CJK si oui, CLEAR si non."
  ].join(" ");
  let verification;
  try {
    verification = cjkVerdict(await runVisionQuery(imageDataUri, verificationQuestion, env, 120));
  } catch (error) {
    if (!primaryPlan) throw primaryError || error;
    throw error;
  }
  if (verification === null) throw new Error("cloudflare_cjk_verification_unstructured");
  if (verification === false) {
    const transcriptionQuestion = [
      "Recopie exactement, sans traduire, tous les mots et caractères visibles dans cette image.",
      "Vérifie notamment le grand titre, les petites étiquettes et la bande du bas.",
      "S'il n'y a absolument aucun texte visible, réponds uniquement NONE."
    ].join(" ");
    const transcription = await runVisionQuery(imageDataUri, transcriptionQuestion, env, 240);
    const transcriptionVerdict = cjkVerdict(transcription);
    if (transcriptionVerdict === true) {
      verification = true;
    }
  }
  if (verification === false) {
    return primaryPlan || {
      containsCjk: false,
      textCoverage: 0,
      action: "keep",
      confidence: 0.95,
      essentialFrenchText: [],
      dominantColors: [],
      productCount: null,
      reason: "Second contrôle : aucun caractère CJK visible"
    };
  }
  return {
    ...(primaryPlan || {}),
    containsCjk: true,
    textCoverage: primaryPlan?.textCoverage || 0.12,
    action: "remove_text",
    confidence: Math.max(primaryPlan?.confidence || 0, 0.95),
    essentialFrenchText: primaryPlan?.essentialFrenchText || [],
    dominantColors: primaryPlan?.dominantColors || [],
    productCount: primaryPlan?.productCount || null,
    reason: "Second contrôle : caractères CJK détectés"
  };
}

const trustedSourceHost = hostname => {
  const host = String(hostname || "").toLowerCase();
  return /^cdn\d*\.bigcommerce\.com$/.test(host) || host.endsWith(".bigcommerce.com") ||
    host === "alicdn.com" || host.endsWith(".alicdn.com") ||
    host === "alibabausercontent.com" || host.endsWith(".alibabausercontent.com") ||
    host === "1688.com" || host.endsWith(".1688.com");
};

async function downloadImage(imageUrl, resizeForEditing = false) {
  let url = new URL(String(imageUrl));
  if (url.protocol !== "https:" || !trustedSourceHost(url.hostname)) throw new Error("image_source_not_allowed");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    let response;
    for (let redirect = 0; redirect <= 3; redirect += 1) {
      const options = { signal: controller.signal, redirect: "manual" };
      if (resizeForEditing) {
        options.cf = {
          image: {
            fit: "scale-down",
            width: 480,
            height: 480,
            format: "jpeg",
            quality: 92
          }
        };
      }
      response = await fetch(url.href, options);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("image_redirect_invalid");
      url = new URL(location, url);
      if (url.protocol !== "https:" || !trustedSourceHost(url.hostname)) throw new Error("image_source_not_allowed");
    }
    if (!response.ok) throw new Error(`image_download_${response.status}`);
    const type = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!type.startsWith("image/") || type === "image/svg+xml") throw new Error("image_type_invalid");
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > 8 * 1024 * 1024) throw new Error("image_too_large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) throw new Error("image_too_large");
    return { bytes, mimeType: type || "image/jpeg" };
  } finally {
    clearTimeout(timer);
  }
}

const referenceImageUrl = imageUrl => {
  const url = new URL(String(imageUrl));
  if (/^cdn\d*\.bigcommerce\.com$/i.test(url.hostname)) {
    url.pathname = url.pathname.replace(/\/stencil\/(?:original|\d+x\d+)\//i, "/stencil/500x500/");
  }
  return url.href;
};

const extensionFor = mimeType => ({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
}[mimeType] || "png");

const pngDimensions = bytes => {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

const jpegDimensions = bytes => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    const length = (bytes[offset + 2] << 8) + bytes[offset + 3];
    if (length < 2) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: (bytes[offset + 5] << 8) + bytes[offset + 6],
        width: (bytes[offset + 7] << 8) + bytes[offset + 8]
      };
    }
    offset += 2 + length;
  }
  return null;
};

const outputDimensions = source => {
  const raw = pngDimensions(source.bytes) || jpegDimensions(source.bytes) || { width: 768, height: 768 };
  const scale = 1024 / Math.max(raw.width, raw.height);
  const round = value => Math.min(1024, Math.max(256, Math.round(value / 32) * 32));
  return { width: round(raw.width * scale), height: round(raw.height * scale) };
};

const decodeBase64 = value => {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export async function editImage(imageUrl, plan, productTitle, env) {
  if (!env?.AI?.run) throw new Error("cloudflare_ai_binding_missing");
  const source = await downloadImage(referenceImageUrl(imageUrl), true);
  const referenceDimensions = pngDimensions(source.bytes) || jpegDimensions(source.bytes);
  if (!referenceDimensions || referenceDimensions.width >= 512 || referenceDimensions.height >= 512) {
    throw new Error("reference_image_must_be_under_512");
  }
  const dimensions = outputDimensions(source);
  const exactFrench = plan.essentialFrenchText?.length
    ? `Remplace uniquement les informations essentielles par ces libellés français exacts : ${plan.essentialFrenchText.map(text => `« ${text} »`).join(" ; ")}.`
    : "N'ajoute aucun texte de remplacement.";
  const prompt = [
    `Image 0 : photographie du produit « ${String(productTitle || "").slice(0, 300)} ».`,
    "Crée une copie professionnelle fidèle de l'image 0.",
    "Supprime toutes les écritures chinoises, japonaises ou coréennes visibles, les promotions et les logos du vendeur.",
    exactFrench,
    "Préserve strictement le produit réel : forme, couleur, quantité, texture, variante, proportions, cadrage et arrière-plan.",
    "N'invente aucun objet, avantage, matériau, prix, marque, logo, chiffre ou caractéristique.",
    "Le résultat ne doit contenir aucun caractère CJK."
  ].join(" ");
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("input_image_0", new File(
    [source.bytes],
    `source.${extensionFor(source.mimeType)}`,
    { type: source.mimeType }
  ));
  form.append("width", String(dimensions.width));
  form.append("height", String(dimensions.height));
  form.append("guidance", "4");
  const encoded = new Response(form);
  const result = await env.AI.run(env.SPT_1688_IMAGE_MODEL || "@cf/black-forest-labs/flux-2-klein-4b", {
    multipart: {
      body: encoded.body,
      contentType: encoded.headers.get("content-type")
    }
  });
  const bytes = decodeBase64(result?.image);
  if (!bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) throw new Error("clean_image_size_invalid");
  return { bytes, mimeType: "image/png", filename: "image-1688-sans-chinois.png" };
}
