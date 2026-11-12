import { UserRound } from "lucide-react";
import defaultAvatar from "@/assets/avatars/default-programmer.png";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";

/** Local default avatar; an explicit user image takes precedence. */
export function DefaultAvatar({ src }: { src?: string }) {
  return <Avatar size="default">
    <AvatarImage src={src || defaultAvatar} alt="" />
    <AvatarFallback className="bg-background text-foreground"><UserRound className="size-4" /></AvatarFallback>
  </Avatar>;
}
