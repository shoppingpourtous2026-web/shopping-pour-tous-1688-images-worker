import {
  deleteProductImage,
  getAutomationState,
  getProductImages,
  getProductVariants,
  listRecentProducts,
  saveAutomationState,
  setVariantImage,
  updateProductImage,
  uploadProductImage
} from "./bigcommerce-images.js";
import { analyseImage, editImage } from "./cloudflare-image-cleaner.js";
import { imageKey, normaliseTitle, prepareCapture } from "./normalise.js";

const defaults = {
  analyseImage,
  deleteProductImage,
  editImage,
  getAutomationState,
  getProductImages,
  getProductVariants,
  listRecentProducts,
  saveAutomationState,
  setVariantImage,
  updateProductImage,
  uploadProductImage
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function findProduct(capture, env, deps) {
  const schedule = [0, 2_000, 4_000, 7_000, 12_000];
  for (const delay of schedule) {
    if (delay) await wait(delay);
    const product = selectCaptureProduct(capture, await deps.listRecentProducts(env, 100));
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
  const [images, variants, previous] = await Promise.all([
    deps.getProductImages(productId, env),
    deps.getProductVariants(productId, env),
    deps.getAutomationState(productId, env)
  ]);
  const signature = imageSignature(images, variants);
  if (previous?.status === "completed" && previous?.signature === signature &&
    String(previous?.supplierProductId || "") === capture.supplierProductId) {
    return { matched: true, productId, alreadyProcessed: true, ...previous.summary };
  }

  const maxImages = Math.min(20, Math.max(1, Number(env?.SPT_1688_MAX_IMAGES) || 12));
  const candidates = createCandidates(images, variants, maxImages);
  const analysed = [];
  for (const candidate of candidates) {
    try {
      const plan = await deps.analyseImage(candidate.url, product.name, env);
      analysed.push({ ...candidate, plan, status: plan.action === "keep" ? "kept" : "planned" });
    } catch (error) {
      analysed.push({ ...candidate, status: "analysis_failed", error: String(error?.message || error) });
    }
  }

  const imageById = new Map(images.map(image => [Number(image.id), image]));
  const kept = analysed.find(item => item.plan?.action === "keep" && item.imageId);
  let fallback = kept ? { image: imageById.get(kept.imageId), url: bestImageUrl(imageById.get(kept.imageId)) } : null;
  let activeGalleryCount = images.length;
  let replaced = 0;
  let deleted = 0;
  let variantsUpdated = 0;
  let failed = analysed.filter(item => item.status === "analysis_failed").length;

  for (const item of analysed.filter(candidate => ["remove_text", "translate"].includes(candidate.plan?.action))) {
    try {
      const cleaned = await deps.editImage(item.url, item.plan, product.name, env);
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
      replaced += 1;
    } catch (error) {
      item.status = "edit_failed_original_preserved";
      item.error = String(error?.message || error);
      failed += 1;
    }
  }

  for (const item of analysed.filter(candidate => candidate.plan?.action === "reject")) {
    try {
      if (!fallback?.url || activeGalleryCount <= 1) {
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
    } catch (error) {
      item.status = "reject_failed_original_preserved";
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
    preservedForSafety: analysed.filter(item => item.status === "rejected_but_preserved_for_safety").length
  };
  let finalSignature = signature;
  if (replaced || deleted || variantsUpdated) {
    try {
      const [finalImages, finalVariants] = await Promise.all([
        deps.getProductImages(productId, env),
        deps.getProductVariants(productId, env)
      ]);
      finalSignature = imageSignature(finalImages, finalVariants);
    } catch (_) {
      // Le traitement reste valable. Une nouvelle exécution prudente sera autorisée
      // si BigCommerce n'a pas encore rendu les nouvelles images disponibles.
    }
  }
  const state = {
    version: 1,
    status: failed ? "completed_with_warnings" : "completed",
    productId,
    sourceTitle: capture.sourceTitle,
    supplierProductId: capture.supplierProductId,
    signature: finalSignature,
    processedAt: new Date().toISOString(),
    summary,
    images: analysed.map(safePlanSummary)
  };
  await deps.saveAutomationState(productId, state, env);
  return { matched: true, productId, sourceTitle: capture.sourceTitle, ...summary };
}
