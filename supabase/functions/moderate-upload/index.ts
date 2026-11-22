/* =====================================================
   CFSI Student Portfolio - Upload Safety AI
   Supabase Edge Function: moderate-upload

   Accepts: {
     text?: string,
     images?: string[],                                  (still images)
     videos?: Array<{ name?, duration?, frames? }>       (sampled frames)
   }
   Returns: { flagged, reasons, categories, checks, academic }

   Three passes:
   1. OpenAI omni-moderation-latest (free) - text + all images/frames:
      violence, sexual, hate, harassment, self-harm, illicit *in context*.
   2. Google Gemini (free tier) - still images: explicit object/content
      detection + academic-relevance judgment.
   3. Google Gemini - sampled video frames in time order: weapons, drugs,
      violence/bullying, dangerous stunts, nudity, hate symbols, plus
      academic relevance. Reported separately as checks.video.

   Secrets:
   - GEMINI_API_KEY  (required for image/video checks, free at aistudio.google.com/apikey)
   - OPENAI_API_KEY  (optional but recommended, free text moderation)
   - GEMINI_MODEL    (optional, production uses gemini-3.5-flash-lite)
   ===================================================== */

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const CATEGORY_LABELS: Record<string, string> = {
  "sexual/minors": "Sexual content involving minors",
  "sexual": "Nudity or sexual content",
  "illicit": "Drugs, weapons, or illegal activity",
  "illicit/violent": "Drugs, weapons, or violent illegal activity",
  "violence": "Violence",
  "violence/graphic": "Graphic violence",
  "self-harm": "Self-harm content",
  "self-harm/intent": "Statements of self-harm intent",
  "self-harm/instructions": "Self-harm instructions",
  "hate": "Hateful content",
  "hate/threatening": "Threatening hateful content",
  "harassment": "Harassment",
  "harassment/threatening": "Threatening harassment",
};

const MAX_IMAGES = 4;
const MAX_TEXT_CHARS = 8000;
const MAX_VIDEOS = 2;
const MAX_VIDEO_FRAMES_PER_VIDEO = 4;
const MAX_VIDEO_FRAMES = 8;
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const FALLBACK_GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_TIMEOUT_MS = 15000;
const FUNCTION_VERSION = "v8-video-check";

type VideoSample = {
  name: string;
  duration: number;
  frames: string[];
};

type GeminiResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string }> };
  }>;
  promptFeedback?: { blockReason?: string };
};

type GeminiVerdict = {
  flagged: boolean;
  reasons: string[];
  academic: { relevant: boolean | null; reason: string | null };
};

const VISION_PROMPT = `You are a school media classifier for a student portfolio website.

PART A - SAFETY. Flag the upload if ANY of these are visible:
- Weapons: any real firearm or realistic replica, ammunition, explosives, knives or blades displayed as weapons, brass knuckles, tasers, crossbows. (Ignore obvious toy guns.)
- Drugs: illegal drugs, drug paraphernalia such as syringes with needles, bongs, pipes, rolling papers, baggies of pills prepared for sale.
- Alcohol/Tobacco: beer, liquor bottles, cigarettes, vapes or e-cigarettes being displayed or used.
- Nudity/Sexual: exposed genitals, breasts, buttocks, sexual activity, sexualized posing, underwear-only or swimwear-focused shots.
- Violence/Gore: blood, open wounds, fighting, dead bodies, animal cruelty.
- Self-harm: cutting, scars, or tools shown with self-harm intent.
- Hate symbols: swastikas, KKK imagery, or other symbols used to promote hate.
Do NOT flag: ordinary schoolwork, lab equipment used in class, sports equipment, normal portraits, clothed students, food and drinks in ordinary contexts.
Use these exact category labels: "Weapons", "Drugs", "Alcohol/Tobacco", "Nudity/Sexual", "Violence/Gore", "Self-harm", "Hate symbols".

PART B - ACADEMIC RELEVANCE. Judge whether this upload belongs in a school project portfolio:
ACADEMIC: school projects and coursework in science, math, arts, music, sports, coding/IT, business, history, literature, community service, research papers, reports, presentations, classwork, school events, photos of student-built apps/games/code.
NOT ACADEMIC: memes, random selfies, social-media or chat screenshots, movie/celebrity/entertainment images, random downloaded wallpapers, gameplay footage the student did not make, personal photos unrelated to any project.
When unsure, prefer academic=true. This judgment never blocks an upload; it only produces a soft warning.

Return ONLY this JSON object, no extra text:
{"flagged": boolean, "categories": string[], "reasons": string[], "academic": {"relevant": boolean, "reason": string}}
- reasons: one short, student-friendly sentence per safety category.
- academic.reason: one short student-friendly sentence explaining the academic judgment (empty string when relevant=true).
- If nothing is found in Part A: "flagged": false, "categories": [], "reasons": [].`;

