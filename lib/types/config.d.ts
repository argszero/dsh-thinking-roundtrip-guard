/**
 * Configuration, normalized once at mount.
 *
 * Four questions an operator asks about a plugin that repairs a request: *which
 * way should it repair* (`mode`), *which routes may it touch* (`providers`),
 * *what text stands in for reasoning the session never recorded* (`placeholder`),
 * and *what should it do when the provider still rejects the repaired request*
 * (`escalate`).
 *
 * Deliberately **not** exported as the plugin's `Config`: cordis validates a
 * mounted plugin's `Config` through `Config['~standard'].validate`, and a plain
 * defaults object has no `~standard`. Exporting one is how this repository's
 * plugins have died at mount with `Cannot read properties of undefined (reading
 * 'validate')`; the entry point therefore exports `{ name, inject, apply }` and
 * these defaults arrive through `apply(ctx, config = {})`.
 *
 * A bad value never stops the mount: it falls back to the default and is
 * reported by name through `snapshot().notes`, because a guard that refused to
 * load would leave the session in exactly the state it was installed to fix.
 *
 * @module @argszero/dsh-thinking-roundtrip-guard/config
 */
/**
 * What the plugin does with a history that is missing thinking blocks.
 *
 * - `synthesize` (the default) inserts the missing block into the request so the
 *   turn can be replayed with thinking still enabled.
 * - `degrade` sends the request with reasoning effort `off`, which is the shape a
 *   thinking-disabled route accepts — measured to be accepted with the same
 *   tool-call history that fails when thinking is enabled.
 * - `observe` counts exactly what `synthesize` would repair and changes nothing.
 * - `off` installs no listener at all.
 */
export type GuardMode = 'synthesize' | 'degrade' | 'observe' | 'off';
/** The plugin configuration as a user writes it. */
export interface Config {
    /** How to repair; see {@link GuardMode}. Defaults to `synthesize`. */
    readonly mode?: GuardMode;
    /**
     * Provider route names this plugin may touch. Defaults to
     * `['deepseek-official']` — the route the reported failure came from. An empty
     * list means every route, which is only sensible when every route speaks the
     * Messages dialect that requires thinking blocks back.
     */
    readonly providers?: readonly string[];
    /**
     * Text of the synthesized reasoning block. It must be non-empty: an empty
     * thinking block is a separate rejection this repository has already shipped a
     * guard for (#9239), and a placeholder that says nothing would reintroduce it.
     */
    readonly placeholder?: string;
    /**
     * When a repair is rejected with a provider 400 before any content was
     * emitted, retry the same history with reasoning effort `off` instead of
     * failing the turn. Defaults to `true`; only meaningful in `synthesize` mode.
     */
    readonly escalate?: boolean;
    /** Log a line per repaired request at `debug`, and the mount summary at `info`. */
    readonly report?: boolean;
}
/** The configuration with every default resolved. */
export interface Settings {
    readonly mode: GuardMode;
    /** Route names allowed, in the order the operator wrote them; empty means all. */
    readonly providers: readonly string[];
    readonly placeholder: string;
    readonly escalate: boolean;
    readonly report: boolean;
    /** Configuration values that were refused, with the value the plugin used instead. */
    readonly notes: readonly string[];
}
/**
 * The default placeholder.
 *
 * It says what happened rather than pretending to be reasoning: the turn was
 * produced somewhere its thinking could not be replayed, and the block exists so
 * the tool call that follows can be sent at all.
 */
export declare const DEFAULT_PLACEHOLDER = "This turn was produced on a route that did not record its reasoning for replay, so this block stands in for it and the tool call below can still be sent.";
/** The defaults, also the fallbacks used per field. */
export declare const defaultConfig: Required<Config>;
/**
 * Resolve one configuration object, recording every value that had to be
 * replaced.
 * @param config - what the operator wrote; `undefined` means the defaults.
 * @returns the resolved settings and the notes describing refused values.
 */
export declare function normalizeConfig(config: Config | undefined): Settings;
//# sourceMappingURL=config.d.ts.map