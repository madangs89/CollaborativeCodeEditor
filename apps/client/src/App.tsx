import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import "./index.css";
import * as awarenessProtocol from "y-protocols/awareness.js";
const WS_URL = "ws://localhost:1234";
const ROOM_NAME = "my-code-room";

const REMOTE_ORIGIN = Symbol("remote");

enum MessageType {
  AUTH_REFRESH = 0,
  INITIAL_DOC_STATE = 1,
  YJS_UPDATE = 2,
  AWARENESS_UPDATE = 3,
}

export default function App() {
  const [status, setStatus] = useState("Connecting...");
  const [synced, setSynced] = useState(false);

  const cleanupRef = useRef<(() => void) | null>(null);

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const encodePacket = (
    typeId: number,
    metaObject: Record<string, unknown>,
    yjsBuffer?: Uint8Array | null,
  ): ArrayBuffer => {
    const jsonBytes = encoder.encode(JSON.stringify(metaObject));

    const yjsLength = yjsBuffer?.byteLength ?? 0;
    const totalLength = 1 + 4 + jsonBytes.byteLength + yjsLength;

    // Explicitly allocate an ArrayBuffer
    const packetBuffer = new ArrayBuffer(totalLength);
    const packet = new Uint8Array(packetBuffer);
    const view = new DataView(packetBuffer);

    view.setUint8(0, typeId);
    view.setUint32(1, jsonBytes.byteLength, false);

    packet.set(jsonBytes, 5);

    if (yjsBuffer && yjsLength > 0) {
      packet.set(new Uint8Array(yjsBuffer), 5 + jsonBytes.byteLength);
    }

    return packetBuffer;
  };
  // const decoder = new TextDecoder();

  const decodePacket = (
    buffer: ArrayBuffer,
  ): {
    messageType: number;
    metadata: any;
    yjsBuffer: Uint8Array;
  } => {
    if (buffer.byteLength < 5) {
      throw new Error("Packet is too short");
    }

    const view = new DataView(buffer);

    // 1. Read message type
    const messageType = view.getUint8(0);

    // 2. Read JSON length (big-endian)
    const jsonLength = view.getUint32(1, false);

    // 3. Calculate boundaries
    const jsonStart = 5;
    const jsonEnd = jsonStart + jsonLength;

    if (jsonEnd > buffer.byteLength) {
      throw new Error("Invalid JSON length");
    }

    // 4. Decode metadata
    const jsonBytes = new Uint8Array(buffer, jsonStart, jsonLength);

    const metadata = JSON.parse(decoder.decode(jsonBytes));

    // 5. Extract Yjs payload
    const yjsBuffer = new Uint8Array(buffer, jsonEnd);

    return { messageType, metadata, yjsBuffer };
  };

  const handleEditorMount: OnMount = useCallback((editor) => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("monaco");

    const awareness = new awarenessProtocol.Awareness(ydoc);

    const hue = Math.floor(Math.random() * 360);
    const color = `hsl(${hue}, 80%, 50%)`;
    const colorLight = `hsla(${hue}, 80%, 50%, 0.3)`;

    awareness.setLocalStateField("user", {
      name: "User_" + Math.floor(Math.random() * 100),
      color,
      colorLight,
    });
    const ws = new WebSocket(`${WS_URL}/${encodeURIComponent(ROOM_NAME)}`);

    ws.binaryType = "arraybuffer";

    const model = editor.getModel();

    if (!model) {
      ws.close();
      ydoc.destroy();
      awareness.destroy();
      return;
    }

    // Connect the Yjs text to the Monaco editor.
    const binding = new MonacoBinding(
      ytext,
      model,
      new Set([editor]),
      awareness,
    );

    const styleEl = document.createElement("style");
    document.head.appendChild(styleEl);

    const renderRemoteStyles = () => {
      let css = "";

      awareness.getStates().forEach((state, clientID) => {
        if (clientID === awareness.clientID) return; // skip myself
        const user = state.user;
        if (!user) return;

        const name = String(user.name).replace(/["\\]/g, "");

        css += `
      .yRemoteSelection-${clientID} {
        background-color: ${user.colorLight};
      }

      .yRemoteSelectionHead-${clientID} {
        position: absolute;
        border-left: 2px solid ${user.color};
        height: 100%;
        box-sizing: border-box;
        pointer-events: auto; /* allow hover on the cursor */
      }

      /* invisible wider hit area so hovering is easy */
      .yRemoteSelectionHead-${clientID}::before {
        content: "";
        position: absolute;
        top: 0;
        left: -5px;
        width: 12px;
        height: 100%;
        pointer-events: auto;
      }

      /* name label: hidden by default */
      .yRemoteSelectionHead-${clientID}::after {
        content: "${name}";
        position: absolute;
        top: -1.4em;
        left: -2px;
        background: ${user.color};
        color: #fff;
        font-size: 11px;
        line-height: 1.2;
        padding: 1px 5px;
        border-radius: 3px;
        white-space: nowrap;
        pointer-events: none;
        z-index: 10;
        opacity: 0;
        transition: opacity 0.15s ease;
      }

      /* show label on hover */
      .yRemoteSelectionHead-${clientID}:hover::after {
        opacity: 1;
      }
    `;
      });

      styleEl.textContent = css;
    };

    awareness.on("change", renderRemoteStyles);
    renderRemoteStyles();

    // Send local Yjs changes to the backend.
    const handleYjsUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return;
      if (ws.readyState !== WebSocket.OPEN) return;

      const message = encodePacket(
        MessageType.YJS_UPDATE,
        {
          userId: "my-user-id",
          roomId: ROOM_NAME,
          accessToken: "my-access-token",
        },
        update,
      );

      ws.send(message);
    };

    ydoc.on("update", handleYjsUpdate);

    // 3. Sync local Awareness state changes to the WebSocket
    const handleAwarenessUpdate = (
      {
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      },
      origin: unknown,
    ) => {
      // Don't send updates received from another client back to the server.
      if (origin === REMOTE_ORIGIN) return;

      if (ws.readyState !== WebSocket.OPEN) return;

      // Include every client whose awareness state changed.
      const changedClients = [...added, ...updated, ...removed];

      if (changedClients.length === 0) return;

      const update = awarenessProtocol.encodeAwarenessUpdate(
        awareness,
        changedClients,
      );

      ws.send(
        encodePacket(
          MessageType.AWARENESS_UPDATE,
          {
            userId: "my-user-id",
            roomId: ROOM_NAME,
            accessToken: "my-access-token",
          },
          update,
        ),
      );
    };

    awareness.on("update", handleAwarenessUpdate);
    ws.onopen = () => {
      const authMessage = encodePacket(
        MessageType.AUTH_REFRESH,
        {
          userId: "my-user-id",
          roomId: ROOM_NAME,
          accessToken: "my-access-token",
        },
        null,
      );

      ws.send(
        encodePacket(
          MessageType.AWARENESS_UPDATE,
          {
            userId: "my-user-id",
            roomId: ROOM_NAME,
            accessToken: "my-access-token",
          },
          awarenessProtocol.encodeAwarenessUpdate(awareness, [
            awareness.clientID,
          ]),
        ),
      );

      ws.send(authMessage);
      setStatus("Connected");
    };

    ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      try {
        const { messageType, metadata, yjsBuffer } = decodePacket(event.data);

        if (messageType === MessageType.INITIAL_DOC_STATE) {
          Y.applyUpdate(ydoc, yjsBuffer, REMOTE_ORIGIN);
          setSynced(true);
        }

        if (messageType === MessageType.YJS_UPDATE) {
          Y.applyUpdate(ydoc, yjsBuffer, REMOTE_ORIGIN);
        }
        if (messageType === MessageType.AWARENESS_UPDATE) {
          console.log("Applying awareness update from server:", yjsBuffer);

          awarenessProtocol.applyAwarenessUpdate(
            awareness,
            yjsBuffer,
            REMOTE_ORIGIN,
          );
        }
      } catch (error) {
        console.error("Failed to process server message:", error);
      }
    };

    ws.onclose = () => {
      setStatus("Disconnected");
      setSynced(false);
    };

    ws.onerror = () => {
      setStatus("Connection error");
    };

    cleanupRef.current = () => {
      awareness.off("change", renderRemoteStyles);
      awareness.off("update", handleAwarenessUpdate);
      ydoc.off("update", handleYjsUpdate);
      awareness.setLocalState(null); // tells others you left (sent before ws closes)
      binding.destroy();
      styleEl.remove();
      ws.close();
      awareness.destroy();
      ydoc.destroy();
    };
  }, []);

  useEffect(() => {
    return () => cleanupRef.current?.();
  }, []);

  return (
    <div className="app">
      <header className="toolbar">
        <strong>Collaborative Code Editor</strong>
        <span>
          WebSocket: {status} | Sync: {synced ? "Ready" : "Waiting"}
        </span>
      </header>

      <main className="editor-container">
        <Editor
          height="100%"
          width="100%"
          defaultLanguage="typescript"
          defaultValue="// Start coding here..."
          theme="vs-dark"
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            automaticLayout: true,
          }}
        />
      </main>
    </div>
  );
}
