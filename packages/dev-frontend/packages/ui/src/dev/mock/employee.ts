// 仅用于前端原型身份标记；工号不是身份验证凭据。
let employeeId = "";
export function getPrototypeEmployeeId(): string { return employeeId; }
export function setPrototypeEmployeeId(value: string): void { employeeId = value; }
export function isPrototypeEmployeeId(value: string): boolean { return /^j[0-9]{8}$/.test(value); }
