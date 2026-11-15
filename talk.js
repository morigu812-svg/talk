"use strict";

const ui = Object.fromEntries(
  ["state", "room-title", "status", "invite", "link", "copy", "copy-status",
    "start", "controls", "mute", "leave", "remote", "play"]
    .map(id => [id, document.getElementById(id)])
);
const room = new URLSearchParams(location.hash.slice(1)).get("room");
const validRoom = room === null || /^talk-[0-9a-f-]{36}$/.test(room);
let session = null;

function show(state, title, status) {
  ui.state.textContent = state;
  ui["room-title"].textContent = title;
  ui.status.textContent = status;
  ui.state.closest(".console").dataset.live = String(state === "通話中");
}

function reset(message, error = false) {
  const previous = session;
  session = null;
  if (previous) {
    clearTimeout(previous.timer);
    previous.call?.close();
    previous.channel?.close();
    previous.peer?.destroy();
    previous.stream?.getTracks().forEach(track => track.stop());
  }
  ui.remote.srcObject = null;
  ui.play.hidden = ui.controls.hidden = ui.invite.hidden = true;
  ui["copy-status"].textContent = "";
  ui.mute.textContent = "マイクをミュート";
  ui.mute.setAttribute("aria-pressed", "false");
  ui.start.hidden = false;
  ui.start.disabled = !validRoom;
  ui.start.firstChild.textContent = room ? "通話に参加 " : "部屋を作る ";
  show(error ? "接続できません" : "待機中", room ? "招待された通話に参加" : "新しい通話をはじめる", message);
}

function tryPlayback() {
  const current = session;
  ui.remote.play().then(() => {
    if (session === current) ui.play.hidden = true;
  }).catch(() => {
    if (session === current) ui.play.hidden = false;
  });
}

function handleCall(current, call) {
  current.call = call;
  call.on("stream", stream => {
    if (session !== current) return;
    clearTimeout(current.timer);
    ui.remote.srcObject = stream;
    show("通話中", "通話がつながりました", "マイクの切り替えや退出は下のボタンからできます。");
    tryPlayback();
  });
  call.on("close", () => {
    if (session === current) reset("通話が終了しました。");
  });
  call.on("error", () => {
    if (session === current) reset("音声接続が切れました。もう一度お試しください。", true);
  });
}

function handleChannel(current, channel) {
  current.channel = channel;
  clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    if (session === current) reset("時間内に接続できませんでした。相手が部屋を開いているか確認してください。", true);
  }, 20000);
  channel.on("open", () => {
    if (session !== current) return;
    show("接続中", "相手と接続しています", "音声の接続を待っています。");
    if (room) {
      const call = current.peer.call(room, current.stream);
      if (call) handleCall(current, call);
      else reset("相手に接続できませんでした。もう一度お試しください。", true);
    }
  });
  channel.on("data", data => {
    if (session === current && data === "leave") reset("相手が退出しました。");
  });
  channel.on("close", () => {
    if (session === current) reset("相手との接続が終了しました。");
  });
  channel.on("error", () => {
    if (session === current) reset("接続できませんでした。もう一度お試しください。", true);
  });
}

async function start() {
  if (session || !validRoom) return;
  const current = {};
  session = current;
  ui.start.disabled = true;
  show("準備中", "マイクを準備しています", "ブラウザからのマイク使用の確認に応答してください。");
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      reset("HTTPS のページで開いてください。この環境ではマイクを利用できません。", true);
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true
    } });
    if (session !== current) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    current.stream = stream;
    ui.start.hidden = true;
    ui.controls.hidden = false;
    show("接続中", "通話ルームに接続しています", "接続が完了するまでお待ちください。");
    const id = room ? undefined : "talk-" + crypto.randomUUID();
    const config = { config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] } };
    const peer = id ? new Peer(id, config) : new Peer(config);
    current.peer = peer;
    current.timer = setTimeout(() => {
      if (session === current) reset("通話サービスに接続できませんでした。もう一度お試しください。", true);
    }, 12000);
    peer.on("open", peerId => {
      if (session !== current) return;
      clearTimeout(current.timer);
      if (room) {
        handleChannel(current, peer.connect(room, { serialization: "json" }));
        return;
      }
      const url = new URL(location.href);
      url.hash = new URLSearchParams({ room: peerId }).toString();
      ui.link.value = url.href;
      ui.invite.hidden = false;
      show("招待受付中", "相手の参加を待っています", "招待リンクを送り、このページを開いたままにしてください。");
    });
    peer.on("connection", channel => {
      if (session !== current || room || current.channel) {
        channel.on("open", () => channel.close());
        return;
      }
      handleChannel(current, channel);
    });
    peer.on("call", call => {
      if (session !== current || room || current.call || call.peer !== current.channel?.peer) {
        call.close();
        return;
      }
      handleCall(current, call);
      call.answer(current.stream);
    });
    peer.on("disconnected", () => {
      if (session === current && !ui.remote.srcObject) reset("通話サービスとの接続が切れました。", true);
    });
    peer.on("error", error => {
      if (session !== current) return;
      if (!room && ui.remote.srcObject && error.type === "peer-unavailable") return;
      reset(error.type === "peer-unavailable"
        ? "部屋が見つかりません。相手に新しい招待リンクを送ってもらってください。"
        : "通話に接続できませんでした。ネットワークを確認して、もう一度お試しください。", true);
    });
  } catch (error) {
    if (session !== current) return;
    const messages = {
      NotAllowedError: "ブラウザの設定でマイクを許可してから、もう一度お試しください。",
      NotFoundError: "マイクが見つかりません。接続を確認してください。",
      NotReadableError: "マイクを使用できません。ほかのアプリが使用していないか確認してください。"
    };
    reset(messages[error.name] ?? "通話を準備できませんでした。もう一度お試しください。", true);
  }
}

ui.start.addEventListener("click", start);
ui.copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(ui.link.value);
    if (!ui.invite.hidden) ui["copy-status"].textContent = "リンクをコピーしました";
  } catch {
    ui.link.select();
    ui["copy-status"].textContent = "選択したリンクを手動でコピーしてください";
  }
});
ui.mute.addEventListener("click", () => {
  const tracks = session?.stream?.getAudioTracks();
  if (!tracks?.length) return;
  const muted = tracks[0].enabled;
  tracks.forEach(track => { track.enabled = !muted; });
  ui.mute.setAttribute("aria-pressed", String(muted));
  ui.mute.textContent = muted ? "ミュートを解除" : "マイクをミュート";
});
ui.leave.addEventListener("click", () => {
  if (session?.channel?.open) session.channel.send("leave");
  reset("通話から退出しました。");
});
ui.play.addEventListener("click", tryPlayback);
window.addEventListener("pagehide", () => {
  if (session) reset("通話から退出しました。");
});
window.addEventListener("hashchange", () => location.reload());
reset(!validRoom ? "招待リンクが正しいか確認してください。"
  : room ? "マイクを許可して、相手との通話に参加できます。"
    : "部屋を作って、相手に招待リンクを送れます。", !validRoom);
