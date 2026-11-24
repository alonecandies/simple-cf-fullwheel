import type { PagesEnvironment } from "../types";

export const onRequest: PagesFunction<PagesEnvironment> = async ({ request, env }) => {
  const response = await env.APP.fetch(request);
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.pathname !== "/api/config" ||
    !response.ok ||
    !env.WEB_ANALYTICS_TOKEN
  ) {
    return response;
  }

  try {
    const config = (await response.clone().json()) as Record<string, unknown>;
    const headers = new Headers(response.headers);
    headers.delete("Content-Length");
    headers.set("Content-Type", "application/json; charset=utf-8");
    return new Response(
      JSON.stringify({ ...config, webAnalyticsToken: env.WEB_ANALYTICS_TOKEN }),
      { status: response.status, statusText: response.statusText, headers },
    );
  } catch {
    return response;
  }
};
