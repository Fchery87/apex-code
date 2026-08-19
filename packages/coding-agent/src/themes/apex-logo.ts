/**
 * Pre-rendered ASCII versions of the Apex Code peak mark.
 *
 * Three variants cover the terminals we render into:
 * - the half-block peak is the brand mark, used whenever the terminal is wide
 *   enough and block glyphs are in play;
 * - the compact peak keeps a mark on screen in narrow terminals rather than
 *   truncating the full one mid-glyph;
 * - the ASCII peak honours `terminal.symbolPreset: "ascii"`, whose users opted
 *   out of block drawing because it renders badly for them.
 *
 * All three are rendered in a single flat tone by the header. A flat tone is
 * what makes the mark read as a mark rather than as decoration.
 */

/** 10 rows x 34 cols. The default brand mark — half-block peak with a hollow summit. */
export const APEX_PEAK_LOGO = ` ▄▄▄▄▄  ▄▄▄▄▄▄  ▄▄▄▄▄▄ ▄▄   ▄▄
██   ██ ██   ██ ██      ██ ██ 
███████ ██████  █████    ███  
██   ██ ██      ██      ██ ██ 
▀▀   ▀▀ ▀▀      ▀▀▀▀▀▀ ▀▀   ▀▀`;

/** 6 rows x 18 cols. Same silhouette for terminals too narrow for the full mark. */
export const APEX_PEAK_LOGO_COMPACT = ` ▄▄▄▄▄ 
██   ██
███████
██   ██
▀▀   ▀▀`;

/** 9 rows x 19 cols. Line-drawing fallback for `symbolPreset: "ascii"`. */
export const APEX_PEAK_LOGO_ASCII = `  _   _  ____ __ 
 / \\ |_) |__  \\/ 
 \\_/ |   |___ /\\ `;
