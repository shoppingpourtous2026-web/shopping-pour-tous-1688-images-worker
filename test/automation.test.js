import test from "node:test";
import assert from "node:assert/strict";
import { automate1688Images, selectCaptureProduct, selectRecentCaptureProduct } from "../src/automation.js";

const capture = {
  version: 1,
  sourceTitle: "Produit test 1688 très utile",
  normalisedSourceTitle: "produit test 1688 tres utile",
  supplierProductId: "123456789",
  marketplace: "1688"
};

const noDescriptionChange = {
  getProductDetails: async () => ({ description: "" }),
  translateDescriptionToFrench: async html => ({ changed: false, html, reason: "empty" }),
  updateProductDescription: async () => { throw new Error("description_update_not_expected"); }
};

test("selectCaptureProduct exige une correspondance unique", () => {
  assert.equal(selectCaptureProduct(capture, [{ id: 7, name: "Produit test 1688 très utile", sku: "" }]).id, 7);
  assert.equal(selectCaptureProduct(capture, [{ id: 8, name: "Autre titre", sku: "DS-123456789-BE" }]).id, 8);
  assert.throws(() => selectCaptureProduct(capture, [
    { id: 7, name: "Produit test 1688 très utile", sku: "" },
    { id: 8, name: "Autre titre", sku: "DS-123456789-BE" }
  ]), /ambiguous/);
});

test("le rapprochement récent accepte prudemment un titre partiellement traduit par DSers", () => {
  const receivedAt = "2026-08-23T19:00:00.000Z";
  const recentCapture = {
    ...capture,
    sourceTitle: "Cartoon toothbrush storage rack wall mounted holder",
    receivedAt
  };
  const result = selectRecentCaptureProduct(recentCapture, [
    {
      id: 183,
      name: "Cartoon brosse à dents Rack de stockage mural",
      date_created: "2026-08-23T19:01:00.000Z"
    },
    {
      id: 182,
      name: "Xixi Food Toy Pineapple Bun Powder Puff",
      date_created: "2026-08-23T18:59:00.000Z"
    }
  ]);
  assert.equal(result.id, 183);
});

