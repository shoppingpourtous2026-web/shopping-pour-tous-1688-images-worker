export const cleanText = (value, maxLength = 500) => String(value || "")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]*>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, "\"")
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, maxLength)
  .trim();

export const normaliseTitle = value => cleanText(value)
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("fr")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

export const imageKey = value => {
  try {
    const url = new URL(String(value || ""));
    let path = decodeURIComponent(url.pathname).toLowerCase();
    path = path.replace(/\/stencil\/(?:original|\d+x\d+)\//, "/");
    path = path.replace(/\/zoom_size\//, "/");
    return `${url.hostname.toLowerCase()}${path}`;
  } catch (_) {
    return "";
  }
};

export function prepareCapture(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("capture_1688_required");
  }
  if (payload.confirm !== "AUTOMATE_1688_IMAGES") throw new TypeError("confirmation_required");
  if (String(payload.marketplace || "").toLowerCase() !== "1688") throw new TypeError("marketplace_1688_required");
  const sourceTitle = cleanText(payload.sourceTitle, 500);
  const normalisedSourceTitle = normaliseTitle(sourceTitle);
  if (sourceTitle.length < 10 || normalisedSourceTitle.length < 10) throw new TypeError("source_title_required");
  const supplierProductId = cleanText(payload.supplierProductId, 120).replace(/[^0-9A-Za-z_-]/g, "");
  return {
    version: 1,
    sourceTitle,
    normalisedSourceTitle,
    supplierProductId,
    supplierProductUrl: cleanText(payload.supplierProductUrl, 1000),
    marketplace: "1688",
    receivedAt: new Date().toISOString()
  };
}
