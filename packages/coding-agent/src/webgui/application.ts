import type { BrowserConnection } from "../dev-workbench/server";
import type { WebGuiSocketData } from "./rpc-server";

export type OmpWebSocketData = BrowserConnection | WebGuiSocketData;
