// apps/ws/index.ts
import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";

const PORT = 1234;

type Room = {
  doc: Y.Doc;
  clients: Set<WebSocket>;
};

const rooms = new Map<string, Room>();

// Message types:
// 0 = Yjs update
// 1 = initial document state

function getRoom(roomName: string): Room {
  let room = rooms.get(roomName);

  if (!room) {
    const doc = new Y.Doc();
    const clients = new Set<WebSocket>();

    room = { doc, clients };
    rooms.set(roomName, room);

    // Broadcast each accepted document update to other clients.
    doc.on("update", (update, origin) => {
      const message = Buffer.concat([
        Buffer.from([0]),
        Buffer.from(update),
      ]);

      for (const client of clients) {
        if (
          client !== origin &&
          client.readyState === WebSocket.OPEN
        ) {
          client.send(message);
        }
      }
    });
  }

  return room;
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const roomName = decodeURIComponent(url.pathname.slice(1));

  if (!roomName || roomName.length > 200) {
    ws.close(1008, "Invalid room name");
    return;
  }

  const room = getRoom(roomName);
  room.clients.add(ws);

  console.log(`Client connected to room: ${roomName}`);

  // Send current room state to the newly connected client.
  const initialState = Buffer.concat([
    Buffer.from([1]),
    Buffer.from(Y.encodeStateAsUpdate(room.doc)),
  ]);

  ws.send(initialState);

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      console.warn("Ignoring unexpected text message");
      return;
    }

    const message = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);

    if (message.length < 2) return;

    const messageType = message[0];
    const update = new Uint8Array(
      message.buffer,
      message.byteOffset + 1,
      message.byteLength - 1,
    );

    try {
      if (messageType === 0) {
        // Apply the incoming update to the server's Y.Doc.
        // The origin lets the broadcast handler exclude this sender.
        Y.applyUpdate(room.doc, update, ws);
      } else {
        console.warn("Unknown message type:", messageType);
      }
    } catch (error) {
      console.error("Invalid Yjs update:", error);
    }
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    console.log(`Client disconnected from room: ${roomName}`);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

console.log(`Custom Yjs WebSocket server running on ws://localhost:${PORT}`);