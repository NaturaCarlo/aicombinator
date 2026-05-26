import { test as setup } from "@playwright/test";
import { createClerkClient } from "@clerk/backend";

const APP_BASE_URL = process.env.APP_BASE_URL || "https://aicombinator.live";

setup("authenticate via Clerk session cookie", async ({ page }) => {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const userId = process.env.TEST_USER_ID;

  if (!secretKey || !userId) {
    throw new Error("CLERK_SECRET_KEY and TEST_USER_ID required in .env.test");
  }

  const clerk = createClerkClient({ secretKey });
  const signInToken = await clerk.signInTokens.createSignInToken({
    userId,
    expiresInSeconds: 300,
  });

  await page.goto(APP_BASE_URL);
  await page.waitForFunction(() => window.Clerk !== undefined && window.Clerk.loaded);

  await page.evaluate(async (ticket) => {
    const clerk = window.Clerk;
    if (!clerk?.client) {
      throw new Error("Clerk client unavailable");
    }

    const result = await clerk.client.signIn.create({
      strategy: "ticket",
      ticket,
    });

    if (result.status !== "complete" || !result.createdSessionId) {
      throw new Error(`Ticket sign-in failed: ${result.status}`);
    }

    await clerk.setActive({
      session: result.createdSessionId,
    });
  }, signInToken.token);

  await page.waitForFunction(() => window.Clerk?.user !== null);
  await page.waitForLoadState("networkidle");

  await page.context().storageState({ path: "tests/.auth/user.json" });
});
