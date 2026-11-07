# Street Soccer 3D — Multiplayer Server

This package contains the game in `public/index.html` and a Node.js/Express/Socket.IO server. The server creates four-letter lobby codes and relays player input to the host, while the host sends authoritative match snapshots to the other players.

## Run locally

1. Install Node.js 18 or newer.
2. Extract this folder.
3. Open a terminal in the `street-soccer-server` folder.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://localhost:3000` in two browser windows or on two devices on the same network.
7. In the first window, choose **Create lobby** and select a match format. In the second, choose **Join lobby**, enter the four-letter code, and choose a side.

The server prints its listening port. `/health` returns JSON with the current number of active lobbies.

## Host it online

Deploy this folder as a persistent Node.js web service on a host that supports WebSockets. Set the service's start command to `npm start`; the host will normally provide `PORT` automatically. Keep the service running for the whole match.

- If the game is served by this server, use the deployed app URL. The Socket.IO client script is served automatically at `/socket.io/socket.io.js`.
- If the HTML is hosted on another site, set `window.STREET_SOCCER_SERVER_URL` to the full server origin **before the game's main script runs**, for example:

  ```html
  <script>window.STREET_SOCCER_SERVER_URL = 'https://your-server.example.com';</script>
  ```

  Configure `CORS_ORIGIN` on the server to the website origin (or a comma-separated list of allowed origins). Do not use `file://` to open the game for online play.
- For Google Sites, the simplest setup is to deploy this server and embed its deployed game URL in a Google Sites Embed block. Google Sites itself cannot run the Node.js/Socket.IO backend.

## Controls

The existing game controls are preserved. In local split-screen, Player 2 uses **I** forward, **J** left, **K** backward, **L** right; **O** sprints, **P** shoots, **U** passes, **H** slides/jumps, and **N** uses Croqueta. Player 2's movement is camera-relative, so I remains forward even when playing toward the opposite goal.

## Multiplayer behavior and limits

- Four uppercase letters per lobby code (ambiguous I and O are excluded).
- Lobby creation, joining, leaving, disconnect cleanup, and active-lobby listing.
- Up to 20 connected players in one lobby (the 10v10 game's maximum).
- Clients send input to the host; the host simulates the match and broadcasts snapshots/effects.
- If the host leaves or disconnects, the room closes. Live host migration is not implemented because the host owns the authoritative match simulation.
- This is real-time browser multiplayer, not a peer-to-peer connection. All players must be able to reach the deployed server over HTTPS/WSS.

## Tests

Run `npm test` after `npm install`. The smoke test starts a local server and checks code creation, joining, host-to-client state relay, client-to-host input relay, rejection of client-authoritative state, leaving, host departure, and lobby cleanup.