test("une image chinoise est remplacée puis reliée à la variante avant suppression", async () => {
  const calls = [];
  let editedUrl = "";
  const images = [
    { id: 10, url_standard: "https://cdn11.bigcommerce.com/a/clean.jpg", sort_order: 0, is_thumbnail: true },
    {
      id: 11,
      url_standard: "https://cdn11.bigcommerce.com/a/chinese.jpg",
      url_thumbnail: "https://cdn11.bigcommerce.com/a/chinese-small.jpg",
      sort_order: 1,
      is_thumbnail: false
    }
  ];
  const result = await automate1688Images(capture, { SPT_1688_MAX_IMAGES: "12" }, {
    ...noDescriptionChange,
    listRecentProducts: async () => [{ id: 99, name: capture.sourceTitle, sku: "" }],
    getProductImages: async () => images,
    getProductVariants: async () => [{ id: 501, image_url: images[1].url_standard }],
    getAutomationState: async () => null,
    analyseImage: async url => url.includes("clean")
      ? { action: "keep", containsCjk: false, confidence: 1, textCoverage: 0, essentialFrenchText: [] }
      : { action: "remove_text", containsCjk: true, confidence: 0.98, textCoverage: 0.1, essentialFrenchText: [] },
    editImage: async url => {
      editedUrl = url;
      return { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", filename: "clean.png" };
    },
    uploadProductImage: async () => ({ id: 12, url_standard: "https://cdn11.bigcommerce.com/a/clean-replacement.png" }),
    setVariantImage: async (...args) => calls.push(["variant", ...args.slice(0, 3)]),
    deleteProductImage: async (...args) => calls.push(["delete", ...args.slice(0, 2)]),
    updateProductImage: async () => undefined,
    saveAutomationState: async (_id, state) => calls.push(["state", state])
  });
  assert.equal(result.replaced, 1);
  assert.equal(result.variantsUpdated, 1);
  assert.equal(editedUrl, "https://cdn11.bigcommerce.com/a/chinese-small.jpg");
  assert.deepEqual(calls[0], ["variant", 99, 501, "https://cdn11.bigcommerce.com/a/clean-replacement.png"]);
  assert.deepEqual(calls[1], ["delete", 99, 11]);
});

test("un échec de retouche conserve toujours l'original", async () => {
  const calls = [];
  const result = await automate1688Images(capture, {}, {
    ...noDescriptionChange,
    listRecentProducts: async () => [{ id: 99, name: capture.sourceTitle, sku: "" }],
    getProductImages: async () => [{ id: 11, url_standard: "https://cdn11.bigcommerce.com/a/chinese.jpg", is_thumbnail: true }],
    getProductVariants: async () => [],
    getAutomationState: async () => null,
    analyseImage: async () => ({ action: "remove_text", containsCjk: true, confidence: 0.98, textCoverage: 0.1, essentialFrenchText: [] }),
    editImage: async () => { throw new Error("retouche_indisponible"); },
    uploadProductImage: async () => { throw new Error("ne_devrait_pas_arriver"); },
    setVariantImage: async () => undefined,
    deleteProductImage: async (...args) => calls.push(["delete", ...args]),
    updateProductImage: async () => undefined,
    saveAutomationState: async () => undefined
  });
  assert.equal(result.failed, 1);
  assert.equal(calls.length, 0);
});

test("un échec de retouche écarte l'image chinoise si une image propre existe", async () => {
  const calls = [];
  const cleanUrl = "https://cdn11.bigcommerce.com/a/clean.jpg";
  const chineseUrl = "https://cdn11.bigcommerce.com/a/chinese.jpg";
  const result = await automate1688Images(capture, {}, {
    ...noDescriptionChange,
    listRecentProducts: async () => [{ id: 99, name: capture.sourceTitle, sku: "" }],
    getProductImages: async () => [
      { id: 10, url_standard: cleanUrl, is_thumbnail: false },
      { id: 11, url_standard: chineseUrl, is_thumbnail: true }
    ],
    getProductVariants: async () => [{ id: 501, image_url: chineseUrl }],
    getAutomationState: async () => null,
    analyseImage: async url => url === cleanUrl
      ? { action: "keep", containsCjk: false, confidence: 1, textCoverage: 0 }
      : { action: "remove_text", containsCjk: true, confidence: 0.99, textCoverage: 0.2 },
    editImage: async () => { throw new Error("retouche_indisponible"); },
    uploadProductImage: async () => { throw new Error("ne_devrait_pas_arriver"); },
    setVariantImage: async (...args) => calls.push(["variant", ...args.slice(0, 3)]),
    updateProductImage: async (...args) => calls.push(["thumbnail", ...args.slice(0, 3)]),
    deleteProductImage: async (...args) => calls.push(["delete", ...args.slice(0, 2)]),
    saveAutomationState: async () => undefined
  });
  assert.equal(result.deleted, 1);
  assert.equal(result.variantsUpdated, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls, [
    ["variant", 99, 501, cleanUrl],
    ["thumbnail", 99, 10, { is_thumbnail: true }],
    ["delete", 99, 11]
  ]);
});

test("une retouche qui change la variante est refusée et l'original reste en place", async () => {
  const deleted = [];
  let analyses = 0;
  const result = await automate1688Images(capture, {}, {
    ...noDescriptionChange,
    listRecentProducts: async () => [{ id: 99, name: capture.sourceTitle, sku: "" }],
    getProductImages: async () => [{ id: 11, url_standard: "https://cdn11.bigcommerce.com/a/chinese.jpg", is_thumbnail: true }],
    getProductVariants: async () => [],
    getAutomationState: async () => null,
    analyseImage: async () => (++analyses === 1)
      ? { action: "remove_text", containsCjk: true, confidence: 0.98, textCoverage: 0.1, essentialFrenchText: [], dominantColors: ["pink"], productCount: 1 }
      : { action: "keep", containsCjk: false, confidence: 0.99, textCoverage: 0, essentialFrenchText: [], dominantColors: ["blue"], productCount: 2 },
    editImage: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", filename: "clean.png" }),
    uploadProductImage: async () => ({ id: 12, url_standard: "https://cdn11.bigcommerce.com/a/changed.png" }),
    setVariantImage: async () => undefined,
    deleteProductImage: async (_productId, imageId) => deleted.push(imageId),
    updateProductImage: async () => undefined,
    saveAutomationState: async () => undefined
  });
  assert.equal(result.failed, 1);
  assert.deepEqual(deleted, [12]);
  assert.ok(!deleted.includes(11));
});

test("une description anglaise est traduite sans modifier le titre du produit", async () => {
  const updates = [];
  const states = [];
  const french = "<p>Carnet de haute qualité avec 12 feuilles.</p>";
  const result = await automate1688Images(capture, {}, {
    listRecentProducts: async () => [{ id: 99, name: capture.sourceTitle, sku: "" }],
    getProductDetails: async () => ({
      id: 99,
      name: capture.sourceTitle,
      description: "<p>High quality notebook with 12 sheets.</p>"
    }),
    getProductImages: async () => [],
    getProductVariants: async () => [],
    getAutomationState: async () => null,
    translateDescriptionToFrench: async () => ({ changed: true, html: french, reason: "translated_to_french_with_emoji" }),
    updateProductDescription: async (...args) => updates.push(args.slice(0, 2)),
    analyseImage: async () => { throw new Error("image_analysis_not_expected"); },
    saveAutomationState: async (_id, state) => states.push(state)
  });
  assert.equal(result.descriptionTranslated, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(updates, [[99, french]]);
  assert.equal(states[0].version, 5);
  assert.equal(states[0].description.status, "translated_to_french_with_emoji");
  assert.equal(states[0].sourceTitle, capture.sourceTitle);
});

test("une variante impossible à retoucher utilise l'image propre de la galerie", async () => {
  const relinks = [];
  const cleanUrl = "https://cdn11.bigcommerce.com/a/clean-all-colours.jpg";
  const result = await automate1688Images(capture, {}, {
    ...noDescriptionChange,
    listRecentProducts: async () => [{ id: 99, name: capture.sourceTitle, sku: "" }],
    getProductImages: async () => [{ id: 10, url_standard: cleanUrl, is_thumbnail: true }],
    getProductVariants: async () => [{ id: 501, image_url: "https://cdn11.bigcommerce.com/a/variant-chinese.jpg" }],
    getAutomationState: async () => null,
    analyseImage: async url => url === cleanUrl
      ? { action: "keep", containsCjk: false, confidence: 1, textCoverage: 0 }
      : { action: "remove_text", containsCjk: true, confidence: 0.99, textCoverage: 0.1 },
    editImage: async () => { throw new Error("clean_image_verification_failed"); },
    setVariantImage: async (...args) => relinks.push(args.slice(0, 3)),
    deleteProductImage: async () => undefined,
    updateProductImage: async () => undefined,
    saveAutomationState: async () => undefined
  });
  assert.equal(result.variantsUpdated, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(relinks, [[99, 501, cleanUrl]]);
});

test("une variante rejetée est reliée à l'image propre sans supprimer la dernière image", async () => {
  const relinks = [];
  const cleanUrl = "https://cdn11.bigcommerce.com/a/clean-all-colours.jpg";
  const result = await automate1688Images(capture, {}, {
    ...noDescriptionChange,
    listRecentProducts: async () => [{ id: 99, name: capture.sourceTitle, sku: "" }],
    getProductImages: async () => [{ id: 10, url_standard: cleanUrl, is_thumbnail: true }],
    getProductVariants: async () => [{ id: 502, image_url: "https://cdn11.bigcommerce.com/a/poster-chinese.jpg" }],
    getAutomationState: async () => null,
    analyseImage: async url => url === cleanUrl
      ? { action: "keep", containsCjk: false, confidence: 1, textCoverage: 0 }
      : { action: "reject", containsCjk: true, confidence: 0.99, textCoverage: 0.8 },
    setVariantImage: async (...args) => relinks.push(args.slice(0, 3)),
    deleteProductImage: async () => { throw new Error("aucune_suppression_attendue"); },
    updateProductImage: async () => undefined,
    saveAutomationState: async () => undefined
  });
  assert.equal(result.variantsUpdated, 1);
  assert.equal(result.preservedForSafety, 0);
  assert.deepEqual(relinks, [[99, 502, cleanUrl]]);
});

test("une variante 1688 séparée marquée propre utilise quand même la galerie vérifiée", async () => {
  const relinks = [];
  const cleanUrl = "https://cdn11.bigcommerce.com/a/clean-all-colours.jpg";
  const result = await automate1688Images(capture, {}, {
    ...noDescriptionChange,
    listRecentProducts: async () => [{ id: 99, name: capture.sourceTitle, sku: "" }],
    getProductImages: async () => [{ id: 10, url_standard: cleanUrl, is_thumbnail: true }],
    getProductVariants: async () => [{ id: 503, image_url: "https://cdn11.bigcommerce.com/a/variant-claimed-clean.jpg" }],
    getAutomationState: async () => null,
    analyseImage: async () => ({ action: "keep", containsCjk: false, confidence: 1, textCoverage: 0 }),
    setVariantImage: async (...args) => relinks.push(args.slice(0, 3)),
    deleteProductImage: async () => undefined,
    updateProductImage: async () => undefined,
    saveAutomationState: async () => undefined
  });
  assert.equal(result.variantsUpdated, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(relinks, [[99, 503, cleanUrl]]);
});