const VIDEO_PROMPT = `You are a school media classifier reviewing SAMPLED FRAMES from a student video on a portfolio website.

The frames belong to one video and are supplied in chronological order. Judge the video as a sequence of moments, not isolated photos: a weapon, fight, or unsafe act may appear in only one frame.

PART A - SAFETY. Flag the video if ANY frame or action shows:
- Weapons: any real firearm or realistic replica, ammunition, explosives, knives or blades displayed as weapons, brass knuckles, tasers, crossbows. (Ignore obvious toy guns.)
- Drugs: illegal drugs, drug paraphernalia such as syringes with needles, bongs, pipes, rolling papers, baggies of pills prepared for sale.
- Alcohol/Tobacco: beer, liquor bottles, cigarettes, vapes or e-cigarettes being displayed or used.
- Nudity/Sexual: exposed genitals, breasts, buttocks, sexual activity, sexualized posing, underwear-only or swimwear-focused shots.
- Violence/Gore: physical fights, bullying or assault, blood, open wounds, dead bodies, animal cruelty.
- Dangerous stunts: fire stunts, jumping from roofs or heights, reckless driving, or other risky acts presented as entertainment or a challenge.
- Self-harm: cutting, scars, or tools shown with self-harm intent.
- Hate symbols: swastikas, KKK imagery, or other symbols used to promote hate.
Do NOT flag: ordinary classroom or lab work, sports practice, dance and stage performances, school events, student-made animations or game footage, people fully clothed, lab equipment used safely.
If the frames are blurry, dark, or mostly titles and transitions and no issue is clearly visible, do NOT flag.
Use these exact category labels: "Weapons", "Drugs", "Alcohol/Tobacco", "Nudity/Sexual", "Violence/Gore", "Dangerous stunts", "Self-harm", "Hate symbols".

PART B - ACADEMIC RELEVANCE. Judge whether this video belongs in a school project portfolio:
ACADEMIC: student-made films and animations, app or game demos, experiments, performances, presentations, vlogs about school activities, research documentation.
NOT ACADEMIC: gameplay footage the student did not make, movie/TV/celebrity clips, random memes, personal videos unrelated to any project.
When unsure, prefer academic=true. This judgment never blocks an upload; it only produces a soft warning.

Return ONLY this JSON object, no extra text:
{"flagged": boolean, "categories": string[], "reasons": string[], "academic": {"relevant": boolean, "reason": string}}
- reasons: one short, student-friendly sentence per safety category.
- academic.reason: one short student-friendly sentence explaining the academic judgment (empty string when relevant=true).
- If nothing is found in Part A: "flagged": false, "categories": [], "reasons": [].`;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const openaiKey = Deno.env.get("OPENAI_API_KEY") || "";
  const geminiKey = Deno.env.get("GEMINI_API_KEY") || "";

  if (!openaiKey && !geminiKey) {
    return json({ error: "Safety AI is not configured: add GEMINI_API_KEY in Supabase secrets.", version: FUNCTION_VERSION }, 500);
  }

  let body: {
    text?: string;
    images?: string[];
    videos?: Array<{ name?: string; duration?: number; frames?: string[] }>;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }

  const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT_CHARS) : "";
  const images = Array.isArray(body.images)
    ? body.images.filter(img => typeof img === "string" && img.startsWith("data:image/")).slice(0, MAX_IMAGES)
    : [];

  const videos: VideoSample[] = (Array.isArray(body.videos) ? body.videos : [])
    .slice(0, MAX_VIDEOS)
    .map(item => ({
      name: typeof item?.name === "string" ? item.name.slice(0, 120) : "video",
      duration: Number.isFinite(item?.duration) ? Math.max(0, Math.round(Number(item.duration))) : 0,
      frames: (Array.isArray(item?.frames) ? item.frames : [])
        .filter(frame => typeof frame === "string" && frame.startsWith("data:image/"))
        .slice(0, MAX_VIDEO_FRAMES_PER_VIDEO),
    }))
    .filter(item => item.frames.length > 0);

  const videoFrames = videos.flatMap(item => item.frames).slice(0, MAX_VIDEO_FRAMES);

  if (!text.trim() && images.length === 0 && videoFrames.length === 0) {
    return json({
      flagged: false,
      reasons: [],
      categories: {},
      academic: { relevant: null, reason: null },
      checks: { version: FUNCTION_VERSION, moderation: "skipped", vision: "skipped", video: "skipped", academic: "skipped" },
    });
  }

  const moderationPromise = openaiKey
    ? runModeration(openaiKey, text, [...images, ...videoFrames])
    : Promise.reject(new Error("OPENAI_API_KEY is not set"));

  const visionPromise = geminiKey
    ? classifyUpload(geminiKey, text, images)
    : Promise.reject(new Error("GEMINI_API_KEY is not set"));

  const videoPromise = videoFrames.length > 0
    ? (geminiKey
        ? classifyVideo(geminiKey, text, videos)
        : Promise.reject(new Error("GEMINI_API_KEY is not set")))
    : Promise.reject(new Error("No video frames to inspect"));

  const [moderationResult, visionResult, videoResult] = await Promise.allSettled([
    moderationPromise,
    visionPromise,
    videoPromise,
  ]);

  const reasons = new Set<string>();
  const scores: Record<string, number> = {};
  let flagged = false;
  let anySucceeded = false;
  let academic: { relevant: boolean | null; reason: string | null } = { relevant: null, reason: null };
  const checks: Record<string, string> = {
    version: FUNCTION_VERSION,
    moderation: moderationResult.status === "fulfilled" ? "ok" : "failed",
    vision: images.length === 0
      ? "skipped"
      : (visionResult.status === "fulfilled" ? "ok" : "failed"),
    video: videoFrames.length === 0
      ? "skipped"
      : (videoResult.status === "fulfilled" ? "ok" : "failed"),
    academic: (visionResult.status === "fulfilled" || videoResult.status === "fulfilled") ? "ok" : "failed",
  };

  if (moderationResult.status === "fulfilled") {
    anySucceeded = true;
    const moderation = moderationResult.value;

    for (const result of moderation.results || []) {
      if (result.flagged) flagged = true;

      for (const [category, isFlagged] of Object.entries(result.categories || {})) {
        if (isFlagged) reasons.add(CATEGORY_LABELS[category] || category);
      }

      for (const [category, score] of Object.entries(result.category_scores || {})) {
        if (typeof score === "number") {
          scores[category] = Math.max(scores[category] || 0, score);
        }
      }
    }
  } else {
    const message = errorText(moderationResult.reason);
    console.error("Moderation pass failed:", message);
    checks.moderationError = message;
  }

  if (visionResult.status === "fulfilled" && visionResult.value) {
    anySucceeded = true;
    const gemini = visionResult.value;
    if (gemini.flagged) flagged = true;
    gemini.reasons.forEach(reason => reasons.add(reason));
    academic = gemini.academic;
  } else if (visionResult.status === "rejected") {
    const message = errorText(visionResult.reason);
    console.error("Gemini pass failed:", message);
    checks.visionError = message;
  }

  if (videoResult.status === "fulfilled" && videoResult.value) {
    anySucceeded = true;
    const video = videoResult.value;
    if (video.flagged) flagged = true;
    video.reasons.forEach(reason => reasons.add(reason));
    if (video.academic.relevant !== null) academic = video.academic;
  } else if (videoResult.status === "rejected" && videoFrames.length > 0) {
    const message = errorText(videoResult.reason);
    console.error("Gemini video pass failed:", message);
    checks.videoError = message;
  }

  if (!anySucceeded) {
    return json({ error: "The safety service is unavailable right now.", checks }, 502);
  }

  if (flagged && reasons.size === 0) {
    reasons.add("Potentially inappropriate content");
  }

  return json({ flagged, reasons: [...reasons], categories: scores, academic, checks });
});

