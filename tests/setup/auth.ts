import { createClerkClient } from "@clerk/backend";

let cachedToken: string | null = null;

export async function getTestToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY is required in .env.test");
  }

  const userId = process.env.TEST_USER_ID;
  if (!userId) {
    throw new Error("TEST_USER_ID is required in .env.test");
  }

  const clerk = createClerkClient({ secretKey });

  // Find an active session for the test user
  const sessions = await clerk.sessions.getSessionList({ userId, status: "active" });

  if (sessions.data.length === 0) {
    throw new Error(
      `No active Clerk session for user ${userId}. ` +
      `Sign in as the test user at the dashboard first to create a session.`
    );
  }

  // Get a JWT from the first active session
  const sessionToken = await clerk.sessions.getToken(sessions.data[0].id, "");
  cachedToken = sessionToken.jwt;
  return cachedToken;
}

export function clearTokenCache(): void {
  cachedToken = null;
}
