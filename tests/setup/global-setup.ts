import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup(): Promise<void> {
  // Load .env.test
  dotenv.config({ path: path.resolve(__dirname, "../.env.test") });

  const required = ["API_BASE_URL", "TEST_COMPANY_ID", "TEST_USER_ID", "CLERK_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars in tests/.env.test: ${missing.join(", ")}\n` +
      `Copy .env.test.example to .env.test and fill in the values.`
    );
  }

  // Verify API is reachable
  const apiUrl = process.env.API_BASE_URL!;
  try {
    const res = await fetch(`${apiUrl}/health`);
    if (!res.ok) {
      throw new Error(`API health check returned ${res.status}`);
    }
    console.log(`✓ API reachable at ${apiUrl}`);
  } catch (err) {
    throw new Error(`Cannot reach API at ${apiUrl}: ${err}`);
  }
}
