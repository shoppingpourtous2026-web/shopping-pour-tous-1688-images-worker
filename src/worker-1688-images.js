import { automate1688Images } from "./automation.js";
import { prepareCapture } from "./normalise.js";
import { authorised, corsHeaders, jsonResponse } from "./security.js";

const requestBody = async request => {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > 32 * 1024) throw new TypeError("payload_too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > 32 * 1024) throw new TypeError("payload_invalid");
  return JSON.parse(new TextDecoder().decode(bytes));
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "shopping-pour-tous-1688-images", version: "1.1.0" });
    }
    if (request.method !== "POST" || url.pathname !== "/api/1688/image-automation") {
      return jsonResponse({ error: "not_found" }, 404);
    }
    if (!authorised(request, env.SPT_1688_CONNECTOR_TOKEN)) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    try {
      const capture = prepareCapture(await requestBody(request));
      const result = await automate1688Images(capture, env);
      const status = result.matched ? 200 : 202;
      console.log(JSON.stringify({ event: "spt_1688_image_automation", status, ...result }));
      return jsonResponse(result, status);
    } catch (error) {
      const invalid = error instanceof TypeError || error instanceof SyntaxError;
      console.error(JSON.stringify({
        event: "spt_1688_image_automation_error",
        error: String(error?.message || error)
      }));
      return jsonResponse({
        error: invalid ? String(error?.message || "invalid_request") : "automation_failed"
      }, invalid ? 400 : 502);
    }
  },
};
