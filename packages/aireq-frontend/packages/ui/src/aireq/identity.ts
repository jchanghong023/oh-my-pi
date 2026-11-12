// Display identity is not authentication; the standalone server injects request-local context.
let employeeId = "";
let employeeIdProvider: (() => string) | undefined;
export function setEmployeeIdProvider(provider: () => string): void { employeeIdProvider = provider; }
export function getEmployeeId(): string { return employeeIdProvider ? employeeIdProvider() : employeeId; }
export function setEmployeeId(value: string): void { employeeId = value; }
export function isEmployeeId(value: string): boolean { return /^[a-z][0-9]{8}$/.test(value); }
