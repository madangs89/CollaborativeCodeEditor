import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import * as Y from "yjs";
import { MonacoBinding } from "y-monaco";
import "./index.css";

const WS_URL = "ws://localhost:1234";
const ROOM_NAME = "my-code-room";

const REMOTE_ORIGIN = Symbol("remote");

enum MessageType {
  AUTH_REFRESH = 0,
  INITIAL_DOC_STATE = 1,
  YJS_UPDATE = 2,
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

    const ws = new WebSocket(`${WS_URL}/${encodeURIComponent(ROOM_NAME)}`);

    ws.binaryType = "arraybuffer";

    const model = editor.getModel();

    if (!model) {
      ws.close();
      ydoc.destroy();
      return;
    }

    // Connect the Yjs text to the Monaco editor.
    const binding = new MonacoBinding(ytext, model, new Set([editor]));

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
      ydoc.off("update", handleYjsUpdate);
      binding.destroy();
      ws.close();
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
