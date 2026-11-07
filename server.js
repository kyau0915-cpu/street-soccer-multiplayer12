'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const configuredOrigins = String(process.env.CORS_ORIGIN || '*')
  .split(',').map(value => value.trim()).filter(Boolean);
const io = new Server(server, {
  cors: {
    origin: configuredOrigins.length === 1 ? configuredOrigins[0] : configuredOrigins,
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e6,
});

const PORT = Number(process.env.PORT) || 3000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // Four letters; avoids I and O confusion.
const CODE_LENGTH = 4;
const MAX_PLAYERS_PER_LOBBY = 20;
const activeLobbies = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, activeLobbies: activeLobbies.size }));

function createLobbyCode() {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      code += CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)];
    }
    if (!activeLobbies.has(code)) return code;
  }
  throw new Error('Could not allocate a unique lobby code. Try again.');
}

function publicLobby(lobby) {
  return {
    code: lobby.code,
    hostId: lobby.hostId,
    players: [...lobby.players.values()].map(({ id, name, joinedAt }) => ({ id, name, joinedAt })),
    createdAt: lobby.createdAt,
  };
}

function publicLobbyList() {
  return [...activeLobbies.values()].map(publicLobby);
}

function broadcastLobbyList() {
  io.emit('lobby-list', publicLobbyList());
}

function emitLobbyUpdate(lobby) {
  io.to(lobby.code).emit('lobby-updated', publicLobby(lobby));
}

function closeLobby(lobby, reason) {
  if (!lobby || !activeLobbies.has(lobby.code)) return;
  io.to(lobby.code).emit('lobby-closed', { code: lobby.code, reason });
  for (const playerId of lobby.players.keys()) {
    const member = io.sockets.sockets.get(playerId);
    if (member) {
      member.data.lobbyCode = null;
      member.leave(lobby.code);
    }
  }
  activeLobbies.delete(lobby.code);
  broadcastLobbyList();
}

function removePlayerFromLobby(socket) {
  const code = socket.data.lobbyCode;
  if (!code) return;
  const lobby = activeLobbies.get(code);
  socket.data.lobbyCode = null;
  if (!lobby) {
    socket.leave(code);
    return;
  }

  // The game simulation is host-authoritative. Closing the room when its host
  // leaves is safer than silently assigning a new host without the match state.
  if (lobby.hostId === socket.id) {
    closeLobby(lobby, 'The host left, so this lobby has closed.');
    return;
  }

  lobby.players.delete(socket.id);
  socket.leave(code);
  if (lobby.players.size === 0) {
    activeLobbies.delete(code);
    io.to(code).emit('lobby-closed', { code, reason: 'The lobby is empty.' });
  } else {
    emitLobbyUpdate(lobby);
  }
  broadcastLobbyList();
}

io.on('connection', (socket) => {
  socket.data.lobbyCode = null;
  socket.emit('lobby-list', publicLobbyList());

  socket.on('create-lobby', (payload = {}, acknowledge = () => {}) => {
    try {
      removePlayerFromLobby(socket);
      const code = createLobbyCode();
      const name = String(payload.name || 'Player').trim().slice(0, 20) || 'Player';
      const lobby = {
        code,
        hostId: socket.id,
        players: new Map([[socket.id, { id: socket.id, name, joinedAt: Date.now() }]]),
        createdAt: Date.now(),
      };
      activeLobbies.set(code, lobby);
      socket.join(code);
      socket.data.lobbyCode = code;
      acknowledge({ ok: true, lobby: publicLobby(lobby) });
      emitLobbyUpdate(lobby);
      broadcastLobbyList();
    } catch (error) {
      acknowledge({ ok: false, error: error.message });
    }
  });

  socket.on('join-lobby', (payload = {}, acknowledge = () => {}) => {
    const code = String(payload.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!new RegExp(`^[${CODE_CHARS}]{${CODE_LENGTH}}$`).test(code)) {
      return acknowledge({ ok: false, error: 'Enter a valid four-letter lobby code.' });
    }
    const lobby = activeLobbies.get(code);
    if (!lobby) return acknowledge({ ok: false, error: 'Lobby not found. Check the four-letter code.' });
    if (lobby.players.size >= MAX_PLAYERS_PER_LOBBY) {
      return acknowledge({ ok: false, error: 'This lobby is full.' });
    }
    if (socket.data.lobbyCode === code) {
      return acknowledge({ ok: true, lobby: publicLobby(lobby) });
    }

    removePlayerFromLobby(socket);
    const name = String(payload.name || 'Player').trim().slice(0, 20) || 'Player';
    lobby.players.set(socket.id, { id: socket.id, name, joinedAt: Date.now() });
    socket.join(code);
    socket.data.lobbyCode = code;
    acknowledge({ ok: true, lobby: publicLobby(lobby) });
    emitLobbyUpdate(lobby);
    broadcastLobbyList();
  });

  socket.on('leave-lobby', (acknowledge = () => {}) => {
    removePlayerFromLobby(socket);
    acknowledge({ ok: true });
    broadcastLobbyList();
  });

  // Host-authoritative relay: clients send inputs to the host; the host
  // broadcasts match snapshots and sound/game events to the other players.
  socket.on('game-event', (packet = {}) => {
    const code = socket.data.lobbyCode;
    const lobby = code && activeLobbies.get(code);
    if (!lobby || !packet || typeof packet.event !== 'string') return;
    const event = packet.event;
    if (!['hello', 'lob', 'go', 'in', 'st', 'ev'].includes(event)) return;
    const isHost = lobby.hostId === socket.id;

    if (['lob', 'go', 'st', 'ev'].includes(event) && !isHost) return;
    if (['hello', 'in'].includes(event) && isHost) return;

    if (event === 'in') {
      const now = Date.now();
      if (now - (socket.data.lastInputAt || 0) < 12) return;
      socket.data.lastInputAt = now;
    }

    const target = isHost ? socket.to(code) : io.to(lobby.hostId);
    target.emit('game-event', { event, data: packet.data, peer: socket.id });
  });

  socket.on('get-lobbies', (acknowledge = () => {}) => {
    acknowledge(publicLobbyList());
  });

  socket.on('disconnect', () => {
    removePlayerFromLobby(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Street Soccer multiplayer server listening on port ${PORT}`);
});
