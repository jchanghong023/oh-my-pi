import { useDevDataSource } from "./data-source.js";
import { useState } from "react";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useDev } from "./DevContext.js";

/** Reuses the existing collaboration dialog; no remote transport or extra chat surface. */
export function DevCollabProjection({ iconOnly = false }: { iconOnly?: boolean }) {
 const source = useDevDataSource();
  const dev = useDev()!;
  const theme = useZCodeStore(state => state.theme);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [peerId, setPeerId] = useState("");
  const [materialPath, setMaterialPath] = useState("");
  const [tab, setTab] = useState<"materials" | "logs">("materials");
  const peers = source.collaboration?.peers(dev.selection.projectId) ?? [];
  const visiblePeers = peers.filter(peer => `${peer.name} ${peer.role}`.includes(query));
  const peer = peers.find(item => item.id === peerId);
  const material = peer?.materials.find(item => item.path === materialPath) ?? peer?.materials[0];
  if (source.mode !== "prototype" || !source.collaboration) return null;
  return <>
    <Button size={iconOnly ? "icon-sm" : "sm"} variant="ghost" className={iconOnly ? "shrink-0" : "ml-auto shrink-0 gap-1.5"} title="协作" aria-label="协作成员与共享材料（样例）" data-testid="collab-open" onClick={() => setOpen(true)}>
      <Users className="size-3.5" />{!iconOnly && <>协作<span className="text-foreground-subtle">{peers.length}</span></>}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[90dvh] max-w-[min(1200px,96vw)] flex-col gap-0 p-0" data-testid="dev-collab-projection">
        <header className="border-b border-border px-4 py-3 pr-12">
          <DialogTitle>协作成员与共享材料</DialogTitle>
          <DialogDescription>阶段性前端原型：成员、在线状态、材料与日志均为本地样例；不会连接远程用户或修改当前讨论。</DialogDescription>
          {peer && <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span data-testid="collab-capability">只读样例 · {peer.name} · {peer.role}</span>
            <Button size="sm" variant="outline" data-testid="collab-leave" onClick={() => { setPeerId(""); setMaterialPath(""); }}>取消选择</Button>
          </div>}
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <section className={`w-full shrink-0 overflow-y-auto border-b border-border p-3 sm:max-h-none sm:w-60 sm:border-r sm:border-b-0 ${peer ? "max-h-36" : "max-h-64"}`} aria-label="协作成员样例">
            <Input data-testid="collab-link" aria-label="筛选样例成员" placeholder="筛选成员或角色" value={query} onChange={event => setQuery(event.target.value)} />
            <div className="mt-3 space-y-1">
              {visiblePeers.map(item => <Button key={item.id} variant={peer?.id === item.id ? "secondary" : "ghost"}
                className="h-auto w-full justify-start py-3 text-left" data-testid="collab-join" data-peer-id={item.id}
                onClick={() => { setPeerId(item.id); setMaterialPath(""); }}>
                <span><span className="block font-medium">{item.name} · {item.role}</span><small className="text-foreground-subtle">{item.status}</small></span>
              </Button>)}
              {!visiblePeers.length && <p className="p-2 text-sm text-foreground-subtle">没有匹配的样例成员。</p>}
            </div>
          </section>
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            {!peer ? <p className="p-5 text-sm text-foreground-subtle">选择样例成员，查看共享材料与协作记录。该操作不会加入真实会话。</p> : <>
              <nav className="flex gap-2 border-b border-border p-3" aria-label="协作资料">
                <Button size="sm" variant={tab === "materials" ? "secondary" : "ghost"} onClick={() => setTab("materials")}>共享材料（{peer.materials.length}）</Button>
                <Button size="sm" variant={tab === "logs" ? "secondary" : "ghost"} onClick={() => setTab("logs")}>协作日志</Button>
              </nav>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {tab === "logs" ? <ul className="space-y-3" data-testid="collab-agents">{peer.logs.map(log => <li key={log.id} className="rounded-lg border border-border p-3 text-sm">
                  <small className="text-foreground-subtle">{log.time} · {peer.name}</small><p className="mt-1">{log.text}</p>
                </li>)}</ul> : <>
                  <div className="mb-4 flex flex-wrap gap-2">{peer.materials.map(item => <Button key={item.path} size="sm"
                    variant={material?.path === item.path ? "secondary" : "outline"} onClick={() => setMaterialPath(item.path)}>{item.title}</Button>)}</div>
                  {material && <article className="rounded-xl border border-border p-4">
                    <p className="mb-3 break-all text-xs text-foreground-subtle">{material.path} · 只读样例</p>
                    <MessageResponse className="min-w-0 break-words" theme={theme}>{material.content}</MessageResponse>
                  </article>}
                </>}
              </div>
            </>}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
