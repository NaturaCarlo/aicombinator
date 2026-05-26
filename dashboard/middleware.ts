import { NextResponse } from "next/server";
import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/company/(.*)",
  "/companies",
  "/site(.*)",
  "/terms",
  "/privacy",
]);

export default clerkMiddleware(async (auth, req) => {
  const hostedSlug = hostedCompanySlug(req.headers.get("host"));
  if (hostedSlug) {
    const rewriteUrl = req.nextUrl.clone();
    const path = req.nextUrl.pathname === "/" ? "" : req.nextUrl.pathname;
    rewriteUrl.pathname = `/site/${hostedSlug}${path}`;
    return NextResponse.rewrite(rewriteUrl);
  }

  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};

function hostedCompanySlug(hostHeader: string | null): string | null {
  const host = (hostHeader || "").split(":")[0].toLowerCase();
  if (!host.endsWith(".aicombinator.live")) {
    return null;
  }
  if (
    host === "aicombinator.live"
    || host === "www.aicombinator.live"
    || host === "api.aicombinator.live"
  ) {
    return null;
  }

  return host.replace(/\.aicombinator\.live$/, "");
}
