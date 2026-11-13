import { UserRound } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";

/** Local default avatar; an explicit user image takes precedence. 内置头像用图标，避免首屏下载大图。 */
export function DefaultAvatar({ src }: { src?: string }) {
  return <Avatar size="default">
    {src ? <AvatarImage src={src} alt="" /> : null}
    <AvatarFallback className="bg-background text-foreground"><UserRound className="size-4" /></AvatarFallback>
  </Avatar>;
}
