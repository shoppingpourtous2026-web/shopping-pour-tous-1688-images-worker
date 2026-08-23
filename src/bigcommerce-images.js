const apiBase = env => `https://api.bigcommerce.com/stores/${env.BIGCOMMERCE_STORE_HASH}/v3`;

const bodyLimit = 3 * 1024 * 1024;

async function readJsonBounded(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > bodyLimit) throw new Error("bigcommerce_response_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > bodyLimit) throw new Error("bigcommerce_response_too_large");
  if (!bytes.byteLength) return {};
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function bcRequest(path, options = {}, env) {
  if (!env?.BIGCOMMERCE_STORE_HASH || !env?.BIGCOMMERCE_ACCESS_TOKEN) {
    throw new Error("bigcommerce_credentials_missing");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  headers.set("X-Auth-Token", env.BIGCOMMERCE_ACCESS_TOKEN);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  try {
    const response = await fetch(apiBase(env) + path, {
      ...options,
      headers,
      signal: controller.signal
    });
    const payload = await readJsonBounded(response).catch(error => {
      if (response.ok) throw error;
      return { error: error.message };
    });
    if (!response.ok) {
      const error = new Error(`bigcommerce_${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("bigcommerce_timeout");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function listRecentProducts(env, limit = 100) {
  const fields = "id,name,sku,date_created,date_modified";
  const params = new URLSearchParams({
    page: "1",
    limit: String(Math.min(100, Math.max(1, Number(limit) || 100))),
    sort: "id",
    direction: "desc",
    include_fields: fields
  });
  const result = await bcRequest(`/catalog/products?${params}`, {}, env);
  return Array.isArray(result?.data) ? result.data : [];
}

export async function getProductDetails(productId, env) {
  const fields = "id,name,sku,description";
  const result = await bcRequest(
    `/catalog/products/${Number(productId)}?include_fields=${encodeURIComponent(fields)}`,
    {},
    env
  );
  return result?.data || null;
}

export async function updateProductDescription(productId, description, env) {
  const result = await bcRequest(`/catalog/products/${Number(productId)}`, {
    method: "PUT",
    body: JSON.stringify({ description: String(description || "") })
  }, env);
  return result?.data || null;
}

export async function getProductImages(productId, env) {
  const result = await bcRequest(`/catalog/products/${Number(productId)}/images?limit=250`, {}, env);
  return Array.isArray(result?.data) ? result.data : [];
}

export async function getProductVariants(productId, env) {
  const result = await bcRequest(`/catalog/products/${Number(productId)}/variants?limit=250`, {}, env);
  return Array.isArray(result?.data) ? result.data : [];
}

export async function uploadProductImage(productId, { bytes, mimeType, filename, description, sortOrder, isThumbnail }, env) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 8 * 1024 * 1024) {
    throw new Error("clean_image_size_invalid");
  }
  const form = new FormData();
  form.append("image_file", new File([bytes], filename || "image-1688-nettoyee.png", { type: mimeType || "image/png" }));
  const created = await bcRequest(`/catalog/products/${Number(productId)}/images`, {
    method: "POST",
    body: form
  }, env);
  const image = created?.data;
  if (!Number.isInteger(Number(image?.id))) throw new Error("bigcommerce_image_create_failed");
  const updated = await bcRequest(`/catalog/products/${Number(productId)}/images/${Number(image.id)}`, {
    method: "PUT",
    body: JSON.stringify({
      description: String(description || "Image produit nettoyée automatiquement").slice(0, 255),
      sort_order: Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : 0,
      is_thumbnail: isThumbnail === true
    })
  }, env);
  return updated?.data || image;
}

export async function updateProductImage(productId, imageId, patch, env) {
  const result = await bcRequest(`/catalog/products/${Number(productId)}/images/${Number(imageId)}`, {
    method: "PUT",
    body: JSON.stringify(patch)
  }, env);
  return result?.data;
}

export async function deleteProductImage(productId, imageId, env) {
  await bcRequest(`/catalog/products/${Number(productId)}/images/${Number(imageId)}`, { method: "DELETE" }, env);
}

export async function setVariantImage(productId, variantId, imageUrl, env) {
  const result = await bcRequest(`/catalog/products/${Number(productId)}/variants/${Number(variantId)}/image`, {
    method: "POST",
    body: JSON.stringify({ image_url: String(imageUrl) })
  }, env);
  return result?.data;
}

export async function getAutomationState(productId, env) {
  const result = await bcRequest(
    `/catalog/products/${Number(productId)}/metafields?namespace=shopping_1688_images&key=automation_v1&limit=10`,
    {},
    env
  );
  const field = result?.data?.find(item => item?.key === "automation_v1");
  if (!field?.value) return null;
  try { return JSON.parse(field.value); } catch (_) { return null; }
}

export async function saveAutomationState(productId, state, env) {
  const path = `/catalog/products/${Number(productId)}/metafields`;
  const result = await bcRequest(`${path}?namespace=shopping_1688_images&key=automation_v1&limit=10`, {}, env);
  const existing = result?.data?.find(item => item?.key === "automation_v1");
  const body = JSON.stringify({
    namespace: "shopping_1688_images",
    key: "automation_v1",
    value: JSON.stringify(state),
    permission_set: "write"
  });
  if (existing) await bcRequest(`${path}/${Number(existing.id)}`, { method: "PUT", body }, env);
  else await bcRequest(path, { method: "POST", body }, env);
  return state;
}
