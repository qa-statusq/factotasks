"use client";

/**
 * Branded LAST-RESORT error screen: rendered only when the ROOT layout itself
 * throws — the one crash error.tsx cannot catch. Next would otherwise show its
 * unbranded white "Application error" page. Everything is inline and
 * self-contained (own <html>/<body>, no Tailwind, no imports from the UI kit):
 * when this renders, the design pipeline may be part of what just broke.
 */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const S = {
    body: {
      margin: 0,
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#f7f7f5",
      color: "#0f172a",
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      textAlign: "center" as const,
      padding: "24px",
    },
    h1: { fontSize: "22px", letterSpacing: "-0.02em", margin: "20px 0 8px", fontWeight: 600 },
    p: { color: "#475569", fontSize: "14px", lineHeight: 1.55, maxWidth: "380px", margin: "0 auto" },
    row: { marginTop: "26px", display: "flex", flexWrap: "wrap" as const, gap: "10px", justifyContent: "center" },
    primary: {
      font: "inherit",
      fontWeight: 600,
      fontSize: "14px",
      color: "#fff",
      background: "#059669",
      border: 0,
      borderRadius: "12px",
      padding: "10px 20px",
      cursor: "pointer",
    },
    secondary: {
      font: "inherit",
      fontWeight: 600,
      fontSize: "14px",
      color: "#0f172a",
      background: "#fff",
      border: "1px solid #e3e8ee",
      borderRadius: "12px",
      padding: "10px 20px",
      cursor: "pointer",
    },
  };
  // The anchor form: same box, minus the browser's link underline/colour, and
  // laid out so its text centres exactly like the button beside it.
  const S2 = {
    // Same large brand-coloured numeral as not-found.tsx / error.tsx, hand-rolled
    // in inline CSS because this screen must not depend on the stylesheet.
    code: {
      margin: 0,
      font: "inherit",
      fontSize: "72px",
      fontWeight: 700,
      lineHeight: 1,
      letterSpacing: "-0.05em",
      color: "#059669",
      fontVariantNumeric: "tabular-nums" as const,
      userSelect: "none" as const,
    },
    secondaryLink: {
      ...S.secondary,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      textDecoration: "none",
      lineHeight: 1.2,
    },
  };
  return (
    <html lang="en">
      <body style={S.body}>
        <main role="alert">
          {/* One large brand numeral — same treatment as not-found.tsx and
              error.tsx so all three failure screens read as one family. */}
          <p aria-hidden="true" style={S2.code}>
            500
          </p>
          <h1 style={S.h1}>Something went wrong</h1>
          <p style={S.p}>
            FactoTasks hit an unexpected error. Your data is safe on the server — trying again usually fixes it.
          </p>
          <div style={S.row}>
            <button style={S.primary} onClick={() => reset()}>
              Try again
            </button>
            {/* An anchor, not a scripted navigation: the ROOT layout has crashed
                here, so this is the least trustworthy place in the app to rely
                on JavaScript running correctly. A plain href needs none. */}
            <a style={S2.secondaryLink} href="/">
              Go to dashboard
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
