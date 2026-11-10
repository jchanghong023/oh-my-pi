// Browser display identity only; never an authentication credential or OMP profile setting.
let employeeId = "";
export function getEmployeeId(): string { return employeeId; }
export function setEmployeeId(value: string): void { employeeId = value; }
export function isEmployeeId(value: string): boolean { return /^j[0-9]{8}$/.test(value); }
