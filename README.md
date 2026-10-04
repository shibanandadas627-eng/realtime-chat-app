# Signal Room — Real-Time Chat Application

Task-04 · ProDigy InfoTech Web Development Internship

A real-time chat app built with **WebSockets** (the `ws` library) and a
small Express server. Users create an account, sign in, join chat rooms or
start private (direct) conversations, and exchange messages instantly.

Unlike a static web page, this needs an actual server process running —
that's the whole point of WebSockets — so it ships as a small Node.js
project instead of a single HTML file.

## Requirements

- [Node.js](https://nodejs.org) version 16 or later (includes npm).
- An internet connection the **first** time you run `npm install`, to
  download the two dependencies (Express and ws). No internet is needed
  after that — everything else runs locally.

## How to run

```bash
cd realtime-chat-app
npm install
npm start
```

Then open **http://localhost:3000** in your browser. Open it in two
different browsers (or one normal + one incognito window) to chat between
two accounts and see real-time delivery, presence, and typing indicators
live.

To use a different port: `PORT=4000 npm start`.

## Core features (required by the brief)

- **WebSocket-based real-time messaging** — every message, presence
  update, and typing indicator is pushed over a persistent WebSocket
  connection (`/ws`), not polling.
- **Account creation & login** — `/api/register` and `/api/login` create
  and verify accounts. Passwords are never stored in plain text: they're
  hashed with Node's built-in `scrypt` (salted, with `crypto.timingSafeEqual`
  for the comparison) rather than compared directly.
- **Chat rooms** — two default rooms (`general`, `random`) plus the
  ability to create and join any new room by name from the sidebar.
- **Private conversations** — click any other registered user in the
  sidebar to open a one-to-one direct message thread.
- **Real-time text messaging** — messages appear instantly for every
  connected participant in a room, or for both people in a DM.

## Optional features included

- **Chat history** — every room and DM is persisted to `data/messages.json`
  on the server. Joining a room or opening a DM sends the last 100
  messages back to the client, so history survives reconnects and server
  restarts.
- **User presence indicators** — the sidebar shows a green dot next to
  users who currently have the app open (tracked as WebSocket connections),
  updated live for everyone as people connect/disconnect.
- **Notifications** — the browser's Notification API fires a desktop
  notification for new messages that arrive in a room or DM you don't
  currently have open, plus an unread-count badge in the sidebar. A typing
  indicator also shows above the message box while the other person types.
- **Multimedia file sharing** — the 📎 button lets you attach an image,
  PDF, or text file (up to 4MB). Files are uploaded over HTTP to
  `/api/upload`, saved under `/uploads`, and shared into the conversation
  as a message; images render as inline previews, other files as a
  download link.

## Validation & security notes

- Username: 3–20 characters, letters/numbers/underscore only; must be
  unique.
- Password: minimum 6 characters.
- File uploads are restricted by MIME type (images, PDF, plain text) and a
  4MB size cap, and given a randomized, sanitized filename on disk.
- Session tokens are random 48-character strings issued on login/register
  and checked on every WebSocket auth and file upload — but they're kept
  in server memory, so **all sessions reset when the server restarts**.
  For production use, swap this for signed JWTs or a session store (e.g.
  Redis) and add HTTPS/WSS, rate limiting, and a real database in place of
  the JSON files.

## Project structure

```
realtime-chat-app/
├── server.js          # Express + WebSocket server, auth, persistence
├── package.json
├── data/              # users.json and messages.json (created at runtime)
├── uploads/           # shared files (created at runtime)
└── public/
    ├── index.html     # app shell (auth screen + chat screen)
    ├── style.css
    └── client.js      # WebSocket client, rendering, notifications
```

## WebSocket message protocol (for reference)

Client → Server: `auth`, `join`, `open_dm`, `message`, `file_message`, `typing`
Server → Client: `authed`, `presence`, `history`, `message`, `typing`, `error`

Each message is a small JSON object, e.g. sending a chat message:

```json
{ "type": "message", "room": "general", "text": "hey everyone" }
```
