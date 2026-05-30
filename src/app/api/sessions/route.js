import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { analyzeSession, parseSessionJson, SESSION_SCHEMA } from "../../../lib/tracking-analysis.mjs";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 2_000_000;

function responseJson(body, init = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

function sessionIdFor(session) {
  const key = [
    session.startedAt ?? "",
    session.exportedAt ?? "",
    session.ua ?? "",
    session.holds?.length ?? 0,
  ].join("|");
  return createHash("sha256").update(key || JSON.stringify(session)).digest("hex").slice(0, 16);
}

async function persistDevSession(id, session, analysis) {
  if (process.env.DIBH_SESSION_STORE === "off") {
    return { mode: "off" };
  }

  const canWriteFile =
    process.env.DIBH_SESSION_STORE === "file" || process.env.NODE_ENV !== "production";
  if (!canWriteFile) {
    console.log(
      "[dibh-session]",
      id,
      JSON.stringify({
        startedAt: session.startedAt,
        trackingConfidence: analysis.trackingConfidence,
        issueCounts: analysis.issueCounts,
        recommendations: analysis.recommendations.map((item) => item.code),
      }),
    );
    return { mode: "log-only" };
  }

  const dir = process.env.DIBH_SESSION_DIR || join(process.cwd(), ".data", "dibh-sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.session.json`), JSON.stringify(session, null, 2));
  await writeFile(join(dir, `${id}.analysis.json`), JSON.stringify(analysis, null, 2));
  return { mode: "file", dir };
}

export async function POST(req) {
  const text = await req.text();
  const bodyBytes = Buffer.byteLength(text, "utf8");
  if (bodyBytes > MAX_BODY_BYTES) {
    return responseJson(
      {
        ok: false,
        error: "Payload too large.",
        maxBytes: MAX_BODY_BYTES,
        receivedBytes: bodyBytes,
      },
      { status: 413 },
    );
  }

  try {
    const session = parseSessionJson(text);
    const analysis = analyzeSession(session);
    const id = sessionIdFor(session);
    const storage = await persistDevSession(id, session, analysis);
    return responseJson({ ok: true, id, storage, analysis });
  } catch (error) {
    return responseJson(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 400 },
    );
  }
}

export async function GET() {
  return responseJson({
    ok: true,
    endpoint: "/api/sessions",
    accepts: SESSION_SCHEMA,
    returns: "dibh-tracking-analysis/v1",
    storage:
      process.env.NODE_ENV === "production"
        ? "production logs only unless DIBH_SESSION_STORE=file is configured"
        : ".data/dibh-sessions/*.json",
  });
}
