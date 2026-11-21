/** Route a disposable extension's native messaging frames to its fixture relay, without registering an OS native host. */
export function relayNativePortFixture(port: number): string {
	return `chrome.runtime.connectNative = () => {
  const messages = [];
  const disconnects = [];
  let socket;
  const deliver = frame => { for (const listener of messages) listener(frame); };
  return {
    onMessage: { addListener: listener => messages.push(listener) },
    onDisconnect: { addListener: listener => disconnects.push(listener) },
    disconnect: () => socket?.close(),
    postMessage(frame) {
      if (frame.t === "link") {
        socket = new WebSocket("ws://127.0.0.1:${port}/ext");
        socket.onopen = () => deliver({ t: "linked" });
        socket.onmessage = event => deliver({ t: "relay", line: event.data });
        socket.onclose = () => { for (const listener of disconnects) listener(); };
      } else if (frame.t === "relay") {
        socket.send(frame.line);
      }
    }
  };
};\n`;
}
