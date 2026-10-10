export function GET() {
  return Response.json({ ok: true, provider: process.env.GEMMA_PROVIDER ?? "unset" });
}
