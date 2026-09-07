import { NextResponse, type NextRequest } from "next/server";
import { dispatchTick } from "@/lib/engine/dispatch";
import { pollReplies } from "@/lib/engine/replies";
import { safeEqual } from "@/lib/crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The worker tick. One call does one dispatcher pass and, at most every
 * REPLY_POLL_INTERVAL_MS per mailbox, one IMAP poll.
 *
 * Designed to be driven by anything that can make an HTTP request once a
 * minute: Vercel Cron, cron-job.org, a GitHub Actions schedule, or a shell
 * loop. Every operation is idempotent, so an extra or a missed call is
 * harmless - it is safe to hammer this endpoint.
 */

function authorise(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ") && safeEqual(header.slice(7), secret)) return true;

  // Convenience for external cron services that cannot set headers.
  const query = request.nextUrl.searchParams.get("secret");
  return Boolean(query && safeEqual(query, secret));
}

async function handle(request: NextRequest) {
  if (!authorise(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  try {
    // Dispatch first: sending is time-sensitive, reply polling is not.
    const dispatch = await dispatchTick();
    const replies = await pollReplies();
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - started,
      dispatch,
      replies,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[cron] tick failed", error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
