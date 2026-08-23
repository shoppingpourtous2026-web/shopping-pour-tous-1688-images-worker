import test from "node:test";
import assert from "node:assert/strict";
import { imageKey, normaliseTitle, prepareCapture } from "../src/normalise.js";
import { analyseImage, editImage, normalisePlan } from "../src/cloudflare-image-cleaner.js";

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

test("analyseImage transmet les octets de l'image au modèle au lieu de l'URL BigCommerce", async () => {
  const originalFetch = globalThis.fetch;
  let receivedImage = "";
  globalThis.fetch = async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "4" }
  });
  try {
    const result = await analyseImage("https://cdn11.bigcommerce.com/test/image.jpg", "Produit test", {
      AI: {
        run: async (_model, input) => {
          receivedImage = input.image;
          if (String(input.question).includes("un seul mot")) return { answer: "CLEAR" };
          return {
            answer: JSON.stringify({
              containsCjk: false,
              textCoverage: 0,
              action: "keep",
              confidence: 0.99,
              essentialFrenchText: [],
              dominantColors: ["white"],
              productCount: 1,
              reason: "Aucun texte CJK"
            })
          };
        }
      }
    });
    assert.match(receivedImage, /^data:image\/jpeg;base64,/);
    assert.equal(result.action, "keep");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analyseImage rattrape une image chinoise classée à tort comme propre", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "4" }
  });
  try {
    const result = await analyseImage("https://cdn11.bigcommerce.com/test/image.jpg", "Produit test", {
      AI: {
        run: async () => {
          calls += 1;
          if (calls === 1) {
            return { answer: JSON.stringify({
              containsCjk: false,
              textCoverage: 0,
              action: "keep",
              confidence: 0.96,
              essentialFrenchText: [],
              dominantColors: ["yellow"],
              productCount: 1,
              reason: "classification initiale incorrecte"
            }) };
          }
          return { answer: "CJK" };
        }
      }
    });
    assert.equal(result.containsCjk, true);
    assert.equal(result.action, "remove_text");
    assert.equal(result.productCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analyseImage utilise le contrôle court quand la réponse détaillée reste vide", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "4" }
  });
  try {
    const result = await analyseImage("https://cdn11.bigcommerce.com/test/image.jpg", "Produit test", {
      AI: {
        run: async () => {
          calls += 1;
          return calls <= 2 ? { answer: "" } : { answer: "CJK" };
        }
      }
    });
    assert.equal(result.containsCjk, true);
    assert.equal(result.action, "remove_text");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analyseImage rattrape le chinois par transcription après un faux CLEAR", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "4" }
  });
  try {
    const result = await analyseImage("https://cdn11.bigcommerce.com/test/image.jpg", "Produit test", {
      AI: {
        run: async () => {
          calls += 1;
          if (calls === 1) return { answer: JSON.stringify({
            containsCjk: false,
            textCoverage: 0,
            action: "keep",
            confidence: 0.99,
            essentialFrenchText: [],
            dominantColors: ["yellow"],
            productCount: 1,
            reason: "Aucun texte détecté"
          }) };
          if (calls === 2) return { answer: "CLEAR" };
          return { answer: "黄色 多功能太空人牙刷架" };
        }
      }
    });
    assert.equal(result.containsCjk, true);
    assert.equal(result.action, "remove_text");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editImage demande à Cloudflare une référence inférieure à 512 pixels", async () => {
  const originalFetch = globalThis.fetch;
  let receivedOptions = null;
  const jpeg = new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
    0x01, 0xe0, 0x01, 0x90, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00
  ]);
  globalThis.fetch = async (_url, options) => {
    receivedOptions = options;
    return new Response(jpeg, {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": String(jpeg.length) }
    });
  };
  try {
    const cleaned = await editImage(
      "https://cdn11.bigcommerce.com/test/large.jpg",
      { action: "remove_text", essentialFrenchText: [] },
      "Produit test",
      { AI: { run: async () => ({ image: "AQID" }) } }
    );
    assert.equal(receivedOptions.cf.image.width, 480);
    assert.equal(receivedOptions.cf.image.height, 480);
    assert.equal(receivedOptions.cf.image.fit, "scale-down");
    assert.deepEqual([...cleaned.bytes], [1, 2, 3]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("analyseImage ne confond pas une transcription latine avec du texte CJK", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    status: 200,
    headers: { "content-type": "image/jpeg", "content-length": "4" }
  });
  try {
    const result = await analyseImage("https://cdn11.bigcommerce.com/test/image.jpg", "Produit test", {
      AI: {
        run: async () => {
          calls += 1;
          if (calls === 1) return { answer: JSON.stringify({
            containsCjk: false,
            textCoverage: 0,
            action: "keep",
            confidence: 0.99,
            essentialFrenchText: [],
            dominantColors: ["white"],
            productCount: 3,
            reason: "Aucun caractère CJK"
          }) };
          if (calls === 2) return { answer: "CLEAR" };
          return { answer: "Oral-B / SOFT" };
        }
      }
    });
    assert.equal(result.containsCjk, false);
    assert.equal(result.action, "keep");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
