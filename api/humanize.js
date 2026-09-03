/**
 * Adire — AI Text Humanizer
 * Vercel Serverless Function: receives text from the frontend, calls a
 * Hugging Face-hosted model (via HF's unified inference router) to rewrite
 * it in a more natural, human-sounding way, and returns the result.
 *
 * DEPLOY:
 * 1. Put this file at:  api/humanize.js  (inside your project root)
 * 2. Put index.html at the project root (or /public if you prefer)
 * 3. In the Vercel dashboard: Project Settings → Environment Variables
 *      Add HF_TOKEN = your Hugging Face access token
 *      (Get one at https://huggingface.co/settings/tokens — "Read" type is
 *      enough — never hardcode it in this file)
 * 4. Deploy: vercel deploy  (or connect the repo/folder via the dashboard)
 * 5. Your endpoint will be live at:  https://your-project.vercel.app/api/humanize
 *    No need to hardcode a URL in index.html — same-origin relative path works.
 *
 * Free tier: Vercel's Hobby plan covers this comfortably for a low/medium
 * traffic tool — no server to maintain. Hugging Face's free inference tier
 * is rate-limited on shared infrastructure (expect occasional slower
 * responses during peak hours) and draws from a separate quota than
 * OpenRouter, so switching here doesn't inherit any OpenRouter rate limits.
 */

const SYSTEM_PROMPT = `You are rewriting AI-generated text so it reads as authentically human-written. Preserve every fact, number, name, and the overall meaning exactly. Do not add or remove information. Target length: within 10% of the original.

Apply ALL of these techniques, not just some:

1. BURSTINESS: Human writing has highly irregular sentence length. Deliberately mix very short sentences (3-6 words) with longer, more complex ones in the same paragraph. Never let three consecutive sentences be a similar length.

2. KILL AI TROPES: Never use these words/phrases, in any form: "delve", "tapestry", "boundaries", "realm", "landscape" (metaphorical), "furthermore", "moreover", "in conclusion", "it is important to note", "it's worth noting", "additionally", "overall", "in summary", "underscore", "testament to", "navigate" (metaphorical), "robust", "seamless", "leverage" (as verb), "unlock", "elevate", "foster", "paramount".

3. BREAK THE THREE-PART LIST HABIT: AI writing defaults to listing things in groups of three ("fast, reliable, and efficient"). Vary this deliberately — use two items, or four, or a single strong word instead of a list.

4. CUT HEDGING AND SUMMARY SENTENCES: AI text often opens or closes paragraphs with a broad summarizing sentence. Cut these. Start paragraphs with a specific detail instead.

5. VARY SENTENCE OPENERS: Do not start consecutive sentences the same way (e.g. repeatedly starting with "This", "The", or a gerund). 

6. ALLOW MINOR NATURAL IMPERFECTION: Real human writing isn't perfectly polished. A slightly informal transition, a sentence fragment for emphasis, or a contraction where natural is good. Don't overdo it — this should still read as competent writing, just not machine-smooth.

7. CONCRETE OVER ABSTRACT: Where the original is vague or generic, make wording more specific and concrete without inventing new facts.

Do not add commentary, explanations, meta-notes, or quotation marks around the output — return ONLY the rewritten text.`;

const REVISION_PROMPT = `Read this rewritten text as a skeptical editor. Find any remaining sentence that sounds templated, overly balanced, or textbook-perfect, and rewrite just that sentence to break the pattern — vary its length or restructure it. Keep everything else as-is. Return ONLY the full text, no commentary.`;

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

  const callModel = async (systemContent, userContent) => {
    // Hugging Face's unified inference router — OpenAI-compatible endpoint.
    // Draws from a separate free quota than OpenRouter, so it doesn't compete
    // with whatever OpenRouter usage builds up elsewhere.
    const hfResponse = await fetch("https://router.huggingface.co/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.HF_TOKEN}`,
      },
      body: JSON.stringify({
        model: "meta-llama/Llama-3.3-70B-Instruct",
        temperature: 1.3,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!hfResponse.ok) {
      const errText = await hfResponse.text();
      console.error("Hugging Face error:", hfResponse.status, errText);
      throw new Error(`upstream:${hfResponse.status}:${errText}`);
    }

    const data = await hfResponse.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
  };

  try {
    // Pass 1: main humanizing rewrite
    const firstPass = await callModel(SYSTEM_PROMPT + toneInstruction, cleanText);

    if (!firstPass) {
      return res.status(502).json({ error: "Empty response from model." });
    }

    // Pass 2: a second, cheap editorial pass that specifically hunts down and
    // smooths over any remaining templated-sounding sentences the first pass
    // missed — same idea as the original repo's multi-hop translation trick,
    // done here as a second LLM call instead.
    let output = firstPass;
    try {
      const secondPass = await callModel(REVISION_PROMPT, firstPass);
      if (secondPass) output = secondPass;
    } catch (revisionErr) {
      // If the revision pass fails (e.g. rate limit), fall back to the first
      // pass result rather than failing the whole request.
      console.error("Revision pass failed, using first-pass result:", revisionErr);
    }

    return res.status(200).json({ result: output });
  } catch (err) {
    return res.status(500).json({ error: "Server error.", detail: String(err) });
  }
}