async function runModeration(apiKey: string, text: string, images: string[]) {
  const input: Array<Record<string, unknown>> = [];
  if (text.trim()) {
    input.push({ type: "text", text });
  }
  for (const image of images) {
    input.push({ type: "image_url", image_url: { url: image } });
  }

  const resp = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "omni-moderation-latest", input }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`OpenAI moderation ${resp.status}: ${detail.slice(0, 300)}`);
  }

  return await resp.json() as {
    results?: Array<{
      flagged?: boolean;
      categories?: Record<string, boolean>;
      category_scores?: Record<string, number>;
    }>;
  };
}

async function classifyUpload(apiKey: string, text: string, images: string[]): Promise<GeminiVerdict> {
  const parts: Array<Record<string, unknown>> = [
    { text: "Analyze this student upload for school safety and academic relevance." },
  ];

  if (text.trim()) {
    parts.push({ text: `Upload text and details:\n${text.slice(0, 4000)}` });
  }

  for (const image of images) {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(image);
    if (!match) continue;
    parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
  }

  if (parts.length === 1) {
    throw new Error("No usable upload data.");
  }

  return runGeminiVerdict(apiKey, VISION_PROMPT, parts);
}

async function classifyVideo(apiKey: string, text: string, videos: VideoSample[]): Promise<GeminiVerdict> {
  const parts: Array<Record<string, unknown>> = [
    { text: "Analyze these sampled frames from a student video for school safety and academic relevance." },
  ];

  if (text.trim()) {
    parts.push({ text: `Upload text and details:\n${text.slice(0, 3000)}` });
  }

  videos.forEach((video, videoIndex) => {
    const duration = video.duration > 0 ? ` (about ${video.duration} seconds long)` : "";
    parts.push({
      text: `Video ${videoIndex + 1}: "${video.name}"${duration}. The frames below are in chronological order.`,
    });
    video.frames.forEach((frame, frameIndex) => {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(frame);
      if (!match) return;
      parts.push({ text: `Frame ${frameIndex + 1} of ${video.frames.length}` });
      parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
    });
  });

  return runGeminiVerdict(apiKey, VIDEO_PROMPT, parts);
}

