const baseUrl = "https://sudokupad.app/";
const streamtoolPrefix = "sudokucon/";

function parseCells(str) {
  return str.split(/(r[0-9]+c[0-9]+(?:-r[0-9]+c[0-9]+)?)/).filter((item, idx) => idx % 2 === 1);
}

function formatCells(cells) {
  return Array.from(cells).join("");
}

function isSelectionCmd(msg) {
  return msg.cmd === "act" && (msg.act?.startsWith("hl") || msg.act?.startsWith("sl") || msg.act?.startsWith("ds"));
}

class WSClient {
  constructor(channelId, userInfo, onMsg) {
    this.channelId = channelId;
    this.userInfo = userInfo;
    this.onMsg = onMsg;
    this.url = baseUrl + streamtoolPrefix + channelId
    this.selection = new Set();
    this.connect();
  }

  connect() {
    const ws = this.ws = new WebSocket(this.url);
    ws.addEventListener("open", event => {
      console.log(this.channelId, "WS open", event);
      this.send({
        cmd: "cloneview",
        hostkey: this.userInfo.key,
        hostname: this.userInfo.name + " proxy",
        hostcolor: this.userInfo.color,
      });
    });
    ws.addEventListener("message", event => {
      try {
        const msg = JSON.parse(event.data);
        this.updateSelection(msg);
        this.onMsg(msg);
        // console.log(this.channelId, "Got message", msg);
      } catch (e) {
        console.error(this.channelId, "Failed to parse message", e);
      }
    });
    ws.addEventListener("error", event => {
      console.error(this.channelId, "WS error", event);
    });
    ws.addEventListener("close", event => {
      console.log(this.channelId, "WS close", event);
    });
  }

  disconnect() {
    this.ws.close();
  }

  updateSelection(msg) {
    if (msg.cmd === "act") {
      if (msg.act?.startsWith("sl:") || msg.act?.startsWith("hl:")) {
        for (const cell of parseCells(msg.act.slice(3))) {
          this.selection.add(cell);
        }
      } else if (msg.act?.startsWith("ds:")) {
        for (const cell of parseCells(msg.act.slice(3))) {
          this.selection.delete(cell);
        }
      } else if (msg.act === "ds") {
        this.selection.clear();
      }
    }
  }

  getSelectionStr() {
    return formatCells(this.selection);
  }

  markSelection() {
    for (const cell of this.selection) {
      this.sendMarkCell(cell);
    }
  }

  send(msg) {
    // console.log(this.channelId, "Sending message", msg);
    this.updateSelection(msg)
    if (this.ws.readyState == WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.error(this.channelId, "Can't send message in readyState", this.ws.readyState);
    }
  }

  sendPointer(x, y, host=undefined) {
    this.send({cmd: "pointer", x, y, host});
  }

  sendClearPointer(host=undefined) {
    // Infinity doesn't work here, so we send the pointer to r-10000c-10000 and hope that's off-screen
    this.sendPointer(-64e4, -64e4, host);
  }

  sendAct(seq, act) {
    this.send({cmd: "act", seq, act});
  }

  sendSyncRequest() {
    this.sendAct(0, "sl:");
  }

  sendMarkCell(cell) {
    this.send({cmd: "markcell", cell});
  }

  sendCloseDialog() {
    this.send({cmd: "closedialog"});
  }
}

class Bridge {
  constructor(roomId, userInfo) {
    this.roomId = roomId;
    this.userInfo = userInfo;
    this.settings = {
      sendPointer: true,
      showPointers: true,
    };

    this.downstreamClient = new WSClient(roomId + "_" + userInfo.userId, userInfo, (msg) => {
      if (msg.cmd === "pointer" && !this.settings.sendPointer) return;
      if (msg.seq !== undefined) msg.seq++;
      
      if (msg.act === "ud" || msg.act === "rd") {
        // Undo histories might be different, so don't forward undo/redo upstream.
        // Instead ask to broadcast the entire board state
        this.downstreamClient.sendSyncRequest();
      } else if (isSelectionCmd(msg)) {
        // Replace selection commands with a no-op command
        // But we still want to propagate seq
        this.upstreamClient.sendAct(msg.seq, "sl:");
      } else if (msg.cmd === "act") {
        // Grouped so other clients can undo this atomically
        this.upstreamClient.sendAct(msg.seq, "gs");
        this.upstreamClient.sendAct(msg.seq, "ds");
        this.upstreamClient.sendAct(msg.seq, "sl:" + this.downstreamClient.getSelectionStr());
        this.upstreamClient.send(msg);
        this.upstreamClient.sendAct(msg.seq, "ds");
        this.upstreamClient.sendAct(msg.seq, "ge");
      } else {
        this.upstreamClient.send(msg);
      }
    });
    this.upstreamClient = new WSClient(roomId, userInfo, (msg) => {
      if (msg.cmd === "pointer" && !this.settings.showPointers) return;

      if (isSelectionCmd(msg)) {
        // Replace selection commands with a no-op command
        // But we still want to propagate seq
        this.downstreamClient.sendAct(msg.seq, "sl:");
      } else if (msg.cmd === "sync") {
        const savedSel = this.downstreamClient.getSelectionStr();
        this.downstreamClient.send(msg);
        this.downstreamClient.sendAct(msg.seq, "ds");
        this.downstreamClient.sendAct(msg.seq, "sl:" + savedSel);
      } else if (msg.cmd === "act") {
        // Not grouped, because we're already in a group, and groups can't be nested
        const savedSel = this.downstreamClient.getSelectionStr();
        this.downstreamClient.sendAct(msg.seq, "ds");
        this.downstreamClient.sendAct(msg.seq, "sl:" + this.upstreamClient.getSelectionStr());
        this.downstreamClient.send(msg);
        this.downstreamClient.sendAct(msg.seq, "ds");
        this.downstreamClient.sendAct(msg.seq, "sl:" + savedSel);
      } else {
        this.downstreamClient.send(msg);
      }
    });
  }

