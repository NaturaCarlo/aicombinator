/**
 * Profile enrichment: look up a user's X/Twitter profile and use Gemini
 * to determine their country, language, and interests.
 *
 * Called asynchronously after user.created webhook when the user signed up via X.
 */

import type { Env } from "../types.js";

export interface EnrichedProfile {
  country: string;        // ISO 3166-1 alpha-2 (e.g. "IT", "US", "JP")
  countryName: string;    // Full name (e.g. "Italy")
  language: string;       // Primary language (e.g. "Italian", "English")
  interests: string[];    // Detected interests
  profileSummary: string; // Short bio summary
}

export interface XProfileData {
  handle: string;
  displayName: string;
  bio: string;
  avatarUrl: string;
  location: string;
  followersCount: number;
}

/**
 * Extract X/Twitter profile data from Clerk webhook payload.
 */
export function extractXProfile(eventData: any): XProfileData | null {
  const externalAccounts = eventData.external_accounts || [];
  const xAccount = externalAccounts.find(
    (acc: any) => acc.provider === "x" || acc.provider === "oauth_x" || acc.provider === "twitter" || acc.provider === "oauth_twitter",
  );
  if (!xAccount) return null;

  return {
    handle: xAccount.username || "",
    displayName: [xAccount.first_name, xAccount.last_name].filter(Boolean).join(" ") || xAccount.username || "",
    bio: xAccount.public_metadata?.bio || "",
    avatarUrl: xAccount.image_url || xAccount.avatar_url || "",
    location: xAccount.public_metadata?.location || "",
    followersCount: xAccount.public_metadata?.followers_count || 0,
  };
}

/**
 * Use Gemini to analyze the X profile and determine country, language, interests.
 */
export async function enrichProfileWithGemini(
  xProfile: XProfileData,
  env: Env,
): Promise<EnrichedProfile> {
  const prompt = `Analyze this X/Twitter profile and determine the person's nationality and background.

Profile:
- Handle: @${xProfile.handle}
- Display Name: ${xProfile.displayName}
- Bio: ${xProfile.bio || "(no bio)"}
- Location: ${xProfile.location || "(not set)"}
- Followers: ${xProfile.followersCount}

Based on the name, handle, bio, location, and any cultural cues, determine:
1. Their most likely country (ISO 3166-1 alpha-2 code and full name)
2. Their primary language
3. Their interests (as a JSON array of strings)
4. A one-sentence profile summary

Respond in EXACTLY this JSON format, nothing else:
{
  "country": "US",
  "countryName": "United States",
  "language": "English",
  "interests": ["technology", "startups"],
  "profileSummary": "A tech entrepreneur based in Silicon Valley."
}`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-preview:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      }),
    },
  );

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${errText}`);
  }

  const result = await resp.json() as any;
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("No text in Gemini response");

  // Parse JSON from response (strip markdown fences if present)
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  return JSON.parse(cleaned) as EnrichedProfile;
}

/**
 * Run the full enrichment pipeline: extract X data → Gemini analysis → save to D1.
 */
export async function enrichUserProfile(
  userId: string,
  eventData: any,
  env: Env,
): Promise<void> {
  const xProfile = extractXProfile(eventData);
  if (!xProfile || !xProfile.handle) {
    // No X account — create a minimal profile with pending status
    await env.DB.prepare(
      `INSERT INTO user_profiles (user_id, enrichment_status) VALUES (?, 'failed')
       ON CONFLICT(user_id) DO NOTHING`,
    ).bind(userId).run();
    return;
  }

  // Create initial profile row with X data
  await env.DB.prepare(
    `INSERT INTO user_profiles (user_id, x_handle, x_display_name, x_bio, x_avatar_url, x_location, x_followers_count, enrichment_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')
     ON CONFLICT(user_id) DO UPDATE SET
       x_handle = excluded.x_handle,
       x_display_name = excluded.x_display_name,
       x_bio = excluded.x_bio,
       x_avatar_url = excluded.x_avatar_url,
       x_location = excluded.x_location,
       x_followers_count = excluded.x_followers_count,
       enrichment_status = 'processing',
       updated_at = datetime('now')`,
  ).bind(
    userId,
    xProfile.handle,
    xProfile.displayName,
    xProfile.bio || null,
    xProfile.avatarUrl || null,
    xProfile.location || null,
    xProfile.followersCount || 0,
  ).run();

  try {
    // Run Gemini enrichment
    const enriched = await enrichProfileWithGemini(xProfile, env);

    // Save enriched data
    await env.DB.prepare(
      `UPDATE user_profiles SET
         country = ?,
         country_name = ?,
         language = ?,
         interests = ?,
         profile_summary = ?,
         enrichment_status = 'complete',
         enrichment_error = NULL,
         enriched_at = datetime('now'),
         updated_at = datetime('now')
       WHERE user_id = ?`,
    ).bind(
      enriched.country,
      enriched.countryName,
      enriched.language,
      JSON.stringify(enriched.interests),
      enriched.profileSummary,
      userId,
    ).run();
  } catch (err: any) {
    // Mark enrichment as failed
    await env.DB.prepare(
      `UPDATE user_profiles SET
         enrichment_status = 'failed',
         enrichment_error = ?,
         updated_at = datetime('now')
       WHERE user_id = ?`,
    ).bind(err.message || "Unknown error", userId).run();
    console.error(`Profile enrichment failed for ${userId}:`, err);
  }
}
