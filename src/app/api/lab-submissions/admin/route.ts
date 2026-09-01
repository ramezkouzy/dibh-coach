import { createHash, timingSafeEqual } from "node:crypto";

import { get, list } from "@vercel/blob";

export const runtime = "nodejs";

const SUBMISSION_PREFIX = "lab-submissions/";
const MAX_LISTED_SUBMISSIONS = 1_000;

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      vary: "x-dibh-admin-key",
    },
  });
}

function secretMatches(received: string | null, expected: string) {
  const receivedHash = createHash("sha256").update(received ?? "").digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(receivedHash, expectedHash);
}

function authorize(request: Request) {
  const expected = process.env.DIBH_LAB_ADMIN_KEY;
  if (!expected) {
    return json(
      {
        ok: false,
        error: "Lab administration is not configured. Set DIBH_LAB_ADMIN_KEY in Vercel.",
      },
      503,
    );
  }

  if (!secretMatches(request.headers.get("x-dibh-admin-key"), expected)) {
    return json({ ok: false, error: "The admin password is not valid." }, 401);
  }

  return null;
}

function isSubmissionPath(pathname: string) {
  return (
    pathname.startsWith(SUBMISSION_PREFIX) &&
    pathname.endsWith(".json") &&
    !pathname.includes("..") &&
    !pathname.includes("\\")
  );
}

function downloadFilename(pathname: string) {
  const filename = pathname.split("/").at(-1) ?? "dibh-lab-submission.json";
  return filename.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export async function GET(request: Request) {
  const authorizationError = authorize(request);
  if (authorizationError) return authorizationError;

  if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
    return json({ ok: false, error: "The Vercel Blob store is not connected." }, 503);
  }

  const { searchParams } = new URL(request.url);
  const pathname = searchParams.get("pathname");

  if (pathname) {
    if (!isSubmissionPath(pathname)) {
      return json({ ok: false, error: "That submission path is not allowed." }, 400);
    }

    try {
      const result = await get(pathname, { access: "private", useCache: false });
      if (!result || result.statusCode !== 200) {
        return json({ ok: false, error: "Submission not found." }, 404);
      }

      const disposition = searchParams.get("download") === "1" ? "attachment" : "inline";
      return new Response(result.stream, {
        headers: {
          "cache-control": "private, no-store",
          "content-disposition": `${disposition}; filename="${downloadFilename(pathname)}"`,
          "content-type": result.blob.contentType || "application/json",
          etag: result.blob.etag,
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      console.error("[lab-admin] submission read failed", error);
      return json({ ok: false, error: "The submission could not be read." }, 502);
    }
  }

  try {
    const result = await list({
      prefix: SUBMISSION_PREFIX,
      limit: MAX_LISTED_SUBMISSIONS,
    });
    const submissions = result.blobs
      .filter((blob) => isSubmissionPath(blob.pathname))
      .map((blob) => ({
        pathname: blob.pathname,
        size: blob.size,
        uploadedAt: blob.uploadedAt.toISOString(),
        etag: blob.etag,
      }))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

    return json({
      ok: true,
      submissions,
      count: submissions.length,
      truncated: result.hasMore,
    });
  } catch (error) {
    console.error("[lab-admin] submission list failed", error);
    return json({ ok: false, error: "The submission list could not be loaded." }, 502);
  }
}
