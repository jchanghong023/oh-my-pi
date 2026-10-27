export interface StoreSetupOptions {
    path?: string;
    initGit?: boolean;
    json?: boolean;
    remote?: string;
}
export interface StoreRegisterOptions {
    id?: string;
    yes?: boolean;
    json?: boolean;
}
export interface StoreRemoveOptions {
    yes?: boolean;
    json?: boolean;
}
export interface StoreJsonOptions {
    json?: boolean;
}
export declare class StoreCommand {
    setup(id: string | undefined, options?: StoreSetupOptions): Promise<void>;
    register(inputPath: string | undefined, options?: StoreRegisterOptions): Promise<void>;
    unregister(id: string, options?: StoreJsonOptions): Promise<void>;
    remove(id: string, options?: StoreRemoveOptions): Promise<void>;
    list(options?: StoreJsonOptions): Promise<void>;
    doctor(id: string | undefined, options?: StoreJsonOptions): Promise<void>;
    private handleFailure;
}
//# sourceMappingURL=store.d.ts.map