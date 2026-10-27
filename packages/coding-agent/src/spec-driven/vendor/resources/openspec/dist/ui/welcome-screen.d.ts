/**
 * Animated welcome screen for the experimental artifact workflow setup.
 * Shows side-by-side layout with animated ASCII art on left and welcome text on right.
 */
/**
 * Best-effort check of the OS-level reduced-motion preference (#722).
 * Any lookup failure (missing binary, unset key, timeout) means
 * "no preference detected" and animation stays enabled.
 */
export declare function prefersReducedMotion(platform?: NodeJS.Platform): boolean;
/**
 * Shows the animated welcome screen.
 * Returns when user presses Enter.
 */
export declare function showWelcomeScreen(workflows: readonly string[], options?: {
    animate?: boolean;
}): Promise<void>;
//# sourceMappingURL=welcome-screen.d.ts.map