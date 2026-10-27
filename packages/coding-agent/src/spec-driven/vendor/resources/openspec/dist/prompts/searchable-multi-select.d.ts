interface Choice {
    name: string;
    value: string;
    /**
     * Extra terms the search box matches, for choices users look for by a word
     * the name does not spell (see #653). Never rendered.
     */
    searchAliases?: string[];
    description?: string;
    configured?: boolean;
    detected?: boolean;
    configuredLabel?: string;
    preSelected?: boolean;
}
interface Config {
    message: string;
    choices: Choice[];
    pageSize?: number;
    validate?: (selected: string[]) => boolean | string;
    /** Shown when a search matches nothing, so the list is not a dead end. */
    emptyHint?: string;
}
/**
 * A searchable multi-select prompt with visible search box,
 * selected items display, and intuitive keyboard navigation.
 *
 * - Type to filter choices
 * - ↑↓ to navigate
 * - Space to toggle highlighted item selection
 * - Backspace to remove last selected item (or delete search char)
 * - Enter to confirm selections
 */
export declare function searchableMultiSelect(config: Config): Promise<string[]>;
export default searchableMultiSelect;
//# sourceMappingURL=searchable-multi-select.d.ts.map