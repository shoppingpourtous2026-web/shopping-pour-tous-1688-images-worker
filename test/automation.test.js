import test from "node:test";
import assert from "node:assert/strict";
import { automate1688Images, selectCaptureProduct } from "../src/automation.js";

const capture = {
  version: 1,
  sourceTitle: "Produit test 1688 très utile",
  normalisedSourceTitle: "produit test 1688 tres utile",
  supplierProductId: "123456789",
  marketplace: "1688"
};

test("selectCaptureProduct exige une correspondance unique", () => {
  assert.equal(selectCaptureProduct(capture, [{ id: 7, name: "Produit test 1688 très utile", sku: "" }]).id, 7);
  assert.equal(selectCaptureProduct(capture, [{ id: 8, name: "Autre titre", sku: "DS-123456789-BE" }]).id, 8);
  assert.throws(() => selectCaptureProduct(capture, [
    { id: 7, name: "Produit test 1688 très utile", sku: "" },
    { id: 8, name: "Autre titre", sku: "DS-123456789-BE" }
  ]), /ambiguous/);
});

test("une image chinoise est remplacée puis reliée à la variante avant suppression", async () => {
  const calls = [];
  const images = [
    { id: 10, url_standard: "https://cdn11.bigcommerce.com/a/clean.jpg", sort_order: 0, is_thumbnail: true },
    { id: 11, url_standard: "https://cdn11.bigcommerce.com/a/chinese.jpg", sort_order: 1, is_thumbnail: false }
  ];
  const result = await automate1688Images(capture, { SPT_1688_MAX_IMAGES: "12" }, {
    listRecentProducts: async () => [{ id: 99, name: capture.sourceTitle, sku: "" }],
    getProductImages: async () => images,
    getProductVariants: async () => [{ id: 501, image_url: images[1].url_standard }],
    getAutomationState: async () => null,
    analyseImage: async url => url.includes("clean")
      ? { action: "keep", containsCjk: false, confidence: 1, textCoverage: 0, essentialFrenchText: [] }
      : { action: "remove_text", containsCjk: true, confidence: 0.98, textCoverage: 0.1, essentialFrenchText: [] },
    editImage: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", filename: "clean.png" }),
    uploadProductImage: async () => ({ id: 12, url_standard: "https://cdn11.bigcommerce.com/a/clean-replacement.png" }),
    setVariantImage: async (...args) => calls.push(["variant", ...args.slice(0, 3)]),
    deleteProductImage: async (...args) => calls.push(["delete", ...args.slice(0, 2)]),
    updateProductImage: async () => undefined,
    saveAutomationState: async (_id, state) => calls.push(["state", state])
  });
  assert.equal(result.replaced, 1);
  assert.equal(result.variantsUpdated, 1);
  assert.deepEqual(calls[0], ["variant", 99, 501, "https://cdn11.bigcommerce.com/a/clean-replacement.png"]);
  assert.deepEqual(calls[1], ["delete", 99, 11]);
});

test("un échec de retouche conserve toujours l'original", async () => {
  const calls = [];
  const result = await automate1688Images(capture, {}, {
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

test("une retouche qui change la variante est refusée et l'original reste en place", async () => {
  const deleted = [];
  let analyses = 0;
  const result = await automate1688Images(capture, {}, {
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
