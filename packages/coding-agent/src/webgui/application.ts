import type { BrowserConnection } from "../aireq-workbench/server";
import type { WebGuiSocketData } from "./rpc-server";

export type OmpWebSocketData = BrowserConnection | WebGuiSocketData;
