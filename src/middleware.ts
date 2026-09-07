import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * Coarse gate only. The middleware runs on the Edge runtime where node:crypto
 * is unavailable, so it checks for the mere presence of a session cookie and
 * leaves signature verification to the pages and actions themselves
 * (`requireAuth`), which run on Node.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/cron",
  "/u/", // public one-click unsubscribe
  "/_next",
  // Next's generated metadata routes. Without these the icon request is
  // redirected to /login, which the browser then fails to parse as an image.
  "/favicon",
  "/icon",
  "/apple-icon",
  "/robots.txt",
  "/sitemap.xml",
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  if (!request.cookies.get(SESSION_COOKIE)?.value) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon|apple-icon).*)"],
};
