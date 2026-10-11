const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = 8787;
const ROOT = __dirname;
const DATA = path.join(ROOT, "data", "store.json");
const STANCES = ["ok", "hard", "cond"];

let store = loadStore();
let chain = Promise.resolve();

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DATA, "utf8"));
  } catch (e) {
    return { tokens: {}, classes: {} };
  }
}

function saveStore() {
  fs.mkdirSync(path.dirname(DATA), { recursive: true });
  const tmp = DATA + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, DATA);
}

function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

function emptyTheme() {
  return {
    draftStance: "",
    draftReason: "",
    finalStance: "",
    finalReason: "",
    waves: [
      { state: "idle", partnerId: "", partnerName: "" },
      { state: "idle", partnerId: "", partnerName: "" }
    ]
  };
}

function emptyStudent(name) {
  return {
    name,
    before: "",
    after: "",
    reflect: "",
    talkedWith: [],
    themes: [emptyTheme(), emptyTheme(), emptyTheme(), emptyTheme(), emptyTheme()]
  };
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function normNumber(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,2}$/.test(text)) return "";
  const number = String(Number(text));
  return number === "0" ? "" : number;
}

function normClass(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-6]$/.test(text)) return "";
  return text;
}

function clip(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function classOf(classNo) {
  if (!store.classes[classNo]) store.classes[classNo] = { students: {} };
  return store.classes[classNo];
}

function locate(token) {
  const loc = store.tokens[token];
  if (!loc) fail(401, "もう一度入り直してください");
  const student = classOf(loc.classNo).students[loc.number];
  if (!student) fail(401, "もう一度入り直してください");
  return { loc, student, cls: classOf(loc.classNo) };
}

function canPair(cls, a, b) {
  if (a === b) return false;
  const left = cls.students[a].talkedWith.some((person) => person.id === b);
  const right = cls.students[b].talkedWith.some((person) => person.id === a);
  return !left && !right;
}

function linkStudents(cls, themeIndex, waveIndex, a, b) {
  const left = cls.students[a];
  const right = cls.students[b];
  const leftWave = left.themes[themeIndex].waves[waveIndex];
  const rightWave = right.themes[themeIndex].waves[waveIndex];
  leftWave.state = "paired";
  leftWave.partnerId = b;
  leftWave.partnerName = right.name;
  rightWave.state = "paired";
  rightWave.partnerId = a;
  rightWave.partnerName = left.name;
  left.talkedWith.push({ id: b, name: right.name });
  right.talkedWith.push({ id: a, name: left.name });
}

function matchWave(cls, themeIndex, waveIndex) {
  const submitted = Object.entries(cls.students).filter(([, student]) => {
    const theme = student.themes[themeIndex];
    return theme.draftStance && theme.draftReason;
  });
  const waveOf = (student) => student.themes[themeIndex].waves[waveIndex];
  const locked = new Set();
  for (const [id, student] of submitted) {
    const state = waveOf(student).state;
    if (state === "paired" || state === "done" || state === "none") locked.add(id);
  }
  const waiting = submitted
    .map(([id]) => id)
    .filter((id) => waveOf(cls.students[id]).state === "waiting" && !locked.has(id))
    .sort((a, b) => Number(a) - Number(b));

  for (let i = 0; i < waiting.length; i += 1) {
    const a = waiting[i];
    if (locked.has(a)) continue;
    for (let j = i + 1; j < waiting.length; j += 1) {
      const b = waiting[j];
      if (locked.has(b)) continue;
      if (!canPair(cls, a, b)) continue;
      linkStudents(cls, themeIndex, waveIndex, a, b);
      locked.add(a);
      locked.add(b);
      break;
    }
  }

  const stillWriting = submitted.some(([, student]) => waveOf(student).state === "idle");
  if (stillWriting) return;

  const leftovers = submitted
    .map(([id]) => id)
    .filter((id) => waveOf(cls.students[id]).state === "waiting")
    .sort((a, b) => Number(a) - Number(b));
  if (!leftovers.length) return;

  const stranded = leftovers.length === 1
    ? leftovers
    : leftovers.filter((id) => !leftovers.some((other) => other !== id && canPair(cls, id, other)));
  if (leftovers.length > 1 && !stranded.length) return;

  const teacherTaken = submitted.some(([, student]) => waveOf(student).partnerId === "teacher");
  let teacherGiven = teacherTaken;
  for (const id of stranded) {
    const student = cls.students[id];
    const wave = waveOf(student);
    const hadTeacher = student.talkedWith.some((person) => person.id === "teacher");
    if (!teacherGiven && !hadTeacher) {
      wave.state = "paired";
      wave.partnerId = "teacher";
      wave.partnerName = "先生";
      student.talkedWith.push({ id: "teacher", name: "先生" });
      teacherGiven = true;
    } else {
      wave.state = "none";
      wave.partnerId = "";
      wave.partnerName = "";
    }
  }
}

function decorateWave(cls, themeIndex, wave) {
  const view = {
    state: wave.state,
    partnerName: wave.partnerName,
    teacher: wave.partnerId === "teacher"
  };
  if ((wave.state === "paired" || wave.state === "done") && wave.partnerId && wave.partnerId !== "teacher") {
    const partner = cls.students[wave.partnerId];
    if (partner) {
      view.partnerStance = partner.themes[themeIndex].draftStance;
      view.partnerReason = partner.themes[themeIndex].draftReason;
    }
  }
  return view;
}

function viewStudent(loc, student, cls) {
  return {
    classNo: loc.classNo,
    number: loc.number,
    name: student.name,
    before: student.before,
    after: student.after,
    reflect: student.reflect,
    talked: student.talkedWith,
    themes: student.themes.map((theme, themeIndex) => ({
      draftStance: theme.draftStance,
      draftReason: theme.draftReason,
      finalStance: theme.finalStance,
      finalReason: theme.finalReason,
      waves: theme.waves.map((wave) => decorateWave(cls, themeIndex, wave))
    }))
  };
}

function requireThemeIndex(value) {
  const theme = Number(value);
  if (!Number.isInteger(theme) || theme < 0 || theme > 4) fail(400, "見方が正しくありません");
  return theme;
}

function requireWaveIndex(value) {
  const wave = Number(value);
  if (wave !== 0 && wave !== 1) fail(400, "話し合いの回が正しくありません");
  return wave;
}

function assertReady(student, themeIndex) {
  if (!student.before) fail(400, "学習前を書いてから進みます");
  for (let i = 0; i < themeIndex; i += 1) {
    if (!student.themes[i].finalStance) fail(400, "前の見方の判断を残してから進みます");
  }
}

function handleEnter(body) {
  const classNo = normClass(body.classNo);
  const number = normNumber(body.number);
  const name = clip(body.name, 40);
  if (!classNo || !number || !name) fail(400, "組、出席番号、氏名を入れてください");
  const cls = classOf(classNo);
  const existing = cls.students[number];
  if (existing && existing.name !== name) fail(409, "この出席番号は、別の氏名で使われています");
  if (!existing) cls.students[number] = emptyStudent(name);
  let token = Object.keys(store.tokens).find((key) => {
    const loc = store.tokens[key];
    return loc.classNo === classNo && loc.number === number;
  });
  if (!token) {
    token = crypto.randomBytes(24).toString("hex");
    store.tokens[token] = { classNo, number };
  }
  saveStore();
  return { token, me: viewStudent(store.tokens[token], cls.students[number], cls) };
}

function handleBefore(student, body) {
  const text = clip(body.text, 2000);
  if (!text) fail(400, "学習前の答えを書いてください");
  student.before = text;
}

function handleJudge(student, body) {
  const themeIndex = requireThemeIndex(body.theme);
  assertReady(student, themeIndex);
  const theme = student.themes[themeIndex];
  if (theme.draftStance) fail(400, "この回の判断は、すでに書いてあります");
  if (!STANCES.includes(body.stance)) fail(400, "立場を一つ選んでください");
  const reason = clip(body.reason, 2000);
  if (!reason) fail(400, "理由を書いてください");
  theme.draftStance = body.stance;
  theme.draftReason = reason;
}

function handleWave(cls, student, body) {
  const themeIndex = requireThemeIndex(body.theme);
  const waveIndex = requireWaveIndex(body.wave);
  assertReady(student, themeIndex);
  const theme = student.themes[themeIndex];
  if (!theme.draftStance) fail(400, "先に判断を書いてください");
  if (waveIndex === 1 && theme.waves[0].state !== "done") fail(400, "1人目が終わってから、2人目に進みます");
  const wave = theme.waves[waveIndex];
  if (wave.state === "idle") wave.state = "waiting";
  matchWave(cls, themeIndex, waveIndex);
}

function handleFinish(student, body) {
  const themeIndex = requireThemeIndex(body.theme);
  const waveIndex = requireWaveIndex(body.wave);
  const wave = student.themes[themeIndex].waves[waveIndex];
  if (wave.state !== "paired" && wave.state !== "none") fail(400, "まだ相手が決まっていません");
  wave.state = "done";
}

function handleCommit(student, body) {
  const themeIndex = requireThemeIndex(body.theme);
  const theme = student.themes[themeIndex];
  if (theme.waves.some((wave) => wave.state !== "done")) fail(400, "2人との話し合いが終わってから残します");
  if (!STANCES.includes(body.stance)) fail(400, "立場を一つ選んでください");
  const reason = clip(body.reason, 2000);
  if (!reason) fail(400, "理由を書いてください");
  theme.finalStance = body.stance;
  theme.finalReason = reason;
}

function handleAfter(student, body) {
  if (student.themes.some((theme) => !theme.finalStance)) fail(400, "5つの判断が残ってから書きます");
  const text = clip(body.text, 2000);
  if (!text) fail(400, "学習後の答えを書いてください");
  student.after = text;
}

function handleReflect(student, body) {
  if (!student.after) fail(400, "学習後を書いてから比べます");
  const text = clip(body.text, 2000);
  if (!text) fail(400, "思ったこと、感じたことを書いてください");
  student.reflect = text;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 100000) {
        reject(Object.assign(new Error("送信が大きすぎます"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(Object.assign(new Error("送信内容を読めませんでした"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8"
  };
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("見つかりません");
      return;
    }
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (!url.pathname.startsWith("/api/")) {
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.resolve(ROOT, `.${rel}`);
    if (!filePath.startsWith(path.resolve(ROOT))) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    sendFile(res, filePath);
    return;
  }

  enqueue(async () => {
    try {
      const body = req.method === "POST" ? await readBody(req) : {};
      const token = req.headers["x-token"];
      if (url.pathname === "/api/enter" && req.method === "POST") {
        sendJson(res, 200, handleEnter(body));
        return;
      }
      const { loc, student, cls } = locate(token);
      if (url.pathname === "/api/state" && req.method === "GET") {
        sendJson(res, 200, { me: viewStudent(loc, student, cls) });
        return;
      }
      if (req.method !== "POST") fail(404, "見つかりません");
      if (url.pathname === "/api/before") handleBefore(student, body);
      else if (url.pathname === "/api/judge") handleJudge(student, body);
      else if (url.pathname === "/api/wave") handleWave(cls, student, body);
      else if (url.pathname === "/api/wave/finish") handleFinish(student, body);
      else if (url.pathname === "/api/commit") handleCommit(student, body);
      else if (url.pathname === "/api/after") handleAfter(student, body);
      else if (url.pathname === "/api/reflect") handleReflect(student, body);
      else fail(404, "見つかりません");
      saveStore();
      sendJson(res, 200, { me: viewStudent(loc, student, cls) });
    } catch (error) {
      sendJson(res, error.status || 500, { error: error.message || "保存に失敗しました" });
    }
  }).catch((error) => {
    sendJson(res, 500, { error: error.message || "保存に失敗しました" });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const locals = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === "IPv4" && !item.internal) locals.push(`http://${item.address}:${PORT}/`);
    }
  }
  console.log(`このパソコン: http://127.0.0.1:${PORT}/`);
  locals.forEach((item) => console.log(`同じネットワーク: ${item}`));
});
