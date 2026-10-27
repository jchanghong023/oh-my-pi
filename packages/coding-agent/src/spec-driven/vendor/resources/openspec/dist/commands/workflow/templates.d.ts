/**
 * Templates Command
 *
 * Shows resolved template paths for all artifacts in a schema.
 */
export interface TemplatesOptions {
    schema?: string;
    json?: boolean;
}
export interface TemplateInfo {
    artifactId: string;
    templatePath: string;
    source: 'project' | 'user' | 'package';
}
export declare function templatesCommand(options: TemplatesOptions): Promise<void>;
//# sourceMappingURL=templates.d.ts.map