  disconnect() {
    // tell other players to remove our pointer
    this.upstreamClient.sendClearPointer({name: this.userInfo.name});
    this.upstreamClient.disconnect();
    this.downstreamClient.disconnect();
  }
}

const blankPuzzle = {
  "id": "",
  "regions": [
    [[0, 0], [0, 1], [1, 0], [1, 1]],
    [[0, 2], [0, 3], [1, 2], [1, 3]],
    [[2, 0], [2, 1], [3, 0], [3, 1]],
    [[2, 2], [2, 3], [3, 2], [3, 3]]
  ],
  "cells": [[{}, {}, {}, {}], [{}, {}, {}, {}], [{}, {}, {}, {}], [{}, {}, {}, {}]],
}

async function uploadPuzzle(puzzle, shortId, format="scl") {
  try {
    puzzle.id = shortId = streamtoolPrefix + shortId;
    const req = { puzzle: format + JSON.stringify(puzzle), shortid: shortId };
    const resp = await fetch(baseUrl + "admin/createlink", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(req)
    });
    if (!resp.ok) {
      console.error(`HTTP error while uploading puzzle ${resp.status}`);
      return false;
    }
    const text = await resp.text();
    if (text === "") {
      console.log(`Puzzle ${shortId} already exists, ignoring`)
      return true;
    }
    const data = JSON.parse(text);
    if (data.shortid !== shortId) {
      console.error(`Wrong shortid in response, got ${data.shortid}, expected ${shortId}`);
      return false;
    }
    console.log(`Created puzzle ${shortId}`)
    return true;
  } catch (e) {
    console.error(`Error uploading puzzle ${shortId}`, e);
    return false;
  }
}

function randomUserId() {
  return "" + Math.floor(Math.random() * 1e6);
}

async function connect(roomId, userInfo, settings) {
  await uploadPuzzle(blankPuzzle, roomId);
  await uploadPuzzle(blankPuzzle, roomId + "_" + userInfo.userId);
  if (window.bridge) window.bridge.disconnect();
  window.bridge = new Bridge(roomId, userInfo);
  const iframe = document.getElementById("sudokupad");
  const key = encodeURIComponent(userInfo.key);
  const name = encodeURIComponent(userInfo.name);
  const color = encodeURIComponent(userInfo.color);
  iframe.src = baseUrl + streamtoolPrefix + roomId + "_" + userInfo.userId +
    `?setting-nopauseonstart=1&setting-streamtool=1&hostkey=${key}&hostname=${name}&hostcolor=${color}`;
}

document.addEventListener("DOMContentLoaded", async (t) => {
  document.getElementById("sudokupad").addEventListener("load", (e) => {
    // ask other clients to send us the up-to-date state
    if (window.bridge) window.bridge.upstreamClient.sendSyncRequest();
  });
  try {
    const roomId = localStorage.getItem("roomId");
    const userInfo = JSON.parse(localStorage.getItem("userInfo"));
    console.log(roomId, userInfo);
    document.getElementById("roomId").value = roomId;
    document.getElementById("name").value = userInfo.name;
    document.getElementById("color").value = userInfo.color;
    await connect(roomId, userInfo);
  } catch (e) {
    console.error("Error loading from local storage");
  }
  document.getElementById("loginForm").addEventListener("formdata", async event => {
    const roomId = event.formData.get("roomId");
    const userInfo = {
      key: "1",
      name: event.formData.get("name"),
      color: event.formData.get("color"),
      userId: randomUserId(),
    }
    localStorage.setItem("roomId", roomId);
    localStorage.setItem("userInfo", JSON.stringify(userInfo));
    console.log(roomId, userInfo);
    await connect(roomId, userInfo);
  });
});

window.addEventListener("beforeunload", () => {
  if (window.bridge) window.bridge.disconnect();
});

// useful for debugging desyncs
function markSelections() {
  window.bridge.upstreamClient.markSelection();
  window.bridge.downstreamClient.markSelection();
}