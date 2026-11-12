import { useAIReqDataSource } from "./data-source.js";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { TriangleAlertIcon, UserRound } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { ThemeHeroVisual } from "@/openWorkspacePageThemeHero.js";
import { useTheme } from "@/useTheme.js";
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
 return <AIReqLoginScreen value={value} error={error} onValueChange={next => { setValue(next); setError(""); }} onEnter={enter} />;
}

function AIReqLoginScreen({ value, error, onValueChange, onEnter }: {
 value: string; error: string; onValueChange(value: string): void; onEnter(): void;
}) {
 const { theme } = useTheme();
 return <main className="relative h-full min-h-dvh overflow-hidden bg-background text-foreground" data-testid="aireq-entry">
  <ThemeHeroVisual theme={theme} className="pointer-events-none absolute inset-0" />
  <div className="relative z-10 flex h-dvh flex-col items-center overflow-y-auto px-4 pb-6 pt-14 sm:px-6">
   <div className="flex w-full flex-1 shrink-0 items-center justify-center py-6">
    <section className="flex w-full max-w-md shrink-0 flex-col gap-7 rounded-2xl bg-background p-8 text-ui-base/relaxed shadow-md sm:p-10" aria-labelledby="aireq-entry-title">
     <header className="flex flex-col items-center gap-4 text-center">
      <div className="relative flex size-16 items-center justify-center rounded-2xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-white shadow-lg/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl before:border before:border-[rgba(255,255,255,0.1)]" aria-hidden="true"><UserRound className="size-8" strokeWidth={1.5} /></div>
      <div className="flex flex-col items-center gap-1 text-center">
       <h1 id="aireq-entry-title" className="text-ui-xl font-semibold tracking-tight">以AI为中心的需求和ISSUE管理平台</h1>
       <p className="text-ui-base/relaxed text-foreground-subtle">与团队一起澄清需求、评审方案和跟踪需求和issue进度</p>
      </div>
     </header>
     <form className="space-y-4" onSubmit={event => { event.preventDefault(); onEnter(); }} noValidate>
      <div className="space-y-2">
       <Label htmlFor="aireq-employee-id" className="text-ui-base font-medium">工号</Label>
       <Input id="aireq-employee-id" size="lg" value={value} onChange={event => onValueChange(event.target.value)} placeholder="例如 j00808874" autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} className="h-10 w-full text-ui-base" aria-invalid={Boolean(error)} aria-describedby={error ? "aireq-employee-help aireq-employee-error" : "aireq-employee-help"} />
       <p id="aireq-employee-help" className="text-ui-sm text-foreground-subtle">a–z 中任一小写字母开头，后接 8 位数字；无需密码。</p>
      </div>
      {error && <Alert variant="destructive" id="aireq-employee-error"><TriangleAlertIcon className="size-4" /><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex flex-col items-center gap-2"><Button type="submit" size="lg" disabled={!value.trim()} className="h-10 w-fit min-w-50 px-6 text-ui-base font-medium">进入工作台</Button></div>
     </form>
    </section>
   </div>
   <footer className="flex shrink-0 flex-col items-center gap-2 text-center text-ui-xs text-foreground-subtle">
    <p>工号仅用于操作标识，不验证员工身份。</p>
    <p>OMP · AIReq</p>
   </footer>
  </div>
 </main>;
}
