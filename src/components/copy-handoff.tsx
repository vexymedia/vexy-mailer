"use client";

import { useState } from "react";

/**
 * Zkopíruje souhrn příležitosti do schránky.
 *
 * Předání klientovi je dneska e-mail nebo zpráva, ne API. Tohle je proto
 * nejkratší cesta od „vidím jednání" k „poslal jsem ho obchodníkovi",
 * bez nového exportu a bez klientského portálu.
 */
export function CopyHandoff({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="btn-secondary !px-2.5 !py-1 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Prohlížeč schránku odmítl (starší, nebo bez HTTPS). Tichý
          // neúspěch je lepší než hláška, se kterou uživatel nic neudělá -
          // text je stejně celý vidět na stránce.
        }
      }}
    >
      {copied ? "Zkopírováno" : "Kopírovat souhrn"}
    </button>
  );
}
