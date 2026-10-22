import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

/**
 * ESLint flat config.
 *
 * Replaces `next lint`, which Next 15.5 deprecated and 16 removed. Before this
 * file existed the `lint` script was worse than missing: with no config on disk,
 * `next lint` dropped into an INTERACTIVE setup prompt, so it hung forever
 * anywhere non-interactive and never actually linted anything.
 *
 * Next 16 no longer runs ESLint inside `next build`, so `npm run verify` is now
 * the ONLY thing standing between a lint error and a deploy — keep running it.
 *
 * The shared configs are spread DIRECTLY rather than adapted through
 * @eslint/eslintrc's FlatCompat. eslint-config-next 16 ships native flat-config
 * arrays, and putting those back through the eslintrc compatibility layer made
 * ESLint crash outright ("Converting circular structure to JSON" — its config
 * validator JSON.stringify's a plugin object that references itself). Importing
 * them as what they already are removes both the crash and the @eslint/eslintrc
 * dependency (which also carried the only remaining transitive engine warning).
 */
const config = [
  {
    // Build output, deps and generated route types are not ours to lint. The
    // .next/types entry matters: those files are GENERATED from the route tree,
    // so a stale one (a route deleted since the last build) would report errors
    // about source that no longer exists.
    ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    rules: {
      // Deliberately-unused bindings are written `_name` throughout this
      // codebase (e.g. destructuring a field off an object to drop it), which is
      // the intent, not an oversight.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // THE ROOT-LAYOUT ERROR BOUNDARY IS THE ONE PLACE THIS RULE IS WRONG.
    //
    // no-html-link-for-pages exists to stop an <a> throwing away a client-side
    // navigation. global-error.tsx renders only when the ROOT LAYOUT ITSELF has
    // thrown, and there a soft navigation is not merely unnecessary — it is
    // actively the wrong behaviour: <Link href="/"> would re-mount that same
    // broken root layout inside the same JavaScript context and crash straight
    // back to this screen, leaving the user with no way out. A full document
    // load re-renders from the server and is the only escape that can actually
    // work. The <a> is the fix, not a shortcut around one.
    //
    // Scoped to this ONE file and this ONE rule, and stated here rather than as
    // an inline eslint-disable so the reasoning is reviewable in the config.
    // src/app/error.tsx — where only a route segment failed and the router is
    // still alive — correctly uses next/link.
    files: ["src/app/global-error.tsx"],
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
  {
    // Node-side maintenance scripts: not browser code, and they intentionally
    // log to stdout — that is their entire user interface.
    files: ["scripts/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
];

// Named, not an anonymous array literal — import/no-anonymous-default-export.
export default config;
