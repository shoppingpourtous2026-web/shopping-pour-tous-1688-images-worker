import test from "node:test";
import assert from "node:assert/strict";
import {
  descriptionNeedsTranslation,
  translateDescriptionToFrench
} from "../src/cloudflare-description-translator.js";

test("la détection distingue une description française d'une description 1688 à traduire", () => {
  assert.equal(descriptionNeedsTranslation("<p>Ce produit est facile à utiliser avec votre famille.</p>"), false);
  assert.equal(descriptionNeedsTranslation("<p>This product is easy to use with your family.</p>"), true);
  assert.equal(descriptionNeedsTranslation("<p>产品材质与尺寸说明</p>"), true);
});

test("la traduction conserve exactement le HTML, les dimensions et les quantités", async () => {
  const source = '<p class="intro">High quality notebook with 12 sheets.</p><p>Size: 10 × 8 cm.</p>';
  const result = await translateDescriptionToFrench(source, {
    AI: {
      run: async (_model, options) => {
        const protectedSource = options.messages[1].content.split("DESCRIPTION À TRADUIRE :\n")[1];
        return {
          response: protectedSource
            .replace("High quality notebook with", "Carnet de haute qualité avec")
            .replace("sheets", "feuilles")
            .replace("Size", "Taille")
        };
      }
    }
  });
  assert.equal(result.changed, true);
  assert.equal(result.html, '<p class="intro">✨ Carnet de haute qualité avec 12 feuilles.</p><p>Taille: 10 × 8 cm.</p>');
});

test("une description déjà française reçoit une présentation sobre avec émoji", async () => {
  const source = "<p>Ce produit est facile à utiliser avec votre famille.</p>";
  const result = await translateDescriptionToFrench(source, {});
  assert.equal(result.changed, true);
  assert.equal(result.reason, "french_styled_with_emoji");
  assert.equal(result.html, "<p>✨ Ce produit est facile à utiliser avec votre famille.</p>");
});

test("une traduction encore mélangée à l'anglais est retentée", async () => {
  let calls = 0;
  const source = "<p>Upgraded drain pad material and product size.</p>";
  const result = await translateDescriptionToFrench(source, {
    AI: {
      run: async (_model, options) => {
        calls += 1;
        const protectedSource = options.messages[1].content.split("DESCRIPTION À TRADUIRE :\n")[1]
          .split("\nCONTRÔLE OBLIGATOIRE")[0];
        if (calls === 1) return { response: protectedSource.replace("and", "et") };
        return { response: protectedSource.replace("Upgraded drain pad material and product size", "Tapis égouttoir amélioré en silicone et taille du produit") };
      }
    }
  });
  assert.equal(calls, 2);
  assert.match(result.html, /✨ Tapis égouttoir amélioré/);
});

test("une traduction qui perd une valeur protégée est refusée", async () => {
  await assert.rejects(() => translateDescriptionToFrench("<p>Package includes 24 pieces for your home.</p>", {
    AI: {
      run: async (_model, options) => ({
        response: options.messages[1].content
          .split("DESCRIPTION À TRADUIRE :\n")[1]
          .replace(/__SPT_VALUE_[A-Z]+__/, "")
          .replace("Package includes", "Le colis comprend")
          .replace("pieces for your home", "pièces pour votre maison")
      })
    }
  }), /placeholders_changed/);
});

test("une description contenant du HTML dangereux reste intacte", async () => {
  await assert.rejects(() => translateDescriptionToFrench(
    "<p>This product is easy to use.</p><script>alert(1)</script>",
    { AI: { run: async () => ({ response: "ne doit pas être appelé" }) } }
  ), /unsafe_original_preserved/);
});
