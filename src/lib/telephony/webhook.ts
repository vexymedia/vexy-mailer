import type { NextRequest } from "next/server";
import { twilioConfig, verifyTwilioSignature } from "./twilio";

/**
 * Společná část všech Twilio webhooků: přečíst formulářová data a ověřit,
 * že je opravdu poslalo Twilio.
 *
 * Bez ověření podpisu by kdokoli, kdo zná URL, mohl tvrdit, že hovor
 * skončil, nebo podstrčit odkaz na cizí nahrávku. Endpointy jsou veřejné
 * (Twilio se nepřihlašuje), takže podpis je jediná ochrana, kterou mají.
 */

export interface WebhookRequest {
  ok: true;
  params: Record<string, string>;
}
export interface WebhookRejected {
  ok: false;
  status: number;
  error: string;
}

/**
 * URL, kterou Twilio použilo k podpisu.
 *
 * Za proxy (Vercel) vidí Next interní hostname, takže se skládá z
 * PUBLIC_URL, případně z forwardovaných hlaviček. Musí sedět přesně,
 * včetně query stringu - jinak podpis nikdy nebude souhlasit.
 */
export function webhookUrl(request: NextRequest, path: string): string {
  const configured = (process.env.TWILIO_WEBHOOK_BASE_URL ?? process.env.APP_URL)?.trim();
  if (configured) {
    const base = configured.replace(/\/+$/, "");
    return `${base}${path}${request.nextUrl.search}`;
  }
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  return `${proto}://${host}${path}${request.nextUrl.search}`;
}

export async function readSignedWebhook(
  request: NextRequest,
  path: string,
): Promise<WebhookRequest | WebhookRejected> {
  let config;
  try {
    config = twilioConfig();
  } catch {
    return { ok: false, status: 503, error: "Twilio není nakonfigurované." };
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, status: 400, error: "Neplatné tělo požadavku." };
  }

  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }

  const signature = request.headers.get("x-twilio-signature");
  if (!verifyTwilioSignature(config.authToken, webhookUrl(request, path), params, signature)) {
    return { ok: false, status: 403, error: "Neplatný podpis." };
  }
  return { ok: true, params };
}
