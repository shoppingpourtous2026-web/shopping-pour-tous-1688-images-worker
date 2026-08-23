import {
  deleteProductImage,
  getAutomationState,
  getProductDetails,
  getProductImages,
  getProductVariants,
  listRecentProducts,
  saveAutomationState,
  setVariantImage,
  updateProductImage,
  updateProductDescription,
  uploadProductImage
} from "./bigcommerce-images.js";
import { analyseImage, editImage } from "./cloudflare-image-cleaner.js";
import { translateDescriptionToFrench } from "./cloudflare-description-translator.js";
import { imageKey, normaliseTitle, prepareCapture } from "./normalise.js";

const defaults = {
  analyseImage,
  deleteProductImage,
  editImage,
  getAutomationState,
  getProductDetails,
  getProductImages,
  getProductVariants,
  listRecentProducts,
  saveAutomationState,
  setVariantImage,
  updateProductImage,
  updateProductDescription,
  translateDescriptionToFrench,
  uploadProductImage
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const automationStateVersion = 5;

export function selectCaptureProduct(capture, products) {
  const expected = normaliseTitle(capture?.sourceTitle || capture?.normalisedSourceTitle);
  const supplierId = String(capture?.supplierProductId || "").toLowerCase();
  const strongSupplierId = /^[a-z0-9_-]{8,120}$/.test(supplierId);
  const matches = new Map();
  for (const product of Array.isArray(products) ? products : []) {
    const titleMatches = normaliseTitle(product?.name) === expected;
    const skuMatches = strongSupplierId && String(product?.sku || "").toLowerCase().includes(supplierId);
    if (titleMatches || skuMatches) matches.set(Number(product.id), product);
  }
  if (matches.size > 1) throw new Error("capture_1688_ambiguous");
  return [...matches.values()][0] || null;
}

const titleTokens = value => new Set(
  normaliseTitle(value).split(" ").filter(token => token.length >= 3)
);

export function selectRecentCaptureProduct(capture, products) {
  const receivedAt = Date.parse(String(capture?.receivedAt || ""));
  if (!Number.isFinite(receivedAt)) return null;
  const sourceTokens = titleTokens(capture?.sourceTitle);
  if (sourceTokens.size < 3) return null;
  const ranked = [];
  for (const product of Array.isArray(products) ? products : []) {
    const createdAt = Date.parse(String(product?.date_created || ""));
    if (!Number.isFinite(createdAt) || Math.abs(createdAt - receivedAt) > 10 * 60_000) continue;
    const productTokens = titleTokens(product?.name);
    const shared = [...sourceTokens].filter(token => productTokens.has(token)).length;
    const score = shared / Math.max(1, Math.min(sourceTokens.size, productTokens.size));
    if (shared >= 2 && score >= 0.2) ranked.push({ product, score, shared });
  }
  ranked.sort((a, b) => b.score - a.score || b.shared - a.shared);
  if (!ranked.length) return null;
  if (ranked[1] && Math.abs(ranked[0].score - ranked[1].score) < 0.05) {
    throw new Error("capture_1688_recent_match_ambiguous");
  }
  return ranked[0].product;
}

async function findProduct(capture, env, deps) {
  const schedule = [0, 2_000, 4_000, 7_000, 12_000];
  for (const delay of schedule) {
    if (delay) await wait(delay);
    const products = await deps.listRecentProducts(env, 100);
    const product = selectCaptureProduct(capture, products) || selectRecentCaptureProduct(capture, products);
    if (product) return product;
  }
  return null;
}

const bestImageUrl = image => String(
  image?.url_zoom || image?.url_standard || image?.url_original || image?.image_url || ""
).trim();

const replacementUrl = image => String(
  image?.url_standard || image?.url_zoom || image?.url_original || image?.image_url || ""
).trim();

const imageSignature = (images, variants) => [
  ...images.map(image => `p:${Number(image?.id)}:${imageKey(bestImageUrl(image))}`),
  ...variants.map(variant => `v:${Number(variant?.id)}:${imageKey(variant?.image_url)}`)
].filter(Boolean).sort().join("|");

const textFingerprint = value => {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
};

const safePlanSummary = item => ({
  source: item.source,
  imageId: item.imageId || null,
  variantIds: item.variantIds,
  action: item.plan?.action || "error",
  confidence: item.plan?.confidence ?? null,
  textCoverage: item.plan?.textCoverage ?? null,
  status: item.status,
  error: item.error || null
});

const preservesProductIdentity = (before, after) => {
  if (!before || !after) return false;
  if (before.productCount && after.productCount && before.productCount !== after.productCount) return false;
  const beforeColours = new Set(Array.isArray(before.dominantColors) ? before.dominantColors : []);
  const afterColours = new Set(Array.isArray(after.dominantColors) ? after.dominantColors : []);
  if (beforeColours.size && afterColours.size && ![...beforeColours].some(colour => afterColours.has(colour))) return false;
  return true;
};

const createCandidates = (images, variants, maxImages) => {
  const byKey = new Map();
  const add = (url, patch) => {
    const key = imageKey(url);
    if (!key) return;
    if (!byKey.has(key)) byKey.set(key, { key, url, source: patch.source, imageId: null, variantIds: [] });
    const candidate = byKey.get(key);
    if (patch.imageId) candidate.imageId = patch.imageId;
    if (patch.image) candidate.image = patch.image;
    if (patch.variantId && !candidate.variantIds.includes(patch.variantId)) candidate.variantIds.push(patch.variantId);
    if (patch.source === "gallery") candidate.source = "gallery";
  };
  for (const image of images) add(bestImageUrl(image), { source: "gallery", imageId: Number(image.id), image });
  for (const variant of variants) add(String(variant?.image_url || ""), { source: "variant", variantId: Number(variant.id) });
  return [...byKey.values()].slice(0, maxImages);
};

export async function automate1688Images(rawCapture, env, injected = {}) {
  const deps = { ...defaults, ...injected };
  const capture = rawCapture?.normalisedSourceTitle ? rawCapture : prepareCapture(rawCapture);
  const product = await findProduct(capture, env, deps);
  if (!product) return { matched: false, sourceTitle: capture.sourceTitle };

  const productId = Number(product.id);
  const [images, variants, previous, productDetails] = await Promise.all([
    deps.getProductImages(productId, env),
    deps.getProductVariants(productId, env),
    deps.getAutomationState(productId, env),
    deps.getProductDetails(productId, env)
  ]);
  const signature = imageSignature(images, variants);
  const originalDescription = String(productDetails?.description || "");
  const originalDescriptionFingerprint = textFingerprint(originalDescription);
  if (Number(previous?.version) >= automationStateVersion && previous?.status === "completed" && previous?.signature === signature &&
    previous?.descriptionFingerprint === originalDescriptionFingerprint &&
    String(previous?.supplierProductId || "") === capture.supplierProductId) {
    return { matched: true, productId, alreadyProcessed: true, ...previous.summary };
  }

  let finalDescription = originalDescription;
  let descriptionTranslated = 0;
  let descriptionPreserved = 0;
  let descriptionSkipped = 0;
  let descriptionFailed = 0;
  let descriptionStatus = "skipped";
  let descriptionError = null;
  try {
    const translation = await deps.translateDescriptionToFrench(originalDescription, env);
    if (translation.changed) {
      await deps.updateProductDescription(productId, translation.html, env);
      finalDescription = translation.html;
      descriptionTranslated = 1;
      descriptionStatus = translation.reason || "translated_to_french";
    } else {
      descriptionSkipped = 1;
      descriptionStatus = translation.reason || "already_french_or_neutral";
    }
  } catch (error) {
    descriptionPreserved = 1;
    descriptionFailed = 1;
    descriptionStatus = "translation_failed_original_preserved";
    descriptionError = String(error?.message || error).slice(0, 200);
  }

  const maxImages = Math.min(20, Math.max(1, Number(env?.SPT_1688_MAX_IMAGES) || 20));
  const batchSize = Math.min(6, Math.max(1, Number(env?.SPT_1688_BATCH_SIZE) || 4));
  const processedKeys = new Set(
    Number(previous?.version) >= automationStateVersion && Array.isArray(previous?.progress?.processedKeys)
      ? previous.progress.processedKeys.map(value => String(value || "")).filter(Boolean)
      : []
  );
  const allCandidates = createCandidates(images, variants, maxImages);
  const candidates = allCandidates.filter(candidate => !processedKeys.has(candidate.key)).slice(0, batchSize);
  const analysed = [];
  for (const candidate of candidates) {
    try {
      const plan = await deps.analyseImage(candidate.url, product.name, env);
      analysed.push({ ...candidate, plan, status: plan.action === "keep" ? "kept" : "planned" });
      if (plan.action === "keep") processedKeys.add(candidate.key);
    } catch (error) {
      analysed.push({ ...candidate, status: "analysis_failed", error: String(error?.message || error) });
    }
  }

  const imageById = new Map(images.map(image => [Number(image.id), image]));
  const existingClean = images.find(image => processedKeys.has(imageKey(bestImageUrl(image))));
  const kept = analysed.find(item => item.plan?.action === "keep" && item.imageId);
  let fallback = existingClean
    ? { image: existingClean, url: bestImageUrl(existingClean) }
    : kept ? { image: imageById.get(kept.imageId), url: bestImageUrl(imageById.get(kept.imageId)) } : null;
  let activeGalleryCount = images.length;
  let replaced = 0;
  let deleted = 0;
  let variantsUpdated = 0;
  let failed = analysed.filter(item => item.status === "analysis_failed").length + descriptionFailed;

  for (const item of analysed.filter(candidate => ["remove_text", "translate"].includes(candidate.plan?.action))) {
    try {
      const editSourceUrl = String(
        item.image?.url_thumbnail || item.image?.url_standard || item.url
      ).trim();
      const cleaned = await deps.editImage(editSourceUrl, item.plan, product.name, env);
      const original = item.imageId ? imageById.get(item.imageId) : null;
      const created = await deps.uploadProductImage(productId, {
        ...cleaned,
        description: item.plan.action === "translate"
          ? "Image 1688 traduite en français"
          : "Image 1688 sans écriture chinoise",
        sortOrder: Number(original?.sort_order || 0),
        isThumbnail: original?.is_thumbnail === true
      }, env);
      const cleanUrl = replacementUrl(created);
      if (!cleanUrl) throw new Error("clean_image_url_missing");
      const verification = await deps.analyseImage(cleanUrl, product.name, env);
      if (verification.containsCjk === true || verification.action !== "keep" ||
        !preservesProductIdentity(item.plan, verification)) {
        await deps.deleteProductImage(productId, Number(created.id), env);
        throw new Error("clean_image_verification_failed");
      }
      activeGalleryCount += 1;
      for (const variantId of item.variantIds) {
        await deps.setVariantImage(productId, variantId, cleanUrl, env);
        variantsUpdated += 1;
      }
      if (item.imageId) {
        await deps.deleteProductImage(productId, item.imageId, env);
        activeGalleryCount -= 1;
        deleted += 1;
      }
      fallback ||= { image: created, url: cleanUrl };
      item.status = "replaced";
      item.replacementImageId = Number(created.id) || null;
      processedKeys.add(item.key);
      processedKeys.add(imageKey(cleanUrl));
      replaced += 1;
    } catch (error) {
      if (fallback?.url) {
        try {
          for (const variantId of item.variantIds) {
            await deps.setVariantImage(productId, variantId, fallback.url, env);
            variantsUpdated += 1;
          }
          if (item.imageId && activeGalleryCount > 1) {
            const original = imageById.get(item.imageId);
            if (original?.is_thumbnail === true && Number(fallback.image?.id)) {
              await deps.updateProductImage(productId, Number(fallback.image.id), { is_thumbnail: true }, env);
            }
            await deps.deleteProductImage(productId, item.imageId, env);
            activeGalleryCount -= 1;
            deleted += 1;
            item.status = "edit_failed_removed_using_clean_fallback";
            processedKeys.add(item.key);
          } else if (!item.imageId && item.variantIds.length) {
            item.status = "edit_failed_variant_relinked_to_clean_fallback";
            processedKeys.add(item.key);
          } else {
            item.status = "edit_failed_original_preserved_for_safety";
            item.error = String(error?.message || error);
            failed += 1;
            continue;
          }
          item.error = String(error?.message || error);
          continue;
        } catch (relinkError) {
          item.error = `${String(error?.message || error)}; ${String(relinkError?.message || relinkError)}`;
        }
      }
      item.status = "edit_failed_original_preserved";
      item.error ||= String(error?.message || error);
      failed += 1;
    }
  }

  for (const item of analysed.filter(candidate => candidate.plan?.action === "reject")) {
    try {
      if (!fallback?.url || (item.imageId && activeGalleryCount <= 1)) {
        item.status = "rejected_but_preserved_for_safety";
        continue;
      }
      for (const variantId of item.variantIds) {
        await deps.setVariantImage(productId, variantId, fallback.url, env);
        variantsUpdated += 1;
      }
      if (item.imageId) {
        const original = imageById.get(item.imageId);
        if (original?.is_thumbnail === true && Number(fallback.image?.id)) {
          await deps.updateProductImage(productId, Number(fallback.image.id), { is_thumbnail: true }, env);
        }
        await deps.deleteProductImage(productId, item.imageId, env);
        activeGalleryCount -= 1;
        deleted += 1;
      }
      item.status = "rejected_and_removed";
      processedKeys.add(item.key);
    } catch (error) {
      item.status = "reject_failed_original_preserved";
      item.error = String(error?.message || error);
      failed += 1;
    }
  }

  for (const item of analysed.filter(candidate =>
    !candidate.imageId && candidate.plan?.action === "keep" && candidate.variantIds.length
  )) {
    if (!fallback?.url) continue;
    try {
      for (const variantId of item.variantIds) {
        await deps.setVariantImage(productId, variantId, fallback.url, env);
        variantsUpdated += 1;
      }
      item.status = "variant_relinked_to_verified_clean_gallery";
      processedKeys.add(item.key);
    } catch (error) {
      item.status = "variant_clean_fallback_failed_original_preserved";
      item.error = String(error?.message || error);
      failed += 1;
    }
  }

  const summary = {
    analysed: analysed.length,
    kept: analysed.filter(item => item.status === "kept").length,
    replaced,
    deleted,
    variantsUpdated,
    failed,
    preservedForSafety: analysed.filter(item => item.status === "rejected_but_preserved_for_safety").length,
    descriptionTranslated,
    descriptionPreserved,
    descriptionSkipped
  };
  let finalSignature = signature;
  let remainingCandidates = Math.max(0, allCandidates.length - processedKeys.size);
  try {
    const [finalImages, finalVariants] = await Promise.all([
      deps.getProductImages(productId, env),
      deps.getProductVariants(productId, env)
    ]);
    finalSignature = imageSignature(finalImages, finalVariants);
    remainingCandidates = createCandidates(finalImages, finalVariants, maxImages)
      .filter(candidate => !processedKeys.has(candidate.key)).length;
  } catch (_) {
    // Le lot reste valable. Le prochain passage reprendra les éléments non marqués.
  }
  summary.remainingCandidates = remainingCandidates;
  const state = {
    version: automationStateVersion,
    status: remainingCandidates > 0 ? "in_progress" : failed ? "completed_with_warnings" : "completed",
    productId,
    sourceTitle: capture.sourceTitle,
    supplierProductId: capture.supplierProductId,
    signature: finalSignature,
    descriptionFingerprint: textFingerprint(finalDescription),
    processedAt: new Date().toISOString(),
    summary,
    description: {
      status: descriptionStatus,
      error: descriptionError
    },
    progress: {
      processedKeys: [...processedKeys].slice(-200),
      remainingCandidates
    },
    images: analysed.map(safePlanSummary)
  };
  await deps.saveAutomationState(productId, state, env);
  return {
    matched: true,
    productId,
    sourceTitle: capture.sourceTitle,
    hasMore: remainingCandidates > 0,
    ...summary
  };
}

export async function continuePending1688Images(env, injected = {}) {
  const deps = { ...defaults, ...injected };
  const products = await deps.listRecentProducts(env, 12);
  for (const product of products) {
    const state = await deps.getAutomationState(Number(product.id), env);
    if (Number(state?.version) < automationStateVersion || state?.status !== "in_progress") continue;
    return automate1688Images({
      confirm: "AUTOMATE_1688_IMAGES",
      marketplace: "1688",
      sourceTitle: String(product.name || state.sourceTitle || ""),
      supplierProductId: String(state.supplierProductId || ""),
      supplierProductUrl: ""
    }, env, deps);
  }
  return { continued: false };
}
