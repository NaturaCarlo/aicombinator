export const dynamic = "force-dynamic";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://api.aicombinator.live";

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ slug: string; path?: string[] }>;
  },
): Promise<Response> {
  const { slug, path } = await context.params;
  const requestedPath = path && path.length > 0 ? path.join("/") : "index.html";

  const response = await fetch(
    `${API_URL}/api/public/${slug}/file?path=${encodeURIComponent(requestedPath)}`,
    {
      cache: "no-store",
    },
  );

  if (!response.ok) {
    return new Response("Not found", {
      status: response.status === 404 ? 404 : 502,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const headers = new Headers();
  headers.set(
    "Content-Type",
    response.headers.get("Content-Type") || "text/html; charset=utf-8",
  );
  headers.set(
    "Content-Disposition",
    response.headers.get("Content-Disposition") || "inline",
  );
  headers.set("Cache-Control", "no-store");

  return new Response(response.body, {
    status: 200,
    headers,
  });
}
