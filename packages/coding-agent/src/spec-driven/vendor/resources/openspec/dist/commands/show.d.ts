interface ShowExecuteOptions {
    json?: boolean;
    type?: string;
    noInteractive?: boolean;
    store?: string;
    storePath?: string;
    [k: string]: any;
}
export declare class ShowCommand {
    execute(itemName?: string, options?: ShowExecuteOptions): Promise<void>;
    private normalizeType;
    private delegateOptions;
    private runInteractiveByType;
    private showDirect;
    private printNonInteractiveHint;
    private warnIrrelevantFlags;
}
export {};
//# sourceMappingURL=show.d.ts.map