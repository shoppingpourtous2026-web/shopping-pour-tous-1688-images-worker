import { createHash, timingSafeEqual } from "node:crypto";

const digest = value => createHash("sha256").update(String(value || ""), "utf8").digest();

export function authorised(request, expectedToken) {
  if (!expectedToken) return false;
  const header = String(request.headers.get("authorization") || "");
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return timingSafeEqual(digest(supplied), digest(expectedToken));
}

export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400"
};

export const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders
  }
});
