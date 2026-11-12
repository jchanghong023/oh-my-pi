import { useAIReqDataSource } from "./data-source.js";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ArrowRight, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { getEmployeeId, isEmployeeId, setEmployeeId as setBrowserEmployeeId } from "./identity.js";

interface AIReqIdentity { employeeId: string; signOut(): void }
const AIReqIdentityContext = createContext<AIReqIdentity | null>(null);
export function useAIReqIdentity(): AIReqIdentity | null { return useContext(AIReqIdentityContext); }
const identityKey = "employee-id";
function restoreIdentity(): string {
 let value = "";
 try { value = globalThis.__ompAIReqSessionStorage.getItem(identityKey) ?? ""; } catch { /* 存储不可用时仍允许本页进入。 */ }
 setBrowserEmployeeId(isEmployeeId(value) ? value : "");
 return getEmployeeId();
}

/** Browser display identity only; it never authenticates or switches the OMP service account. */
export function AIReqEntry({ children }: { children: ReactNode }) {
 const source = useAIReqDataSource();
 const [employeeId, setEmployeeId] = useState(restoreIdentity);
 const [value, setValue] = useState("");
 const [error, setError] = useState("");
 const [readyIdentity, setReadyIdentity] = useState("");
 useEffect(() => {
  let active = true;
  setReadyIdentity("");
  if (!employeeId) return () => { active = false; };
  void Promise.resolve(source.refreshIdentity?.()).then(() => { if (active) setReadyIdentity(employeeId); }, cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
  return () => { active = false; };
 }, [source, employeeId]);
 const enter = () => {
  const next = value.trim();
  if (!isEmployeeId(next)) { setError("请输入 a–z 中任一小写字母开头、后接 8 位数字的工号，例如 j00808874。"); return; }
  setBrowserEmployeeId(next);
  try { globalThis.__ompAIReqSessionStorage.setItem(identityKey, next); } catch { /* 本页内存继续使用。 */ }
  setEmployeeId(next);
 };
 const signOut = () => {
  try { globalThis.__ompAIReqSessionStorage.removeItem(identityKey); } catch { /* 本页内存仍清除。 */ }
  setBrowserEmployeeId(""); setEmployeeId(""); setValue(""); setError("");
 };
 if (employeeId && readyIdentity !== employeeId) return <main className="min-h-dvh bg-background px-4 py-4 text-foreground md:px-6 md:py-6"><div className="mx-auto w-full min-w-0 max-w-4xl space-y-4"><p role={error ? "alert" : "status"}>{error || "正在连接 AIReq 后端…"}</p>{error && <Button onClick={signOut}>返回登录</Button>}</div></main>;
 if (employeeId) return <AIReqIdentityContext.Provider key={employeeId} value={{ employeeId, signOut }}>{children}</AIReqIdentityContext.Provider>;
 return <main className="dark theme-zai-dark flex min-h-dvh flex-col bg-background text-foreground" style={{ colorScheme: "dark" }} data-testid="aireq-entry">
  <header className="flex items-center gap-2 px-8 py-6"><span className="text-ui-base font-semibold tracking-wide">OMP</span><span className="text-ui-sm text-foreground-subtle">AIReq</span></header>
  <div className="flex flex-1 items-center justify-center px-8 pb-24">
   <section className="w-full max-w-sm space-y-8" aria-labelledby="aireq-entry-title">
    <div className="space-y-3"><div className="mb-5 flex size-11 items-center justify-center rounded-xl border border-border bg-surface"><UserRound className="size-5 text-foreground-subtle" strokeWidth={1.5} /></div><h1 id="aireq-entry-title" className="text-3xl font-semibold tracking-tight"><span className="inline-block">以AI为中心的</span><span className="inline-block">需求和ISSUE管理平台</span></h1><p className="text-ui-base leading-6 text-foreground-subtle">与团队一起澄清需求、评审方案和跟踪需求和issue进度</p></div>
    <form className="space-y-5" onSubmit={event => { event.preventDefault(); enter(); }} noValidate>
     <div className="space-y-2"><Label htmlFor="aireq-employee-id">工号</Label><Input id="aireq-employee-id" value={value} onChange={event => { setValue(event.target.value); setError(""); }} placeholder="例如 j00808874" autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} className="h-10 w-full" aria-invalid={Boolean(error)} aria-describedby={error ? "aireq-employee-help aireq-employee-error" : "aireq-employee-help"} /><p id="aireq-employee-help" className="text-ui-sm text-foreground-subtle">a–z 中任一小写字母开头，后接 8 位数字；无需密码。</p>{error && <p id="aireq-employee-error" role="alert" className="text-ui-sm text-destructive">{error}</p>}</div>
     <Button type="submit" className="h-10 w-full justify-center gap-2">进入工作台<ArrowRight className="size-4" /></Button>
    </form>
    <p className="text-ui-sm leading-6 text-foreground-subtle">{source.provenance.kind === "sample" ? "当前为后端内存样例，刷新保留，后端重启恢复；不连接团队数据库。工号仅作操作标识，不验证身份，也不切换 Web 所有者或模型凭据。" : "工号仅作本浏览器显示标记，不验证员工身份，也不会改变 OMP 的服务账号、配置或权限。"}</p>
   </section>
  </div>
  {source.provenance.kind === "sample" && <footer className="px-8 py-5 text-center text-ui-sm text-foreground-subtlest">AIReq 原型 · 数据仅作演示</footer>}
 </main>;
}
