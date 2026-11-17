// Sending through Resend (notify.cyberx.la). Shared by the quote functions.

export type Outgoing = { from: string; to: string[]; cc?: string[]; reply_to?: string; subject: string; html: string; text: string; tag?: string };

/** Sends one email; returns Resend's id, or throws with a short reason. */
export async function sendEmail(apiKey: string | undefined, m: Outgoing): Promise<string> {
  if (!apiKey) throw new Error("email isn't set up (the RESEND_API_KEY secret is missing)");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: m.from, to: m.to, cc: m.cc?.length ? m.cc : undefined, reply_to: m.reply_to, subject: m.subject, html: m.html, text: m.text,
      tags: m.tag ? [{ name: "kind", value: m.tag }] : undefined,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    let why = `Resend answered ${res.status}`;
    try {
      const j = await res.json();
      if (j?.message) why += `: ${String(j.message).slice(0, 160)}`;
    } catch {
      // not JSON
    }
    throw new Error(why);
  }
  return String((await res.json())?.id ?? "");
}
