// Is quote email set up (the RESEND_API_KEY secret in Supabase)? Until it is,
// quotes show Publish and no Send. Asked at most every five minutes; null means
// the answer isn't known (no connection), and is asked again next time.
import db from "$db";

let asked: { at: number; ready: Promise<boolean | null> } | null = null;

export function emailStatus(): Promise<boolean | null> {
  if (!asked || Date.now() - asked.at > 5 * 60_000) {
    const ready = db.quoteAction({ action: "status" }).then(
      (s) => s.email === true,
      () => { asked = null; return null; },
    );
    asked = { at: Date.now(), ready };
  }
  return asked.ready;
}
