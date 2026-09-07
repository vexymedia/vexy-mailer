import Link from "next/link";
import { getSettings } from "@/lib/settings";

/**
 * Deliberately loud in both directions. The dangerous state is not "test mode
 * on" - it is being wrong about which mode you are in, so both are stated
 * explicitly on every page.
 */
export async function TestModeBanner() {
  const settings = await getSettings();

  if (!settings.test_mode) {
    return (
      <div className="border-b border-red-200 bg-red-600 px-4 py-2 text-center text-sm font-medium text-white">
        LIVE SENDING — test mode is off. Emails go to real contacts.{" "}
        <Link href="/settings" className="underline underline-offset-2">
          Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="border-b border-amber-200 bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">
      <span className="font-semibold">TEST MODE</span>{" "}
      {settings.test_behavior === "simulate"
        ? "— nothing is sent to any SMTP server; sends are only logged."
        : `— every email is redirected to ${settings.test_email}.`}{" "}
      <Link href="/settings" className="underline underline-offset-2">
        Settings
      </Link>
    </div>
  );
}
