import test from "node:test";
import assert from "node:assert/strict";
import { imageKey, normaliseTitle, prepareCapture } from "../src/normalise.js";
import { normalisePlan } from "../src/cloudflare-image-cleaner.js";

test("prepareCapture accepte uniquement une automatisation 1688 confirmée", () => {
  const result = prepareCapture({
    confirm: "AUTOMATE_1688_IMAGES",
    marketplace: "1688",
    sourceTitle: "Joli produit 1688 pour la boutique",
    supplierProductId: "123456789"
  });
  assert.equal(result.marketplace, "1688");
  assert.equal(result.supplierProductId, "123456789");
  assert.throws(() => prepareCapture({ marketplace: "1688", sourceTitle: "Titre suffisamment long" }), /confirmation_required/);
});

test("normaliseTitle et imageKey stabilisent les correspondances", () => {
  assert.equal(normaliseTitle("Éponge — Cuisine !"), "eponge cuisine");
  assert.equal(
    imageKey("https://cdn11.bigcommerce.com/s-x/stencil/386x513/products/12/images/9/demo.JPG?c=1"),
    "cdn11.bigcommerce.com/s-x/products/12/images/9/demo.jpg"
  );
});

test("normalisePlan garde, traduit ou rejette prudemment", () => {
  assert.equal(normalisePlan({ containsCjk: false, action: "reject", confidence: 1 }).action, "keep");
  assert.equal(normalisePlan({
    containsCjk: true,
    textCoverage: 0.2,
    action: "remove_text",
    confidence: 0.95,
    essentialFrenchText: ["Dimensions : 12 × 8 cm"]
  }).action, "translate");
  assert.equal(normalisePlan({ containsCjk: true, textCoverage: 0.6, action: "translate", confidence: 0.99 }).action, "reject");
  assert.equal(normalisePlan({ containsCjk: true, textCoverage: 0.1, action: "remove_text", confidence: 0.5 }).action, "reject");
  assert.deepEqual(normalisePlan({
    containsCjk: true,
    textCoverage: 0.1,
    action: "remove_text",
    confidence: 0.99,
    dominantColors: ["pink", "inconnue", "white"],
    productCount: 2
  }).dominantColors, ["pink", "white"]);
});
