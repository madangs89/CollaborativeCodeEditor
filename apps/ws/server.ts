import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";
import * as Y from "yjs";

import * as awarenessProtocol from "y-protocols/awareness";

dotenv.config();
const app = express();

app.use(express.json());

app.use(cors());

const server = createServer(app);
const wss = new WebSocketServer({ server });

type Room = {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  clients: Set<WebSocket>;
};

const rooms = new Map<string, Room>();

const encoder = new TextEncoder();
const decoder = new TextDecoder();

enum MessageType {
  AUTH_REFRESH = 0,
  INITIAL_DOC_STATE = 1,
  YJS_UPDATE = 2,
  AWARENESS_UPDATE = 3,
}

// Message types:
// 0 = auth and refresh token
// 1 = initial document state
// 2 = Yjs update

const getRoom = (roomName: string) => {
  let room = rooms.get(roomName);
  if (!room) {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null); // server isn't a participant
    room = { doc, awareness, clients: new Set() };
    rooms.set(roomName, room);
  }
  return room;
};

const encodePacket = (
  typeId: number,
  metaObject: Record<string, unknown>,
  yjsBuffer?: Uint8Array | Buffer | null,
): Buffer => {
  // 1. Encode metadata as UTF-8 JSON
  const jsonBytes = encoder.encode(JSON.stringify(metaObject));

  // 2. Calculate total packet size
  const yjsLength = yjsBuffer?.byteLength ?? 0;
  const totalLength = 1 + 4 + jsonBytes.byteLength + yjsLength;

  // 3. Allocate the packet
  const packetBuffer = Buffer.allocUnsafe(totalLength);

  // 4. Write message type (1 byte)
  packetBuffer.writeUInt8(typeId, 0);

  // 5. Write JSON length (4 bytes, big-endian)
  packetBuffer.writeUInt32BE(jsonBytes.byteLength, 1);

  // 6. Write JSON metadata
  Buffer.from(jsonBytes).copy(packetBuffer, 5);

  // 7. Append Yjs payload, if present
  if (yjsBuffer && yjsLength > 0) {
    Buffer.from(yjsBuffer).copy(packetBuffer, 5 + jsonBytes.byteLength);
  }

  return packetBuffer;
};
const decodePacket = (
  buffer: Buffer,
): {
  messageType: number;
  metadata: any;
  yjsBuffer: Buffer;
} => {
  // 1. Validate the minimum packet size
  if (buffer.byteLength < 5) {
    throw new Error("Packet is too short");
  }

  // 2. Read message type (1 byte)
  const messageType = buffer.readUInt8(0);

  // 3. Read JSON length (4 bytes, big-endian)
  const jsonLength = buffer.readUInt32BE(1);

  // 4. Calculate JSON boundaries
  const jsonStart = 5;
  const jsonEnd = jsonStart + jsonLength;

  console.log("Packet length:", buffer.byteLength);
  console.log("Message type:", messageType);
  console.log("Declared JSON length:", jsonLength);
  console.log("First 10 bytes:", buffer.subarray(0, 10));
  if (jsonEnd > buffer.byteLength) {
    throw new Error(
      `Invalid JSON length: declared=${jsonLength}, ` +
        `packet=${buffer.byteLength}, type=${messageType}`,
    );
  }

  // 5. Decode and parse JSON metadata
  const jsonBytes = buffer.subarray(jsonStart, jsonEnd);
  const metadata = JSON.parse(decoder.decode(jsonBytes));

  // 6. Extract remaining bytes as the Yjs payload
  const yjsBuffer = buffer.subarray(jsonEnd);

  return {
    messageType,
    metadata,
    yjsBuffer,
  };
};

wss.on("connection", (ws: WebSocket, req: any) => {
  console.log("New WebSocket connection established.");

  ws.on("message", async (message: Buffer) => {
    const { messageType, metadata, yjsBuffer } = decodePacket(message);

    console.log("Received message:", { messageType, metadata, yjsBuffer });

    const { userId, roomId, accessToken } = metadata;
    if (messageType === MessageType.AUTH_REFRESH) {
      const room = getRoom(roomId);
      room.clients.add(ws);

      // doc state -> the new client
      ws.send(
        encodePacket(
          MessageType.INITIAL_DOC_STATE,
          {},
          Y.encodeStateAsUpdate(room.doc),
        ),
      );

      // awareness state -> the new client
      const states = Array.from(room.awareness.getStates().keys());
      console.log("Sending awareness states to new client:", states);
      if (states.length > 0) {
        ws.send(
          encodePacket(
            MessageType.AWARENESS_UPDATE,
            {},
            awarenessProtocol.encodeAwarenessUpdate(room.awareness, states),
          ),
        );
      }
    }

    if (messageType === MessageType.YJS_UPDATE) {
      const room = getRoom(roomId);
      Y.applyUpdate(room.doc, yjsBuffer, ws);

      for (const client of room.clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          const updateMessage = encodePacket(
            MessageType.YJS_UPDATE,
            {},
            yjsBuffer,
          );
          client.send(updateMessage);
        }
      }
    }

    if (messageType === MessageType.AWARENESS_UPDATE) {
      const room = getRoom(roomId);

      awarenessProtocol.applyAwarenessUpdate(room.awareness, yjsBuffer, ws);
      console.log("Applying awareness update for room:", roomId);

      for (const client of room.clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          const awarenessMessage = encodePacket(
            MessageType.AWARENESS_UPDATE,
            {},
            yjsBuffer,
          );
          client.send(awarenessMessage);
        }
      }
    }
  });

  ws.on("error", console.error);
});

console.log("WebSocket server is running on ws://localhost:1234");
server.listen(1234, () => {
  console.log("Server is running on http://localhost:1234");
});
