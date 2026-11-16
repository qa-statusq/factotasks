/** Theme constants shared by the server layout and the client switcher. */
export type Theme = "light" | "dark" | "system";
export const THEMES: Theme[] = ["light", "dark", "system"];
export const THEME_COOKIE = "ft_theme";
/** Browser-chrome tint per theme: the canvas colour of each palette. */
export const THEME_COLORS = { light: "#f7f7f5", dark: "#121211" } as const;
export const isTheme = (v: unknown): v is Theme => v === "light" || v === "dark" || v === "system";
