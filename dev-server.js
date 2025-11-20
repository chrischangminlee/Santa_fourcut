#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = parseInt(process.env.PORT, 10) || 5173;
const ROOT = process.cwd();

const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-image";

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleGeminiRequest(req, res) {
  if (req.method !== "POST") {
    send(res, 405, "Method Not Allowed", { Allow: "POST" });
    return;
  }

  let payload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body.toString("utf8"));
  } catch (error) {
    sendJson(res, 400, { error: "Invalid JSON payload" });
    return;
  }

  const apiKey = (payload && payload.apiKey) || "";
  const model = (payload && payload.model) || DEFAULT_GEMINI_MODEL;
  const prompt = payload?.prompt;
  const image = payload?.image;

  if (!apiKey || !prompt || !image?.data || !image?.type) {
    sendJson(res, 400, {
      error: "apiKey, prompt, image.type, image.data are required",
    });
    return;
  }

  const endpoint = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`
  );
  endpoint.searchParams.set("key", apiKey);

  const contents = [
    {
      role: "user",
      parts: [{ text: prompt }],
    },
    {
      role: "user",
      parts: [
        {
          inline_data: {
            mime_type: image.type,
            data: image.data,
          },
        },
      ],
    },
  ];

  const requestBody = {
    contents,
    generationConfig: {
      temperature: 0.7,
    },
  };

  let upstreamResponse;
  let responseData;
  try {
    upstreamResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const text = await upstreamResponse.text();
    try {
      responseData = JSON.parse(text);
    } catch (error) {
      responseData = null;
    }
  } catch (error) {
    sendJson(res, 502, { error: error.message || "Gemini API 요청 실패" });
    return;
  }

  if (!upstreamResponse.ok) {
    const message =
      responseData?.error?.message ||
      `Gemini API error (${upstreamResponse.status})`;
    sendJson(res, upstreamResponse.status, { error: message });
    return;
  }

  const parts = responseData?.candidates?.[0]?.content?.parts || [];
  const inlinePart = parts.find((part) => part.inlineData || part.inline_data);
  const inlineData = inlinePart?.inlineData || inlinePart?.inline_data;
  const textParts = parts
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text);

  if (!inlineData?.data) {
    sendJson(res, 502, {
      error: "Gemini 응답에 이미지가 포함되어 있지 않습니다.",
      text: textParts.join("\n"),
    });
    return;
  }

  sendJson(res, 200, {
    image: {
      data: inlineData.data,
      mimeType: inlineData.mimeType || inlineData.mime_type || "image/png",
    },
    text: textParts.join("\n").trim() || undefined,
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/api/gemini") {
    handleGeminiRequest(req, res).catch((error) => {
      console.error("[santa-dev] Gemini proxy error:", error);
      sendJson(res, 500, { error: "Gemini proxy internal error" });
    });
    return;
  }

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = path.join(ROOT, pathname);

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      if (pathname !== "/index.html") {
        res.writeHead(302, { Location: "/" });
        res.end();
      } else {
        send(res, 404, "Not Found");
      }
      return;
    }

    res.writeHead(200, { "Content-Type": contentType(filePath) });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on("error", (error) => {
  console.error(`[santa-dev] 서버를 시작할 수 없습니다: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`\nSanta 4cut dev server running at http://${HOST}:${PORT}`);
  console.log("Press Ctrl+C to stop.\n");
});
