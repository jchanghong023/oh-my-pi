import { useId, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { useAIReqDataSource } from "./data-source.js";

export function AIReqEmployeePicker({ value, onChange, required = false, ownerIds = [] }: { value: string; onChange(value: string): void; required?: boolean; ownerIds?: readonly string[] }) {
  const source = useAIReqDataSource();
  const id = useId();
  const [search, setSearch] = useState("");
  const directory = source.employeeDirectory;
  const normalized = search.trim().toLocaleLowerCase();
  const entries = directory?.entries.filter(entry => `${entry.employeeId} ${entry.name} ${entry.department}`.toLocaleLowerCase().includes(normalized)) ?? [];
  const knownIds = [...new Set(ownerIds)].filter(employeeId => !directory?.entries.some(entry => entry.employeeId === employeeId) && employeeId.toLocaleLowerCase().includes(normalized));
  return <div className="space-y-2">
    <Label htmlFor={id}>IR 负责人工号</Label>
    <Input id={id} value={value} onChange={event => onChange(event.target.value)} placeholder="例如 j00808875，可直接输入" required={required} pattern={required ? "[a-z][0-9]{8}" : undefined} aria-describedby={`${id}-help`} />
    <p id={`${id}-help`} className="text-ui-xs text-foreground-subtle">{required ? "一个小写字母后接 8 位数字；符合格式但未收录的工号也可保存。" : "按 IR 负责人工号精确筛选，不按 SR 开发人员匹配。"}工号及目录选择均不代表身份核验。</p>
    <Label htmlFor={`${id}-search`}>{directory ? source.provenance.kind === "sample" ? "检索样例目录（工号／姓名／部门）" : "检索人员目录（工号／姓名／部门）" : "检索当前 IR 工号"}</Label>
    <Input id={`${id}-search`} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} placeholder={directory ? "输入工号、姓名或部门" : "输入工号"} />
    <p className="text-ui-xs text-foreground-subtle">{directory ? source.provenance.kind === "sample" ? "仅为原型样例目录，姓名、部门均为虚构样例，未连接真实人员 API。" : "人员目录由当前后台提供；目录选择不代表身份核验。" : "当前数据源未提供可用人员目录，无法按姓名或部门查询或核验身份；可直接输入工号。"}</p>
    {(directory || knownIds.length > 0) && <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-border p-1" role="group" aria-label="IR负责人工号候选">
      {entries.map(entry => <Button key={entry.employeeId} type="button" variant={value.trim() === entry.employeeId ? "secondary" : "ghost"} className="h-auto w-full justify-start whitespace-normal py-2 text-left" onClick={() => onChange(entry.employeeId)}><span><span className="font-mono">{entry.employeeId}</span> · {entry.name} · {entry.department}</span></Button>)}
      {knownIds.map(employeeId => <Button key={employeeId} type="button" variant={value.trim() === employeeId ? "secondary" : "ghost"} className="h-auto w-full justify-start whitespace-normal py-2 text-left" onClick={() => onChange(employeeId)}><span><span className="font-mono">{employeeId}</span> · 当前 IR 工号（未核验身份）</span></Button>)}
      {!entries.length && !knownIds.length && <p role="status" className="p-2 text-ui-xs text-foreground-subtle">未找到候选；仍可直接输入工号，不限制为目录人员。</p>}
    </div>}
  </div>;
}
