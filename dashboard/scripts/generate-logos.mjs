#!/usr/bin/env node

/**
 * Generate minimalistic startup logos for all AIC companies
 * using OpenRouter's Nano Banana (Gemini 2.5 Flash Image) model.
 *
 * Usage: node scripts/generate-logos.mjs
 */

import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

const API_KEY = process.env.OPENROUTER_API_KEY;

if (!API_KEY) {
  throw new Error("OPENROUTER_API_KEY is required");
}
const MODEL = "google/gemini-2.5-flash-image";
const OUTPUT_DIR = path.resolve("public/logos");

const SYSTEM_PROMPT = `You are a world-class logo designer. Design a minimalistic, modern startup logo icon.

Rules:
- The logo should be a simple ICON/SYMBOL only — NO text, NO company name, NO letters, NO words
- Use a clean white or very light (#FAFAFA) background
- The icon should be geometric, minimal, and instantly recognizable at 64x64px
- Use bold, flat colors — no gradients, no shadows, no 3D effects
- Think like the best Silicon Valley brand designers: Stripe, Linear, Notion, Figma
- The icon should subtly hint at what the company does
- Style: flat vector illustration, 2-3 colors maximum
- The icon should be centered and take up about 60-70% of the canvas
- Square aspect ratio`;

const COMPANIES = [
  { slug: "resumeai", name: "ResumeAI", hint: "AI resume builder — document/page icon" },
  { slug: "taxchain", name: "TaxChain", hint: "Crypto tax calculator — chain links or calculator" },
  { slug: "pagerank-pro", name: "PageRank Pro", hint: "SEO audit tool — magnifying glass or chart" },
  { slug: "mealmind", name: "MealMind", hint: "AI meal planner — plate or leaf" },
  { slug: "remotefirst", name: "RemoteFirst", hint: "Remote job board — globe or location pin" },
  { slug: "shoplaunch", name: "ShopLaunch", hint: "E-commerce store builder — shopping bag or rocket" },
  { slug: "linguaflash", name: "LinguaFlash", hint: "Language learning flashcards — speech bubble or flash" },
  { slug: "plantdoc", name: "PlantDoc", hint: "Plant care app — leaf or plant" },
  { slug: "invoicebot", name: "InvoiceBot", hint: "Invoicing for freelancers — receipt or dollar sign" },
  { slug: "headshotai", name: "HeadshotAI", hint: "AI headshot generator — camera or portrait silhouette" },
  { slug: "launchpage", name: "LaunchPage", hint: "Landing page generator — browser window or rocket" },
  { slug: "tutormatch", name: "TutorMatch", hint: "Tutoring marketplace — graduation cap or book" },
  { slug: "cookswap", name: "CookSwap", hint: "Social recipe platform — cooking pot or utensils" },
  { slug: "pipelinepro", name: "PipelinePro", hint: "CRM for freelancers — funnel or pipeline flow" },
];

async function generateLogo(company) {
  const prompt = `Design a minimalistic startup logo icon for a company called "${company.name}". The company is: ${company.hint}. Remember: icon/symbol ONLY, no text whatsoever.`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      modalities: ["image", "text"],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content || !Array.isArray(content)) {
    console.error("Unexpected response shape:", JSON.stringify(data, null, 2));
    throw new Error("No content array in response");
  }

  // Find the image part
  for (const part of content) {
    if (part.type === "image_url" && part.image_url?.url) {
      const dataUrl = part.image_url.url;
      // data:image/png;base64,...
      const match = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
      if (match) {
        const ext = match[1] === "jpeg" ? "jpg" : match[1];
        const buffer = Buffer.from(match[2], "base64");
        return { buffer, ext };
      }
    }
  }

  console.error("Response content:", JSON.stringify(content, null, 2));
  throw new Error("No image found in response");
}

async function main() {
  if (!existsSync(OUTPUT_DIR)) {
    await mkdir(OUTPUT_DIR, { recursive: true });
  }

  console.log(`Generating logos for ${COMPANIES.length} companies...\n`);

  for (const company of COMPANIES) {
    const outPath = path.join(OUTPUT_DIR, `${company.slug}.png`);

    // Skip if already exists
    if (existsSync(outPath)) {
      console.log(`  ✓ ${company.name} — already exists, skipping`);
      continue;
    }

    process.stdout.write(`  ⏳ ${company.name}...`);

    try {
      const { buffer, ext } = await generateLogo(company);
      const finalPath = path.join(OUTPUT_DIR, `${company.slug}.${ext}`);
      await writeFile(finalPath, buffer);
      console.log(` ✓ saved (${(buffer.length / 1024).toFixed(0)}KB)`);
    } catch (err) {
      console.log(` ✗ FAILED: ${err.message}`);
    }

    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
