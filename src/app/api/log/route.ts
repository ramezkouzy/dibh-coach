// Lab data sink. The /lab page POSTs JSON traces here and we mirror them
// to the Vercel runtime logs for offline analysis. Stream the output with
//   vercel logs --follow https://dibh-coach.vercel.app
// from a developer machine. Body size is intentionally not parsed/validated;
// keep payloads small (~50KB or fewer samples).

export const runtime = "nodejs";

export async function POST(req: Request) {
  const text = await req.text();
  // Tag with a clear prefix so we can grep for it in the log stream.
  // eslint-disable-next-line no-console
  console.log("[lab-trace]", text.length, "bytes:", text);
  return new Response(JSON.stringify({ ok: true, bytes: text.length }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function GET() {
  return new Response("Lab log endpoint. POST JSON traces here.", {
    status: 200,
  });
}
