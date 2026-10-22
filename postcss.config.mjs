/**
 * Tailwind v4 moves the Tailwind PostCSS plugin into its own package, and
 * handles vendor prefixing itself (Lightning CSS) — so autoprefixer is gone
 * rather than merely unused.
 * @type {import('postcss-load-config').Config}
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
