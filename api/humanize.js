/**
 * Adire — AI Text Humanizer
 * Vercel Serverless Function: receives text from the frontend, calls DeepSeek
 * to rewrite it in a more natural, human-sounding way, and returns the result.
 *
 * DEPLOY:
 * 1. Put this file at:  api/humanize.js  (inside your project root)
 * 2. Put index.html at the project root (or /public if you prefer)
 * 3. In the Vercel dashboard: Project Settings → Environment Variables
 *      Add OPENROUTER_API_KEY = your key
 *      (Get one at https://openrouter.ai/keys — never hardcode it in this file)
 * 4. Deploy: vercel deploy  (or connect the repo/folder via the dashboard)
 * 5. Your endpoint will be live at:  https://your-project.vercel.app/api/humanize
 *    No need to hardcode a URL in index.html — same-origin relative path works.
 *
 * Free tier: Vercel's Hobby plan covers this comfortably for a low/medium
 * traffic tool — no server to maintain.
 */

const SYSTEM_PROMPT = `You are a text rewriting engine. Rewrite the user's text so it reads as naturally human-written, while keeping the exact same meaning, facts, and length (within 10%).

Rules:
- Vary sentence length and structure — mix short and long sentences.
- Replace overly uniform, robotic phrasing with more natural, slightly imperfect human phrasing.
- Avoid AI-typical stock phrases ("in conclusion", "it is important to note", "furthermore", "delve into", "moreover").
- Keep the tone and register the user asks for.
- Do not add commentary, explanations, or notes — return ONLY the rewritten text, nothing else.
- Do not wrap the output in quotes or markdown formatting.`;

export default async function handler(req, res) {
  // CORS (safe to keep even if same-origin; harmless otherwise)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST." });
  }

  const { text, tone } = req.body || {};
  const cleanText = (text || "").toString().trim();
  const cleanTone = (tone || "neutral").toString();

  if (!cleanText) {
    return res.status(400).json({ error: "No text provided." });
  }
  if (cleanText.length > 8000) {
    return res.status(400).json({ error: "Text too long. Max 8000 characters per request." });
  }

  const toneInstruction =
    cleanTone === "naija"
      ? " Lightly flavor the phrasing with natural Nigerian English rhythm and word choice (e.g. how a Nigerian graduate or professional writes), without using Pidgin or slang unless the input already contains it."
      : "";

  try {
    // Using OpenRouter to call Google's Gemma 4 model.
    // Free tier slug below; swap to "google/gemma-4-26b-a4b-it" (no :free) for
    // paid/higher-uptime routing if the free tier gets rate-limited under load.
    const orResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://adirehumanizer.vercel.app", // update to your real domain once deployed
        "X-Title": "Adire AI Humanizer",
      },
      body: JSON.stringify({
        model: "google/gemma-4-26b-a4b-it:free",
        temperature: 1.3,
        messages: [
          { role: "system", content: SYSTEM_PROMPT + toneInstruction },
          { role: "user", content: cleanText },
        ],
      }),
    });

    if (!orResponse.ok) {
      const errText = await orResponse.text();
      return res.status(502).json({ error: "Upstream API error.", detail: errText });
    }

    const data = await orResponse.json();
    const output = data.choices?.[0]?.message?.content?.trim() || "";

    if (!output) {
      return res.status(502).json({ error: "Empty response from model." });
    }

    return res.status(200).json({ result: output });
  } catch (err) {
    return res.status(500).json({ error: "Server error.", detail: String(err) });
  }
}
