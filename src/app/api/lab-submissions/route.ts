import { createHash, timingSafeEqual } from "node:crypto";

import { put } from "@vercel/blob";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 4_000_000;

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function safeSegment(value: unknown, fallback: string) {
  const cleaned = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || fallback;
}

function accessCodeMatches(received: string | null, expected: string) {
  const receivedHash = createHash("sha256").update(received ?? "").digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(receivedHash, expectedHash);
}

export async function GET() {
  return json({
    ok: true,
    configured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    accessCodeRequired: Boolean(process.env.DIBH_LAB_ACCESS_CODE),
    maxBytes: MAX_BODY_BYTES,
  });
}

export async function POST(request: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json(
      {
        ok: false,
        error: "Central collection is not configured yet.",
        downloadFallback: true,
      },
      503,
    );
  }

  const expectedAccessCode = process.env.DIBH_LAB_ACCESS_CODE;
  if (
    expectedAccessCode &&
    !accessCodeMatches(request.headers.get("x-dibh-study-code"), expectedAccessCode)
  ) {
    return json({ ok: false, error: "The study access code is not valid." }, 401);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "This trace is too large to submit." }, 413);
  }

  const raw = await request.text();
  const bodyBytes = Buffer.byteLength(raw, "utf8");
  if (bodyBytes > MAX_BODY_BYTES) {
    return json({ ok: false, error: "This trace is too large to submit." }, 413);
  }

  let recording: Record<string, unknown>;
  try {
    recording = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "The submitted trace is not valid JSON." }, 400);
  }

  const contributor = recording.contributor as Record<string, unknown> | undefined;
  if (
    recording.schema !== "dibh-lab/v3" ||
    typeof recording.sessionId !== "string" ||
    !Array.isArray(recording.samples) ||
    !Array.isArray(recording.events) ||
    typeof contributor?.participantCode !== "string" ||
    !contributor.participantCode.trim()
  ) {
    return json({ ok: false, error: "The submitted file is not a complete DIBH Lab trace." }, 400);
  }

  const receivedAt = new Date().toISOString();
  const checksum = createHash("sha256").update(raw).digest("hex");
  const submissionId = `lab-${receivedAt.slice(0, 10).replaceAll("-", "")}-${safeSegment(recording.sessionId, "session").slice(0, 12)}`;
  const storedRecording = {
    ...recording,
    submission: {
      id: submissionId,
      receivedAt,
      checksumSha256: checksum,
      storage: "vercel-blob-private",
    },
  };
  const participant = safeSegment(contributor.participantCode, "participant");
  const date = receivedAt.slice(0, 10);
  const pathname = `lab-submissions/${date}/${participant}/${submissionId}.json`;

  try {
    await put(pathname, JSON.stringify(storedRecording), {
      access: "private",
      addRandomSuffix: false,
      contentType: "application/json",
    });
    return json({ ok: true, id: submissionId, receivedAt, bytes: bodyBytes });
  } catch (error) {
    console.error("[lab-submission] storage failed", error);
    return json(
      {
        ok: false,
        error: "The trace could not be stored. Please download the JSON backup.",
        downloadFallback: true,
      },
      502,
    );
  }
}
