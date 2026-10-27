/** One rendering for zod issues across every state/config parser. */
export function formatZodIssues(error, fallbackLocation = 'root') {
    return error.issues
        .map((issue) => {
        const location = issue.path.length > 0 ? issue.path.join('.') : fallbackLocation;
        return `${location}: ${issue.message}`;
    })
        .join('; ');
}
//# sourceMappingURL=zod-issues.js.map