async function runGeminiVerdict(
  apiKey: string,
  systemPrompt: string,
  parts: Array<Record<string, unknown>>,
): Promise<GeminiVerdict> {
  let model = Deno.env.get("GEMINI_MODEL") || DEFAULT_GEMINI_MODEL;

  let data: GeminiResponse | undefined;
  let lastError: unknown;
  const tried = new Set<string>();

  for (let attempt = 1; attempt <= 3; attempt++) {
    tried.add(model);
    try {
      data = await requestGemini(apiKey, model, systemPrompt, parts);
      break;
    } catch (err) {
      lastError = err;
      const status = (err as Error & { status?: number }).status;
      const timedOut = (err as Error | undefined)?.name === "TimeoutError";
      const hint = (err as Error & { modelHint?: string }).modelHint;

      if (status === 404 && hint && !tried.has(hint)) {
        console.warn(`Gemini model "${model}" unavailable, retrying with "${hint}"`);
        model = hint;
        continue;
      }

      if (status === 404) {
        throw err;
      }

      const transient = timedOut || status === 429 || status === 500 || status === 502 || status === 503;
      if (transient && attempt < 3) {
        if (attempt === 2 && !tried.has(FALLBACK_GEMINI_MODEL)) {
          model = FALLBACK_GEMINI_MODEL;
        }
        console.warn(`Gemini ${timedOut ? "timeout" : status} on attempt ${attempt}, retrying with "${model}"`);
        await new Promise(resolve => setTimeout(resolve, attempt * 500));
        continue;
      }

      throw err;
    }
  }

  if (!data) {
    throw lastError instanceof Error ? lastError : new Error("Gemini did not return a response.");
  }

  const finishReason = String(data.candidates?.[0]?.finishReason || "");
  const blockReason = String(data.promptFeedback?.blockReason || "");

  if (/SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII/i.test(finishReason) || blockReason) {
    return {
      flagged: true,
      reasons: ["The content was blocked by the safety filter."],
      academic: { relevant: null, reason: null },
    };
  }

  let raw = (data.candidates?.[0]?.content?.parts || [])
    .map((part: { text?: string }) => part.text || "")
    .join("")
    .trim();

  if (!raw) {
    throw new Error("Gemini returned an empty response.");
  }

  raw = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

  let parsed: { flagged?: boolean; categories?: unknown; reasons?: unknown; academic?: { relevant?: unknown; reason?: unknown } };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Gemini returned invalid JSON.");
  }

  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.filter((r): r is string => typeof r === "string" && r.trim() !== "").slice(0, 6)
    : [];

  const categories = Array.isArray(parsed.categories)
    ? parsed.categories.filter((c): c is string => typeof c === "string")
    : [];

  let academicRelevant: boolean | null = null;
  let academicReason: string | null = null;
  if (parsed.academic && typeof parsed.academic === "object") {
    if (typeof parsed.academic.relevant === "boolean") {
      academicRelevant = parsed.academic.relevant;
    }
    if (typeof parsed.academic.reason === "string" && parsed.academic.reason.trim()) {
      academicReason = parsed.academic.reason.trim().slice(0, 200);
    }
  }

  return {
    flagged: parsed.flagged === true || categories.length > 0,
    reasons,
    academic: { relevant: academicRelevant, reason: academicReason },
  };
}

async function requestGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  parts: Array<Record<string, unknown>>,
): Promise<GeminiResponse> {
  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 1000,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: "LOW" },
      },
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    const err = new Error(`Gemini vision ${resp.status}: ${detail.slice(0, 300)}`) as Error & { status?: number; modelHint?: string };
    err.status = resp.status;
    err.modelHint = /use models\/([a-z0-9.\-]+)/i.exec(detail)?.[1];
    throw err;
  }

  return await resp.json();
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function errorText(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message
    .replace(/key=[^&\s"']+/gi, "key=***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .slice(0, 220);
}
