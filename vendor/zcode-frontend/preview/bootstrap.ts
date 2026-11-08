import "core-js/stable";
import { ResizeObserver } from "@juggle/resize-observer";

if (!globalThis.ResizeObserver) globalThis.ResizeObserver = ResizeObserver;

