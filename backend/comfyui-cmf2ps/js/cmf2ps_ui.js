import { app } from "../../../scripts/app.js";

(() => {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("cmf2ps_client") || "ui_default";

  // UI открыт из самого Comfy, поэтому websocket цепляем к текущему host, а не к localhost.
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const WS_URL = `${wsProtocol}//${window.location.host}/cmf2ps/ws?platform=ui&client_id=${encodeURIComponent(clientId)}`;

  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let isConnecting = false;

  function scheduleReconnect() {
    if (reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWs();
    }, reconnectDelay);

    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  }

  function connectWs() {
    if (isConnecting) return;
    if (
      ws &&
      (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    isConnecting = true;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("[CMF2PS_UI] ws connected", clientId);
      isConnecting = false;
      reconnectDelay = 1000;

      try {
        ws.send(JSON.stringify({ type: "hello" }));
      } catch (e) {
        console.warn("[CMF2PS_UI] hello send failed", e);
      }
    };

    ws.onmessage = async (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg?.type === "ping") {
        try {
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {}
        return;
      }

      if (msg?.type === "refresh_inputs") {
        await app.refreshComboInNodes?.();
        return;
      }

      if (msg?.type === "refresh_inputs_full") {
        window.location.reload();
        return;
      }

      if (msg?.type !== "generate") return;

      try {
        if (typeof app?.queuePrompt === "function") {
          await app.queuePrompt();
        }
      } catch (e) {
        console.error("[CMF2PS_UI] queuePrompt failed", e);
      }
    };

    ws.onerror = (e) => {
      console.warn("[CMF2PS_UI] ws error", e);
    };

    ws.onclose = () => {
      console.warn("[CMF2PS_UI] ws closed, reconnecting...");
      isConnecting = false;
      scheduleReconnect();
    };
  }

  connectWs();
})();
