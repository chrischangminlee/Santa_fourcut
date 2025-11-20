const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-image";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).send("Method Not Allowed");
  }

  const { apiKey, model = DEFAULT_GEMINI_MODEL, prompt, image } = req.body || {};

  if (!apiKey || !prompt || !image?.data || !image?.type) {
    return res.status(400).json({
      error: "apiKey, prompt, image.type, image.data are required",
    });
  }

  const endpoint = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`
  );
  endpoint.searchParams.set("key", apiKey);

  const payload = {
    contents: [
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
    ],
    generationConfig: {
      temperature: 0.7,
    },
  };

  let upstreamResponse;
  let data;

  try {
    upstreamResponse = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await upstreamResponse.text();
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = null;
    }
  } catch (error) {
    return res
      .status(502)
      .json({ error: error.message || "Gemini API 요청 실패" });
  }

  if (!upstreamResponse.ok) {
    const message =
      data?.error?.message || `Gemini API error (${upstreamResponse.status})`;
    return res.status(upstreamResponse.status).json({ error: message });
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const inlinePart = parts.find((part) => part.inlineData || part.inline_data);
  const inlineData = inlinePart?.inlineData || inlinePart?.inline_data;
  const textParts = parts
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text);

  if (!inlineData?.data) {
    return res.status(502).json({
      error: "Gemini 응답에 이미지가 포함되어 있지 않습니다.",
      text: textParts.join("\n"),
    });
  }

  return res.status(200).json({
    image: {
      data: inlineData.data,
      mimeType: inlineData.mimeType || inlineData.mime_type || "image/png",
    },
    text: textParts.join("\n").trim() || undefined,
  });
}
