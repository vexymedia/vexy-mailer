import { redirect } from "next/navigation";

/** Sekce se jmenuje Tým — VEXY nepředpokládá, že každý člověk je caller. */
export default function CalleriRedirect() {
  redirect("/tym");
}
