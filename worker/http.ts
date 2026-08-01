export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function methodNotAllowed(...allowed: string[]): Response {
  return json(
    { error: "method_not_allowed" },
    { status: 405, headers: { allow: allowed.join(", ") } },
  );
}

export function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error(error);
  return json({ error: "internal_error", message }, { status: 500 });
}
