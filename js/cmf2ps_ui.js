import { app } from "../../../scripts/app.js";

(() => {
  const params = new URLSearchParams(window.location.search);
  // Ключ для хранения ID конкретного встроенного окна ComfyUI.
  // sessionStorage переживает reload, но не передаётся другим вкладкам.
  const CLIENT_ID_STORAGE_KEY = "cmf2ps_ui_client_id";
  // При первом открытии Photoshop передаёт уникальный ID в адресе страницы.
  const clientIdFromUrl = params.get("cmf2ps_client");
  // Здесь будет ID, сохранённый до перезагрузки страницы.
  let storedClientId = null;

  try {
    // Восстанавливаем ID, если текущий URL уже не содержит параметр.
    storedClientId = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (clientIdFromUrl) {
      // Запоминаем ID из Photoshop для последующих полных refresh.
      window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, clientIdFromUrl);
    }
  } catch (e) {
    // Не прерываем работу, если среда webview отключила sessionStorage.
    console.warn("[CMF2PS_UI] sessionStorage is unavailable", e);
  }

  // Приоритет: ID из URL -> сохранённый ID -> запасной ID для обычного ComfyUI.
  const clientId = clientIdFromUrl || storedClientId || "ui_default";

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
        // Явно добавляем ID в URL: ComfyUI не сможет потерять его при reload.
        const reloadUrl = new URL(window.location.href);
        reloadUrl.searchParams.set("cmf2ps_client", clientId);
        // replace не создаёт лишнюю запись в истории браузера webview. Заменяем на ранее сохраненный параметр
        window.location.replace(reloadUrl.toString());
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
